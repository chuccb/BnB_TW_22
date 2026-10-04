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
import { sendChannelListAndLoads } from "./channelHandler.ts";
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
} from "./shopHandler.ts";

/**
 * Builds S->C 79 (`CLobbyStage::sub_4C86A2` case `'O'` -> `sub_4C3F09` -> `CNormalLobbyStrategy::sub_4CCE53` at `0x004CCE53`)
 * Create Room Result:
 *   u8 errCode (0 = success, 1 = SameRoomExist)
 *   if errCode == 0:
 *     u16 roomNumber (`sub_697510`)
 *     u32 chiefSlotNetId (`sub_697580`)
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
 *     u32 chiefSlotNetId (`sub_697580`)
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
      computeSlotStateFlags(slot),
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
 * Lobby Room List Entry Full Add/Set (`CGameSessionSlot` `0x004C30BD`):
 *   u16 roomIndex (`v3`)
 *   u32 roomKey (`*(this + 17) = sub_697580`)
 *   str roomName (`sub_698270(a2, this + 2)`)
 *   u8 curPlayers (`this + 18`: `sub_6974B0`)
 *   u8 maxPlayers (`this + 21`: `sub_6974B0`)
 *   u8 isPlaying (`this + 27`: `sub_6974B0`)
 *   u16 mapId (`this + 30`: `sub_697510`)
 *   u8 gameMode (`this + 33`: `sub_6974B0`)
 *   u8 gameSubMode (`this + 36`: `sub_6974B0`)
 *   u8 hasPassword (`this + 24`: `sub_6974B0`)
 *   u32 mapCategory (`this + 42`: `sub_697580`)
 *   u8 mapTheme (`this + 39`: `sub_6974B0`)
 */
export function buildLobbyRoomEntryPacket(room: GameRoom): PacketWriter {
  const curPlayers = room.slots.filter((s) => s.occupied).length;
  const maxPlayers = room.slots.filter((s) => s.open).length;
  const w82 = new PacketWriter(ServerOpcode.LobbyRoomListEntry);
  w82.writeU16(room.roomNumber);
  w82.writeU32(room.chiefSlotNetId);
  w82.writeString(room.name);
  w82.writeU8(curPlayers);
  w82.writeU8(maxPlayers);
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
 *   u16 roomIndex
 *   u32 roomKey
 *   str roomName
 *   u8 curPlayers (`this + 18`)
 *   u8 maxPlayers (`this + 21`)
 *   u8 gameMode (`this + 33`)
 *   u8 gameSubMode (`this + 36`)
 *   u8 hasPassword (`this + 24`)
 *   u32 mapCategory (`this + 42`)
 *   u8 mapTheme (`this + 39`)
 */
export function buildLobbyRoomEntryCompactPacket(room: GameRoom): PacketWriter {
  const curPlayers = room.slots.filter((s) => s.occupied).length;
  const maxPlayers = room.slots.filter((s) => s.open).length;
  const w84 = new PacketWriter(ServerOpcode.LobbyRoomListEntryCompact);
  w84.writeU16(room.roomNumber);
  w84.writeU32(room.chiefSlotNetId);
  w84.writeString(room.name);
  w84.writeU8(curPlayers);
  w84.writeU8(maxPlayers);
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
 *   u16 roomIndex
 *   u32 roomKey
 *   u8 mask:
 *     0x01 -> u8 isPlaying (`this + 27`)
 *     0x02 -> u16 mapId (`this + 30`), u32 mapCategory (`this + 42`)
 *     0x04 -> u8 gameMode (`this + 33`)
 *     0x08 -> u8 gameSubMode (`this + 36`)
 *     0x20 -> u8 curPlayers (`this + 18`)
 *     0x10 -> str roomName (`*this + 12`)
 *     0x40 -> u8 mapTheme (`this + 39`)
 *     0x80 -> str roomName, u8 curPlayers, u8 hasPassword, u8 maxPlayers
 */
export function buildLobbyRoomSlotUpdatePacket(room: GameRoom, mask: number = 0x20): PacketWriter {
  const curPlayers = room.slots.filter((s) => s.occupied).length;
  const maxPlayers = room.slots.filter((s) => s.open).length;
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
    w85.writeU8(curPlayers);
  }
  if (mask & 0x10) {
    w85.writeString(room.name);
  }
  if (mask & 0x40) {
    w85.writeU8(room.mapTheme & 0xff);
  }
  if (mask & 0x80) {
    w85.writeString(room.name);
    w85.writeU8(curPlayers);
    w85.writeU8(room.hasPassword ? 1 : 0);
    w85.writeU8(maxPlayers);
  }
  return w85;
}

/**
 * Builds S->C 86 (`CLobbyStage::sub_4C1EC9` at `0x004C1EC9`)
 * Remove Room Slot from Lobby List:
 *   u16 roomIndex
 *   u32 roomKey
 */
export function buildLobbyRoomSlotRemovePacket(roomNumber: number, roomKey: number): PacketWriter {
  const w86 = new PacketWriter(ServerOpcode.LobbyRoomSlotRemove);
  w86.writeU16(roomNumber & 0xffff);
  w86.writeU32(roomKey >>> 0);
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
 * - 67: Room Detail Info Request (`sub_4C266D`: `[u16 roomIndex, u32 roomKey]`) -> `S->C 83`
 * - 75 / 79: Create Room (`sub_4CD379`, `sub_4CAC9F`, `sub_4CB60D`, `sub_4CC28E`, `sub_4C070B`) -> `S->C 79` + `S->C 102`
 * - 76: Join Room (`sub_4C4D93`) -> `S->C 80` + `S->C 102`
 * - 77 / 81: Quick Join (`sub_4C83BA`, `CNormalLobbyStrategy::sub_4CCCE2`) -> `S->C 81` (`sub_4C4635`)
 * - 80: Room List Scroll / Detail Info (`sub_4A496F`: `[u16 roomIndex]`) -> `S->C 83`
 * - 82: Return to Room (`sub_536E2E`: `[u16 roomNumber, u32 chiefKey]`) -> `S->C 80`
 */
export function handleLobbyPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  switch (opcode) {
    case ClientOpcode.ClientReportOrLobbyEnter:
    case ClientOpcode.EnterLobby: {
      const previousStageId = session.stageId;
      session.stageId = StageId.Lobby;
      if (opcode === ClientOpcode.EnterLobby) {
        session.pendingStageId = null;
        session.lobbyEntryPacketSeen = true;
      }
      // Send S->C 89 (Exp sync) and S->C 186 (Lucci sync) for logged-in user
      const user = session.users[0];
      if (user) {
        const w89 = new PacketWriter(ServerOpcode.ExpSync);
        w89.writeU8(0);
        w89.writeU32(user.exp);
        session.sendPacket(w89);

        const w186 = new PacketWriter(ServerOpcode.LucciSync);
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
            ServerOpcode.ExpSync,
            ServerOpcode.LucciSync,
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
        serverOpcodes: lobbyServerOpcodes.map(formatServerOpcode),
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
          serverOpcodes: lobbyServerOpcodes.map(formatServerOpcode),
          feature32Enabled,
          stageConfig207WriteCall: sendLobbyStageConfig207Fallback,
        },
      });
      break;
    }

    case ClientOpcode.ReturnToChannelSelect: {
      session.stageId = StageId.SelectServer;
      sendChannelListAndLoads(state, session);
      const w9 = new PacketWriter(ServerOpcode.StageTransition);
      w9.writeU32(StageId.SelectServer);
      session.sendPacket(w9);
      break;
    }

    case ClientOpcode.RoomDetailOrUserInfo: {
      // `sub_4C266D` / `CLobbyStage::sub_4C50C4`: `[u16 roomIndex, u32 roomKey]` (6 bytes) -> `S->C 83`
      const roomNumber = reader.remaining >= 2 ? reader.readU16() : 1;
      const room = state.rooms.get(roomNumber);
      session.sendPacket(buildRoomDetailInfoPacket(room));
      break;
    }

    case ClientOpcode.CreateRoom:
    case ClientOpcode.CreateRoomShort: {
      const roomName = reader.remaining >= 2 ? reader.readString() : "CrazyArcade Room";
      let password = "";
      let isPrivate = false;
      if (opcode === ClientOpcode.CreateRoomShort) {
        // `sub_4C070B`: `[str roomName, u8 isPrivate, u8 localCnt, localCnt * u8 charId, u8 gameMode, ...]`
        isPrivate = reader.remaining >= 1 ? reader.readU8() !== 0 : false;
      } else {
        // `sub_4CD379`: `[str roomName, str password, u8 isPrivate, u8 localCnt, localCnt * u8 charId, u8 gameMode, u32 mapTheme]`
        password = reader.remaining >= 2 ? reader.readString() : "";
        isPrivate = reader.remaining >= 1 ? reader.readU8() !== 0 : password.length > 0;
      }

      const localCnt = Math.min(2, Math.max(1, reader.remaining >= 1 ? reader.readU8() : 1));
      const charIds: number[] = [];
      for (let i = 0; i < localCnt; i++) {
        charIds.push(reader.remaining >= 1 ? reader.readU8() : 0);
      }
      const gameMode = reader.remaining >= 1 ? reader.readU8() : 0;
      const mapTheme = reader.remaining >= 4 ? reader.readU32() & 0xff : 0;

      const room = state.createRoom(
        session,
        roomName,
        password,
        isPrivate,
        gameMode,
        mapTheme,
        charIds
      );

      // Send S->C 79 Create Room Result -> transitions client to Stage 12 (CPrepareStage)
      session.sendPacket(buildCreateRoomResultPacket(room));

      // Send S->C 102 (`CSetPlayerOnPreparePacket`) for each occupied slot in the room
      for (const slotIdx of session.roomSlotIndices) {
        const slot = room.slots[slotIdx];
        if (slot && slot.occupied) {
          session.sendPacket(buildSetPlayerPacket(state, slot, 0));
        }
      }
      break;
    }

    case ClientOpcode.JoinRoom: {
      const roomNumber = reader.remaining >= 2 ? reader.readU16() : 1;
      const _chiefKey = reader.remaining >= 4 ? reader.readU32() : 0xffffffff;

      const room = state.rooms.get(roomNumber);
      if (!room || room.isPlaying) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(2); // 2 = CantJoinRoom (`sub_4C77C2`)
        session.sendPacket(w80);
        return;
      }

      // `sub_4C4D93`: always writes `str password` (`CSendPacket::sub_6956C0`), or `u8(0)` in invite accept
      let providedPassword = "";
      if (room.hasPassword) {
        providedPassword = reader.remaining >= 2 ? reader.readString() : "";
      } else if (reader.remaining >= 1) {
        const peekLen = reader.remaining;
        if (peekLen > 4) {
          providedPassword = reader.readString();
        } else {
          reader.readU8();
        }
      }

      if (room.hasPassword && providedPassword !== room.password) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(1); // 1 = WrongPassword (`sub_4C77C2`)
        session.sendPacket(w80);
        return;
      }

      const localCnt = Math.min(2, Math.max(1, reader.remaining >= 1 ? reader.readU8() : 1));
      const charIds: number[] = [];
      for (let i = 0; i < localCnt; i++) {
        charIds.push(reader.remaining >= 1 ? reader.readU8() : 0);
      }

      const freeCount = room.slots.filter((s) => s.open && !s.occupied).length;
      if (freeCount < localCnt) {
        const w80 = new PacketWriter(ServerOpcode.JoinRoomResult);
        w80.writeU8(2); // 2 = CantJoinRoom (`sub_4C77C2`)
        session.sendPacket(w80);
        return;
      }

      const assignedSlots = state.assignSessionToRoom(session, room, charIds);

      // Send S->C 80 Join Room Result to the joining session
      session.sendPacket(buildJoinRoomResultPacket(state, room));

      // Broadcast S->C 102 (`CSetPlayerOnPreparePacket`) for the newly joined slots to everyone in the room
      for (const slotIdx of assignedSlots) {
        const slot = room.slots[slotIdx]!;
        state.broadcastToRoom(room, () => buildSetPlayerPacket(state, slot, 1));
      }
      break;
    }

    case ClientOpcode.QuickJoin:
    case ClientOpcode.QuickJoinShort: {
      const localCnt = Math.min(2, Math.max(1, reader.remaining >= 1 ? reader.readU8() : 1));
      const charIds: number[] = [];
      for (let i = 0; i < localCnt; i++) {
        charIds.push(reader.remaining >= 1 ? reader.readU8() : 0);
      }

      const targetRoom = Iterator.from(state.rooms.values()).find((r) => {
        const freeSlots = r.slots.filter((s) => s.open && !s.occupied).length;
        return !r.isPlaying && !r.hasPassword && freeSlots >= localCnt;
      });

      if (!targetRoom) {
        // S->C 81 (`sub_4C4635`): errCode = 2 ("CantFindEmptyRoom")
        const w81 = new PacketWriter(ServerOpcode.QuickJoinOrUserProfile);
        w81.writeU8(2);
        session.sendPacket(w81);
        return;
      }

      // Send S->C 81 (`sub_4C4635`) Quick Join Result
      const w81 = new PacketWriter(ServerOpcode.QuickJoinOrUserProfile);
      w81.writeU8(0); // errCode = 0
      w81.writeU16(targetRoom.roomNumber);
      w81.writeU32(targetRoom.chiefSlotNetId);
      w81.writeU8(targetRoom.mapTheme);
      session.sendPacket(w81);
      break;
    }

    case ClientOpcode.RoomListScrollOrDetail: {
      if (reader.remaining !== 2) {
        logger.warn("Lobby", "Ignored malformed C->S 80 room-detail request", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          expectedPayloadBytes: 2,
          receivedPayloadBytes: reader.remaining,
          responseSent: false,
        });
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
      const roomNumber = reader.remaining >= 2 ? reader.readU16() : 1;
      const room = state.rooms.get(roomNumber);
      if (room) {
        session.stageId = StageId.Prepare;
        session.sendPacket(buildJoinRoomResultPacket(state, room));
      }
      break;
    }
  }
}
