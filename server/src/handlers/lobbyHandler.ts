import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import type { ClientSession, GameRoom, WorldState } from "../state/worldState.ts";
import {
  formatClientOpcode,
  formatServerOpcode,
  formatStageId,
  formatU8Hex,
  logger,
} from "../utils/logger.ts";
import {
  buildCoupleInfoSyncPacket250,
  buildDynamicMapConfigPacket207,
} from "./commonHandler.ts";
import {
  buildSetPlayerPacket,
  computeSlotStateFlags,
  writeCUserBlock,
  writeSlotAccessoryBlock,
} from "./roomHandler.ts";
import {
  buildEquippedAvatarPacket196,
  buildInventoryExpansionPacket268,
  buildInventoryPacket,
  buildUserItemRecordsPacket,
} from "./shopHandler.ts";
import {
  buildUserItemCatalog,
  parseFxStockCatalog,
} from "../resources/userItemCatalog.ts";

function clonePacketReader(reader: PacketReader): PacketReader {
  const clone = new PacketReader(reader.plain, reader.degree);
  clone.offset = reader.offset;
  return clone;
}

function parseExactPayload<T>(
  reader: PacketReader,
  parse: (probe: PacketReader) => T | null
): T | null {
  const probe = clonePacketReader(reader);
  const value = parse(probe);
  if (value === null || probe.remaining !== 0) return null;
  reader.offset = probe.offset;
  return value;
}

function readCompleteString(reader: PacketReader): string | null {
  if (reader.remaining < 2) return null;
  const length = reader.peekU16();
  if (length > 0x7fff || length > reader.remaining - 2) return null;
  return reader.readString();
}

interface ParsedCreateRoom {
  roomName: string;
  password: string;
  prefixU8: number;
  charIds: number[];
  tailU8?: number;
  tailU32: number;
  tailLayout: "u32" | "u8+u32";
}

function parseCreateRoomPayload(reader: PacketReader, hasPasswordField: boolean): ParsedCreateRoom | null {
  return parseExactPayload(reader, (probe) => {
    const roomName = readCompleteString(probe);
    if (roomName === null) return null;
    const password = hasPasswordField ? readCompleteString(probe) : "";
    if (password === null || probe.remaining < 2) return null;

    const prefixU8 = probe.readU8();
    const localCount = probe.readU8();
    if (localCount < 1 || localCount > 2 || probe.remaining < localCount) return null;

    const charIds: number[] = [];
    for (let index = 0; index < localCount; index++) charIds.push(probe.readU8());
    if (hasPasswordField && probe.remaining === 4) {
      // One recovered C->S 75 Lobby-strategy writer ends in a single opaque u32.
      return { roomName, password, prefixU8, charIds, tailU32: probe.readU32(), tailLayout: "u32" };
    }
    if (probe.remaining !== 5) return null;
    const tailU8 = probe.readU8();
    const tailU32 = probe.readU32();
    return { roomName, password, prefixU8, charIds, tailU8, tailU32, tailLayout: "u8+u32" };
  });
}

interface ParsedJoinRoom {
  roomNumber: number;
  password: string;
  credentialForm: "password-string" | "regional-password-string" | "invite-marker";
  charIds: number[];
}

function parseJoinRoomPayload(reader: PacketReader): ParsedJoinRoom | null {
  const parseForm = (form: ParsedJoinRoom["credentialForm"]): ParsedJoinRoom | null =>
    parseExactPayload(reader, (probe) => {
      if (probe.remaining < 7) return null;
      const roomNumber = probe.readU16();
      probe.readU32(); // Opaque room-context field; retained structurally but not used as identity.
      let password = "";
      if (form === "regional-password-string") {
        if (probe.remaining < 1 || probe.readU8() !== 1) return null;
      }
      if (form === "password-string" || form === "regional-password-string") {
        const parsedPassword = readCompleteString(probe);
        if (parsedPassword === null) return null;
        password = parsedPassword;
      } else if (probe.remaining < 1 || probe.readU8() !== 0) {
        return null;
      }

      if (probe.remaining < 1) return null;
      const localCount = probe.readU8();
      if (localCount < 1 || localCount > 2 || probe.remaining !== localCount) return null;
      const charIds: number[] = [];
      for (let index = 0; index < localCount; index++) charIds.push(probe.readU8());
      return { roomNumber, password, credentialForm: form, charIds };
    });

  // The common writer always writes a length-prefixed password string. This Client also has
  // a region-128 prefix form and a separate invite-accept writer with a one-byte zero marker.
  return parseForm("password-string") ??
    parseForm("regional-password-string") ??
    parseForm("invite-marker");
}

function hasSelectedChannel(session: ClientSession, state: WorldState): boolean {
  return session.connectionKind === "game" &&
    session.channelSelected &&
    Number.isInteger(session.channelIndex) &&
    session.channelIndex >= 0 &&
    session.channelIndex < state.channels.length;
}

function hasLobbyRoomActionContext(state: WorldState, session: ClientSession): boolean {
  return hasSelectedChannel(session, state) &&
    session.stageId === StageId.Lobby &&
    session.users.length >= 1 &&
    session.users.length <= 2 &&
    session.currentRoomNumber === null;
}

function sessionOwnsRoomSlot(session: ClientSession, room: GameRoom): boolean {
  return room.slots.some((slot) => slot.occupied && slot.session === session);
}

function logRejectedLobbyPacket(
  session: ClientSession,
  opcode: number,
  payloadBytes: number,
  expectedSchema: string,
  reason: string
): void {
  logger.warn("Lobby", reason, {
    direction: "C->S",
    wireOpcode: opcode,
    opcodeName: formatClientOpcode(opcode),
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    payloadBytes,
    expectedSchema,
    responseSent: false,
    roomStateChanged: false,
  });
}

/**
 * Builds S->C 79 (`CLobbyStage::sub_4C86A2` case `'O'` -> `sub_4C3F09` -> `CNormalLobbyStrategy::sub_4CCE53` at `0x004CCE53`)
 * Create Room Result:
 *   u8 errCode (0 = success, 1 = SameRoomExist)
 *   if errCode == 0:
 *     u16 roomNumber (`sub_697510`)
 *     u32 room-context word (`sub_697580`; this local builder writes `room.chiefSlotNetId`)
 *     u8 gameMode (`sub_6974B0`)
 *     u8 mapOption (`sub_6974B0`)
 *     u8 extraMode (`sub_6974B0`)
 */
export function buildCreateRoomResultPacket(room: GameRoom): PacketWriter {
  const w79 = new PacketWriter(ServerOpcode.CreateRoomResult);
  w79.writeU8(0); // errCode = 0 (success)
  w79.writeU16(room.roomNumber);
  w79.writeU32(room.chiefSlotNetId);
  w79.writeU8(room.gameMode);
  w79.writeU8(room.mapTheme);
  w79.writeU8(room.gameSubMode);
  return w79;
}

/**
 * Builds S->C 80 (`CLobbyStage::sub_4C86A2` case `'P'` -> `sub_4C77C2` -> `sub_4C455D` at `0x004C455D`)
 * Join Room Result:
 *   u8 errCode (0 = success, 1 = WrongPassword, 2 = CantJoinRoom, 3 = InvalidGrade)
 *   if errCode == 0:
 *     u8 extraMode (`sub_6974B0`)
 *     str roomTitle (`sub_698290`)
 *     u16 roomNumber (`sub_697510`)
 *     u16 mapIndex (`sub_697510`)
 *     u8 gameMode (`sub_6974B0`)
 *     u8 mapTheme (`sub_6974B0`)
 *     u32 room-context word (`sub_697580`; this local builder writes `room.chiefSlotNetId`)
 *     For slotIdx = 0 .. 7:
 *       if !slot.occupied:
 *         u8 isEmpty = 1
 *         block(3) [stateFlags, charId, teamColor]
 *       else:
 *         u8 isEmpty = 0
 *         u32 netSlotId
 *         CUser::sub_4A42E8
 *         u32 userFlags
 *         block(3) [stateFlags, charId, teamColor]
 *         u8 coupleSlotIdx (0xFF)
 *         if feature 15 enabled (true in TW):
 *           str guildName
 *           u32 guildMark
 *         CSlotAccessoryPacket
 *     u8 observerCount (0)
 *     u32 trailingFlag (0)
 */
export function buildJoinRoomResultPacket(state: WorldState, room: GameRoom): PacketWriter {
  const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
  w80.writeU8(0); // errCode = 0 (success)
  w80.writeU8(room.gameSubMode); // extraMode
  w80.writeString(room.name);
  w80.writeU16(room.roomNumber);
  w80.writeU16(room.mapId);
  w80.writeU8(room.gameMode);
  w80.writeU8(room.mapTheme);
  w80.writeU32(room.chiefSlotNetId);

  for (let i = 0; i < 8; i++) {
    const slot = room.slots[i]!;
    const slotBlock = new Uint8Array([
      computeSlotStateFlags(slot, room.chiefSlotNetId),
      slot.charId & 0x3f,
      slot.teamColor & 0x1f,
    ]);

    if (!slot.occupied || !slot.user) {
      w80.writeU8(1); // isEmpty = 1
      w80.writeBlock(slotBlock);
    } else {
      w80.writeU8(0); // isEmpty = 0 (occupied)
      w80.writeU32(slot.netSlotId);
      writeCUserBlock(w80, slot.user);
      w80.writeU32(0); // userFlags
      w80.writeBlock(slotBlock);
      w80.writeU8(0xff); // coupleSlotIdx = 0xFF
      if (state.config.enabledFeatures.has(15)) {
        w80.writeString(slot.user.guildName || "");
        w80.writeU32(slot.user.guildMark || 0);
      }
      writeSlotAccessoryBlock(w80, state, slot.user);
    }
  }

  w80.writeU8(0); // observerCount = 0
  w80.writeU32(0); // trailingFlag = 0
  return w80;
}

/**
 * Builds S->C 82 (`CLobbyStage::sub_4C1E57` -> `sub_4C1B1B` at `0x004C1B1B`)
 * Lobby Room List Entry Full Add/Set (`CGameSessionSlot` `0x004C30BD`). The `fieldNN`
 * labels name Client storage/accessor offsets only:
 *   u16 roomIndex (`v3`), u32 room-context word, str roomName
 *   u8 field18, u8 field21, u8 field27, u16 field30
 *   u8 field33, u8 field36, u8 field24, u32 field42, u8 field39
 * Local mappings only: field18 = occupied `room.slots` count; field21 = open `room.slots` count;
 * field33/field36 = `room.gameMode`/`room.gameSubMode`; field42 = `room.mapTheme`; field39 = its low byte.
 * The local context word is `room.chiefSlotNetId`. Client business meanings for offsets +33/+36
 * are unconfirmed despite UI-use clues; these builder mappings are not Client semantic evidence.
 */
export function buildLobbyRoomEntryPacket(room: GameRoom): PacketWriter {
  const field18Value = room.slots.filter((s) => s.occupied).length;
  const field21Value = room.slots.filter((s) => s.open).length;
  const w82 = new PacketWriter(ServerOpcode.LobbyRoomListEntry);
  w82.writeU16(room.roomNumber);
  w82.writeU32(room.chiefSlotNetId);
  w82.writeString(room.name);
  w82.writeU8(field18Value);
  w82.writeU8(field21Value);
  w82.writeU8(room.isPlaying ? 1 : 0);
  w82.writeU16(room.mapId);
  w82.writeU8(room.gameMode);
  w82.writeU8(room.gameSubMode);
  w82.writeU8(room.hasPassword ? 1 : 0);
  w82.writeU32(room.mapTheme);
  w82.writeU8(room.mapTheme & 0xff);
  return w82;
}

/**
 * Builds S->C 84 (`CLobbyStage::sub_4C1E90` -> `sub_4C1C0A` at `0x004C1C0A`)
 * Compact Lobby Room List Entry (waiting room with random map `255`):
 *   u16 roomIndex, u32 room-context word, str roomName
 *   u8 field18, u8 field21, u8 field33, u8 field36, u8 field24, u32 field42, u8 field39
 * The local builder maps field18/field21 to occupied/open slot counts, field33/field36 to
 * `room.gameMode`/`room.gameSubMode`, and field42/field39 to `room.mapTheme`/its low byte.
 * These are reconstruction mappings; the Client meanings of offsets +33/+36 are unconfirmed.
 */
export function buildLobbyRoomEntryCompactPacket(room: GameRoom): PacketWriter {
  const field18Value = room.slots.filter((s) => s.occupied).length;
  const field21Value = room.slots.filter((s) => s.open).length;
  const w84 = new PacketWriter(ServerOpcode.LobbyRoomListEntryCompact);
  w84.writeU16(room.roomNumber);
  w84.writeU32(room.chiefSlotNetId);
  w84.writeString(room.name);
  w84.writeU8(field18Value);
  w84.writeU8(field21Value);
  w84.writeU8(room.gameMode);
  w84.writeU8(room.gameSubMode);
  w84.writeU8(room.hasPassword ? 1 : 0);
  w84.writeU32(room.mapTheme);
  w84.writeU8(room.mapTheme & 0xff);
  return w84;
}

/**
 * Builds S->C 85 (`CLobbyStage::sub_4C1F02` -> `sub_4C32E4` at `0x004C32E4`)
 * Incremental Lobby Room Slot Update with bitmask `mask`:
 *   u16 roomIndex, u32 room-context word (local builder: `room.chiefSlotNetId`), u8 mask
 *   0x01 -> u8 field27; 0x02 -> u16 field30, u32 field42
 *   0x04 -> u8 field33; 0x08 -> u8 field36; 0x20 -> u8 field18
 *   0x10 -> str roomName; 0x40 -> u8 field39
 *   0x80 -> str roomName, u8 field18, u8 field24, u8 field21
 * Local mappings: field18/field21 are occupied/open slot counts; field33/field36 come from
 * `room.gameMode`/`room.gameSubMode`; field42/field39 come from `room.mapTheme`/its low byte.
 * Offsets +33/+36 have Client UI-use clues but no established business meanings.
 */
export function buildLobbyRoomSlotUpdatePacket(room: GameRoom, mask: number = 0x20): PacketWriter {
  const field18Value = room.slots.filter((s) => s.occupied).length;
  const field21Value = room.slots.filter((s) => s.open).length;
  const w85 = new PacketWriter(ServerOpcode.LobbyRoomSlotUpdate);
  w85.writeU16(room.roomNumber);
  w85.writeU32(room.chiefSlotNetId);
  w85.writeU8(mask & 0xff);
  if (mask & 0x01) {
    w85.writeU8(room.isPlaying ? 1 : 0);
  }
  if (mask & 0x02) {
    w85.writeU16(room.mapId);
    w85.writeU32(room.mapTheme);
  }
  if (mask & 0x04) {
    w85.writeU8(room.gameMode);
  }
  if (mask & 0x08) {
    w85.writeU8(room.gameSubMode);
  }
  if (mask & 0x20) {
    w85.writeU8(field18Value);
  }
  if (mask & 0x10) {
    w85.writeString(room.name);
  }
  if (mask & 0x40) {
    w85.writeU8(room.mapTheme & 0xff);
  }
  if (mask & 0x80) {
    w85.writeString(room.name);
    w85.writeU8(field18Value);
    w85.writeU8(room.hasPassword ? 1 : 0);
    w85.writeU8(field21Value);
  }
  return w85;
}

/**
 * Builds S->C 86 (`CLobbyStage::sub_4C1EC9` at `0x004C1EC9`)
 * Remove Room Slot from Lobby List:
 *   u16 roomIndex
 *   u32 room-context word (Client semantic not independently established)
 */
export function buildLobbyRoomSlotRemovePacket(roomNumber: number, roomContextWord: number): PacketWriter {
  const w86 = new PacketWriter(ServerOpcode.LobbyRoomSlotRemove);
  w86.writeU16(roomNumber & 0xffff);
  w86.writeU32(roomContextWord >>> 0);
  return w86;
}

/**
 * Builds S->C 83 (`CLobbyStage::sub_4C3DEB` -> `CNormalLobbyStrategy::sub_4CD139` at `0x004CD139`)
 * Room Detail Info Dialog:
 *   u8 validFlag (1 = valid, 0 = NotValidRoomInfo)
 *   if validFlag != 0:
 *     For i = 0 .. 7:
 *       u8 occupied
 *       if occupied != 0:
 *         u8 charId
 *         str username
 *         u16 level
 *         u8 netbarFlag
 *         u8 coupleFlag
 *     u32 mapId
 */
export function buildRoomDetailInfoPacket(room: GameRoom | undefined): PacketWriter {
  const w83 = new PacketWriter(ServerOpcode.RoomDetailInfo);
  if (!room) {
    w83.writeU8(0);
    return w83;
  }
  w83.writeU8(1);
  for (let i = 0; i < 8; i++) {
    const slot = room.slots[i];
    if (slot && slot.occupied && slot.user) {
      w83.writeU8(1);
      w83.writeU8(slot.charId);
      w83.writeString(slot.user.username);
      w83.writeU16(slot.user.level);
      w83.writeU8(0);
      w83.writeU8(0);
    } else {
      w83.writeU8(0);
    }
  }
  w83.writeU32(room.mapId);
  return w83;
}

/**
 * Handles CLobbyStage C->S opcodes:
 * - 12 / 83: Enter Lobby / Request Lobby Lists (`sub_4B94A6`)
 * - 13: Return to Channel Selection (`CLobbyStage::sub_4C1944`)
 * - 67: Room Detail Info Request (`sub_4C266D`: `[u16 roomIndex, u32 room-context word]`) -> `S->C 83`
 * - 75 / 79: Create Room (`sub_4CD379`, `sub_4CAC9F`, `sub_4CB60D`, `sub_4CC28E`, `sub_4C070B`) -> `S->C 79` + `S->C 102`
 * - 76: Join Room (`sub_4C4D93`) -> `S->C 80` + `S->C 102`
 * - 77 / 81: Quick Join (`sub_4C83BA`, `CNormalLobbyStrategy::sub_4CCCE2`) -> `S->C 81` (`sub_4C4635`)
 * - 80: Room List Scroll / Detail Info (`sub_4A496F`: `[u16 roomIndex]`) -> `S->C 83`
 * - 82: Return to Room (`sub_536E2E`: `[u16 roomNumber, u32 opaque room-context word]`) -> `S->C 80`
 */
export function handleLobbyPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  if (opcode === ClientOpcode.EnterLobby) {
    const payloadBytes = reader.remaining;
    const pendingLobbyHandoff =
      session.stageId === StageId.SelectServer && session.pendingStageId === StageId.Lobby;
    const alreadyInLobby = session.stageId === StageId.Lobby;
    if (
      payloadBytes !== 0 ||
      !hasSelectedChannel(session, state) ||
      session.users.length < 1 ||
      session.users.length > 2 ||
      session.currentRoomNumber !== null ||
      (!pendingLobbyHandoff && !alreadyInLobby)
    ) {
      logRejectedLobbyPacket(
        session,
        opcode,
        payloadBytes,
        "empty C->S 83 body; selected game channel, one or two session users, and Lobby handoff context",
        "Ignored malformed or out-of-context C->S 83 Lobby-entry signal"
      );
      return;
    }
  }

  switch (opcode) {
    case ClientOpcode.ClientReportOrLobbyEnter:
    case ClientOpcode.EnterLobby: {
      const previousStageId = session.stageId;
      session.stageId = StageId.Lobby;
      if (opcode === ClientOpcode.EnterLobby) {
        session.pendingStageId = null;
        session.lobbyEntryPacketSeen = true;
      }
      // Send S->C 89 (experience) and the local S->C 186 dynamic-field candidate for a logged-in user.
      // The Client parser for 186 narrows its second u32 to a char; the field mapping is UNKNOWN.
      const user = session.users[0];
      if (user) {
        // S->C 197 (UserItemsData) fills `CUserItemMan` (CA.exe `sub_598BEC`). Both the
        // shop-list icon lookup (`ShopItem::sub_5890CC` by fxstock +104) and the S->C 194
        // inventory parser (`sub_595272`, drops ids unknown to `CUserItemMan`) require
        // this table, so it must arrive before the inventory frame.
        const fxstockBody = state.resources.ssdFiles.get("fxstock.ini")?.decompressed;
        if (fxstockBody) {
          const userItems = buildUserItemCatalog(parseFxStockCatalog(fxstockBody));
          session.sendPacket(buildUserItemRecordsPacket(userItems));
        }

        const w89 = new PacketWriter(ServerOpcode.ExpSync);
        w89.writeU8(0);
        w89.writeU32(user.exp);
        session.sendPacket(w89);

        const w186 = new PacketWriter(ServerOpcode.UserDynamicInfoFieldSync186);
        w186.writeU32(0);
        w186.writeU32(user.lucci);
        session.sendPacket(w186);

        // Sync inventory, equipped avatar slots, expansion slots, and couple ring state
        session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryData));
        session.sendPacket(buildEquippedAvatarPacket196(state, session));
        session.sendPacket(buildInventoryExpansionPacket268(session));
        session.sendPacket(buildCoupleInfoSyncPacket250(state, session));
      }

      // Send existing rooms via S->C 82 (`CLobbyStage::sub_4C1E57`)
      for (const room of state.rooms.values()) {
        session.sendPacket(buildLobbyRoomEntryPacket(room));
      }

      // The Taiwan client has feature 32 disabled, so the S->C 75 handler sends
      // C->S 83 but no C->S 338. The exact `LoadingChannelInfo` notice is closed
      // by Lobby's S->C 207 handler (`sub_4C86A2`); send the existing
      // dynamic-map/stage-config packet after C->S 83 has entered Lobby. When
      // feature 32 is enabled, the client's empty C->S 338 continues to elicit it.
      const feature32Enabled = state.config.enabledFeatures.has(32);
      const sendLobbyStageConfig207Fallback =
        opcode === ClientOpcode.EnterLobby &&
        session.connectionKind === "game" &&
        !feature32Enabled;
      if (sendLobbyStageConfig207Fallback) {
        session.sendPacket(buildDynamicMapConfigPacket207(state));
      }

      const lobbyServerOpcodes: number[] = user
        ? [
            ServerOpcode.UserItemsData,
            ServerOpcode.ExpSync,
            ServerOpcode.UserDynamicInfoFieldSync186,
            ServerOpcode.InventoryData,
            ServerOpcode.EquippedAvatarData,
            ServerOpcode.InventoryExpansionSlots,
            ServerOpcode.CoupleInfoSync,
          ]
        : [];
      if (sendLobbyStageConfig207Fallback) {
        lobbyServerOpcodes.push(ServerOpcode.DynamicMapAndStageConfig);
      }

      logger.info("LobbyInit", "Queued initial Lobby sync frames", {
        sessionId: session.sessionId,
        linkedLoginSessionId: session.linkedLoginSessionId,
        clientRequest: formatClientOpcode(opcode),
        previousServerStage: formatStageId(previousStageId),
        stageId: formatStageId(session.stageId),
        lobbyEntrySignalObserved: session.lobbyEntryPacketSeen,
        clientUiModalStateObservable: false,
        playerCount: session.users.length,
        serverOpcodes: lobbyServerOpcodes.map((serverOpcode) =>
          formatServerOpcode(serverOpcode, session.stageId)
        ),
        feature32Enabled,
        stageConfig207WriteCall: sendLobbyStageConfig207Fallback,
        clientModalDismissalVerified: false,
        playerFields: user
          ? {
              expValueIn89: user.exp,
              opcode186WireU32Values: [0, user.lucci],
              opcode186SecondU32LowByte: formatU8Hex(user.lucci),
            }
          : null,
        coupleAnniversaryFeature30: state.config.enabledFeatures.has(30),
        existingRoomEntries: state.rooms.size,
      }, {
        displayData: {
          sessionId: session.sessionId,
          linkedLoginSessionId: session.linkedLoginSessionId,
          clientRequest: formatClientOpcode(opcode),
          stageId: formatStageId(session.stageId),
          playerCount: session.users.length,
          serverOpcodes: lobbyServerOpcodes.map((serverOpcode) =>
            formatServerOpcode(serverOpcode, session.stageId)
          ),
          feature32Enabled,
          stageConfig207WriteCall: sendLobbyStageConfig207Fallback,
        },
      });
      break;
    }

    case ClientOpcode.RoomDetailOrUserInfo: {
      // `sub_4C266D`: exact `[u16 roomIndex, u32 opaque room-context word]` -> S->C 83.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 6 || !hasLobbyRoomActionContext(state, session)) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          "Lobby context; exactly u16 roomIndex + u32 opaque room-context word (6 bytes)",
          "Ignored malformed or out-of-context C->S 67 room-detail request"
        );
        break;
      }
      const roomNumber = reader.readU16();
      reader.readU32(); // The Client writer's room-context value is not used as an admission key locally.
      const room = state.rooms.get(roomNumber);
      if (room) session.sendPacket(buildRoomDetailInfoPacket(room));
      break;
    }

    case ClientOpcode.CreateRoom:
    case ClientOpcode.CreateRoomShort: {
      const payloadBytes = reader.remaining;
      const hasPasswordField = opcode === ClientOpcode.CreateRoom;
      const parsed = parseCreateRoomPayload(reader, hasPasswordField);
      const expectedSchema = hasPasswordField
        ? "str roomName, str password, u8 opaque, u8 localCnt, localCnt*u8 charId, tail u32 OR u8+u32 (exact; writer variants kept distinct)"
        : "str roomName, u8 opaque, u8 localCnt, localCnt*u8 charId, u8 opaque, u32 opaque (exact)";
      if (
        !parsed ||
        !hasLobbyRoomActionContext(state, session) ||
        parsed.charIds.length !== session.users.length
      ) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          `${expectedSchema}; lobby session user count must match localCnt`,
          "Ignored malformed, non-exact, or out-of-context room-create request"
        );
        break;
      }

      // These are local adapter mappings, not Client-proven meanings for the opaque flag/tail.
      // The main C->S 75 writer maps its 1-byte tail to a local mode and low byte of map option;
      // its 4-byte-tail variant and C->S 79 retain the local defaults instead.
      const localGameMode = hasPasswordField && parsed.tailLayout === "u8+u32" ? parsed.tailU8! : 0;
      const localMapTheme = hasPasswordField && parsed.tailLayout === "u8+u32" ? parsed.tailU32 & 0xff : 0;
      const room = state.createRoom(
        session,
        parsed.roomName,
        parsed.password,
        parsed.password.length > 0,
        localGameMode,
        localMapTheme,
        parsed.charIds
      );
      logger.info("PacketAudit", "Created a local room from an exact Client writer form", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        localPlayerCount: parsed.charIds.length,
        opaquePrefixU8: parsed.prefixU8,
        tailLayout: parsed.tailLayout,
        tailU8: parsed.tailU8 ?? null,
        tailU32: parsed.tailU32,
        localGameMode,
        localMapTheme,
        responseSent: true,
        roomStateChanged: true,
        databaseMutation: false,
        serverMappingPolicy: "room password uses non-empty string; opaque fields use variant-specific local mapping/defaults",
      });

      // S->C 79 requests Stage 12 from the Lobby handler, but CMainWnd constructs that stage on
      // a later main-loop turn. Sending S->C 102 immediately can put both frames in one Client
      // receive burst, where the still-active Lobby stage consumes/ignores 102. Release the slot
      // packets after the Client emits its next C->S packet instead.
      session.sendPacket(buildCreateRoomResultPacket(room));
      const deferredSlotPackets = session.roomSlotIndices.flatMap((slotIdx) => {
        const slot = room.slots[slotIdx];
        return slot?.occupied
          ? [buildSetPlayerPacket(state, slot, 0, room.chiefSlotNetId)]
          : [];
      });
      session.deferStagePackets(StageId.Prepare, deferredSlotPackets);
      logger.info("StageSync", "Deferred Prepare slot installation until Client resumes", {
        sessionId: session.sessionId,
        roomNumber: room.roomNumber,
        targetStage: formatStageId(StageId.Prepare),
        deferredServerOpcodes: deferredSlotPackets.map((packet) => packet.opcode),
        slots: session.roomSlotIndices.map((slotIdx) => {
          const slot = room.slots[slotIdx]!;
          return `${slotIdx}:flags=${formatU8Hex(
            computeSlotStateFlags(slot, room.chiefSlotNetId)
          )},char=${slot.charId & 0x3f},localIdentityMatch=${
            slot.netSlotId === session.netSlotIds[slot.localPlayerIdx]
          }`;
        }),
        reason: "avoid S->C 79 and stage-specific S->C 102 in one Client receive burst",
      });
      break;
    }

    case ClientOpcode.JoinRoom: {
      const payloadBytes = reader.remaining;
      const parsed = parseJoinRoomPayload(reader);
      if (!parsed || !hasLobbyRoomActionContext(state, session) || parsed.charIds.length !== session.users.length) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          "u16 roomNumber, u32 opaque room-context, one recovered credential form, u8 localCnt, localCnt*u8 charId (exact); Lobby session user count must match",
          "Ignored malformed, non-exact, or out-of-context C->S 76 join-room request"
        );
        break;
      }

      const room = state.rooms.get(parsed.roomNumber);
      if (!room || room.isPlaying) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(2); // Client maps result 2 to CantJoinRoom; this is local admission policy.
        session.sendPacket(w80);
        break;
      }

      // The invite-marker writer has no password string. This reconstruction has no recovered
      // invitation credential store, so it does not treat that marker as a password bypass.
      if (
        room.hasPassword &&
        (parsed.credentialForm === "invite-marker" || parsed.password !== room.password)
      ) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(1); // Client maps result 1 to WrongPassword; emitted as local policy.
        session.sendPacket(w80);
        break;
      }

      const freeCount = room.slots.filter((slot) => slot.open && !slot.occupied).length;
      if (freeCount < parsed.charIds.length) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(2);
        session.sendPacket(w80);
        break;
      }

      const assignedSlots = state.assignSessionToRoom(session, room, parsed.charIds);
      if (assignedSlots.length !== parsed.charIds.length) {
        // Defensive consistency guard; the pre-check should make this unreachable in the
        // single-threaded local world-state mutation path.
        state.leaveRoom(session);
        logger.error("Lobby", "Room assignment count differed from the exact C->S 76 localCnt", {
          sessionId: session.sessionId,
          roomNumber: room.roomNumber,
          requestedLocalCount: parsed.charIds.length,
          assignedLocalCount: assignedSlots.length,
        });
        break;
      }

      session.sendPacket(buildJoinRoomResultPacket(state, room));
      for (const slotIdx of assignedSlots) {
        const slot = room.slots[slotIdx]!;
        state.broadcastToRoom(room, () => buildSetPlayerPacket(state, slot, 1, room.chiefSlotNetId));
      }
      logger.info("PacketAudit", "Joined a local room from an exact Client writer form", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        roomNumber: room.roomNumber,
        credentialForm: parsed.credentialForm,
        localPlayerCount: parsed.charIds.length,
        responseSent: true,
        roomStateChanged: true,
        databaseMutation: false,
        admissionPolicy: "local room lookup/password/slot capacity; Client context word not used as sender identity or invitation proof",
      });
      break;
    }

    case ClientOpcode.QuickJoin:
    case ClientOpcode.QuickJoinShort: {
      const payloadBytes = reader.remaining;
      const localCount = opcode === ClientOpcode.QuickJoin ? 1 : 4;
      const parsed = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 1) return null;
        const count = probe.readU8();
        if (count < 1 || count > 2 || probe.remaining !== count + localCount) return null;
        const charIds: number[] = [];
        for (let index = 0; index < count; index++) charIds.push(probe.readU8());
        const trailingValue = localCount === 1 ? probe.readU8() : probe.readU32();
        return { count, charIds, trailingValue };
      });
      if (
        !parsed ||
        !hasLobbyRoomActionContext(state, session) ||
        parsed.count !== session.users.length
      ) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          opcode === ClientOpcode.QuickJoin
            ? "u8 localCnt, localCnt*u8 charId, u8 opaque tail (exact)"
            : "u8 localCnt, localCnt*u8 charId, u32 opaque tail (exact)",
          "Ignored malformed, non-exact, or out-of-context quick-join request"
        );
        break;
      }

      const targetRoom = Iterator.from(state.rooms.values()).find((candidate) => {
        const freeSlots = candidate.slots.filter((slot) => slot.open && !slot.occupied).length;
        return !candidate.isPlaying && !candidate.hasPassword && freeSlots >= parsed.count;
      });
      if (!targetRoom) {
        const w81 = new PacketWriter(ServerOpcode.QuickJoinOrUserProfile);
        w81.writeU8(2); // Client's S->C 81 parser maps 2 to CantFindEmptyRoom.
        session.sendPacket(w81);
        break;
      }

      const assignedSlots = state.assignSessionToRoom(session, targetRoom, parsed.charIds);
      if (assignedSlots.length !== parsed.charIds.length) {
        state.leaveRoom(session);
        logger.error("Lobby", "Quick-join assignment count differed from exact Client localCnt", {
          sessionId: session.sessionId,
          roomNumber: targetRoom.roomNumber,
          requestedLocalCount: parsed.charIds.length,
          assignedLocalCount: assignedSlots.length,
        });
        break;
      }

      const w81 = new PacketWriter(ServerOpcode.QuickJoinOrUserProfile);
      w81.writeU8(0);
      w81.writeU16(targetRoom.roomNumber);
      w81.writeU32(targetRoom.chiefSlotNetId); // Local builder mapping for an opaque Client context word.
      w81.writeU8(targetRoom.mapTheme);
      session.sendPacket(w81);
      for (const slotIdx of assignedSlots) {
        const slot = targetRoom.slots[slotIdx]!;
        state.broadcastToRoom(targetRoom, () => buildSetPlayerPacket(state, slot, 1, targetRoom.chiefSlotNetId));
      }
      logger.info("PacketAudit", "Quick-joined a local room from an exact Client writer form", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        roomNumber: targetRoom.roomNumber,
        localPlayerCount: parsed.charIds.length,
        opaqueTail: parsed.trailingValue,
        responseSent: true,
        roomStateChanged: true,
        databaseMutation: false,
        serverMappingPolicy: "local free public-room selection and assignment; S->C 81 context word uses room.chiefSlotNetId",
      });
      break;
    }

    case ClientOpcode.RoomListScrollOrDetail: {
      if (reader.remaining !== 2 || !hasLobbyRoomActionContext(state, session)) {
        logRejectedLobbyPacket(
          session,
          opcode,
          reader.remaining,
          "Lobby context; exactly u16 roomNumber (2 bytes)",
          "Ignored malformed or out-of-context C->S 80 room-detail request"
        );
        break;
      }

      const roomNumber = reader.readU16();
      const room = state.rooms.get(roomNumber);
      if (!room) {
        // CLobbyStage::sub_4C99DC creates an empty lobby and unconditionally calls
        // sub_4A496F(..., 0). Returning S->C 83 with validFlag=0 here opens the client's
        // NotValidRoomInfo modal during that normal empty-list bootstrap.
        logger.debug("Lobby", "Ignored room-detail prefetch for a room that is not present", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber,
          roomCount: state.rooms.size,
          responseSent: false,
          reason: "S->C 83 validFlag=0 displays NotValidRoomInfo in the Taiwan client",
        });
        break;
      }

      session.sendPacket(buildRoomDetailInfoPacket(room));
      logger.debug("Lobby", "Sent room-detail response for an existing room", {
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        roomNumber,
        responseOpcode: formatServerOpcode(ServerOpcode.RoomDetailInfo),
        validFlag: 1,
      });
      break;
    }

    case ClientOpcode.ReturnToRoom: {
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 6) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          "exactly u16 roomNumber + u32 opaque Client context word (6 bytes)",
          "Ignored malformed C->S 82 room-return request"
        );
        break;
      }
      const roomNumber = reader.readU16();
      reader.readU32(); // Opaque Client context word; structural validation only.
      const room = state.rooms.get(roomNumber);
      if (
        !hasSelectedChannel(session, state) ||
        (session.stageId !== StageId.Shop && session.stageId !== StageId.UserMarket) ||
        session.currentRoomNumber !== roomNumber ||
        !room ||
        !sessionOwnsRoomSlot(session, room)
      ) {
        logRejectedLobbyPacket(
          session,
          opcode,
          payloadBytes,
          "selected game channel; same current room and occupied session-owned slot; Shop or UserMarket stage",
          "Ignored C->S 82 room-return request without matching local room membership"
        );
        break;
      }

      // The Client's u32 is retained for audit only; no sender-slot or admission meaning is inferred.
      session.stageId = StageId.Prepare;
      session.sendPacket(buildJoinRoomResultPacket(state, room));
      logger.info("PacketAudit", "Observed C->S 82 and returned the session to its existing local room", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        roomNumber,
        opaqueRoomContextWord: "<omitted>",
        responseSent: true,
        sessionStageChanged: true,
        roomStateChanged: false,
        databaseMutation: false,
        serverPolicy: "requires the same room to already own an occupied session slot; opaque u32 is not used for identity",
      });
      break;
    }
  }
}
