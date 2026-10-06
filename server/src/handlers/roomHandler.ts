import type { UserRecord } from "../db/database.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import type { ClientSession, GameRoom, RoomSlot, WorldState } from "../state/worldState.ts";
import { formatStageId, logger } from "../utils/logger.ts";
import { buildShopInitPacket16, buildUserStockPacket } from "./shopHandler.ts";

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

function sessionOwnsRoomSlot(session: ClientSession, room: GameRoom): boolean {
  return room.slots.some((slot) => slot.occupied && slot.session === session);
}

function sessionOwnsChiefSlot(session: ClientSession, room: GameRoom): boolean {
  return room.slots.some(
    (slot) => slot.occupied && slot.session === session && slot.netSlotId === room.chiefSlotNetId
  );
}

function hasSelectedRoomStageContext(
  state: WorldState,
  session: ClientSession,
  room: GameRoom,
  allowedStages: readonly number[]
): boolean {
  return session.connectionKind === "game" &&
    session.channelSelected &&
    Number.isInteger(session.channelIndex) &&
    session.channelIndex >= 0 &&
    session.channelIndex < state.channels.length &&
    session.currentRoomNumber === room.roomNumber &&
    allowedStages.includes(session.stageId) &&
    sessionOwnsRoomSlot(session, room);
}

function getSessionRoomSlot(
  session: ClientSession,
  room: GameRoom,
  localIdx: number
): { slotIdx: number; slot: RoomSlot } | null {
  if (!Number.isInteger(localIdx) || localIdx < 0 || localIdx >= session.users.length) return null;
  const slotIdx = session.roomSlotIndices[localIdx];
  if (slotIdx === undefined) return null;
  const slot = room.slots[slotIdx];
  const user = session.users[localIdx];
  if (
    !slot ||
    !user ||
    !slot.occupied ||
    slot.session !== session ||
    slot.localPlayerIdx !== localIdx ||
    slot.user?.id !== user.id
  ) {
    return null;
  }
  return { slotIdx, slot };
}

function logRejectedRoomPacket(
  session: ClientSession,
  room: GameRoom,
  opcode: number,
  payloadBytes: number,
  expectedSchema: string,
  reason: string
): void {
  logger.warn("Room", reason, {
    direction: "C->S",
    wireOpcode: opcode,
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    roomNumber: room.roomNumber,
    payloadBytes,
    expectedSchema,
    responseSent: false,
    roomStateChanged: false,
    databaseMutation: false,
  });
}

/**
 * Exact reconstruction of CPrepareStage (`0x004CFA00` - `0x004DCF07`, vtable `0x7B4E1C`),
 * CSlotStage (`0x004B7EE8` - `0x004B89E4`, vtable `0x7B337C`), and CSessionStage (`0x004B7170` - `0x004B7DF2`).
 *
 * Computes the 1-byte slot state bitmask used in `block(3) [stateFlags, charId, teamColor]`
 * (`CSetPlayerPacket::possible_ctor_or_dtor` at `0x00437337` and `CPrepareStage::sub_4D9D08` at `0x004D9D08`):
 * - bit 0 (0x01): open
 * - bit 1 (0x02): occupied
 * - bit 2 (0x04): local Ready encoding; the Client's start preflight accepts `(stateFlags & 0x1C) == 4`.
 * - bit 3 (0x08): reconstruction's `inShop` marker. The Client has a distinct `0x1C` special-state check;
 *   the relationship between that Client state and this local encoding is not established.
 */
export function computeSlotStateFlags(slot: RoomSlot): number {
  let flags = 0;
  if (slot.open) flags |= 0x01;
  if (slot.occupied) flags |= 0x02;
  if (slot.ready) flags |= 0x04;
  if (slot.inShop) flags |= 0x08;
  return flags;
}

/**
 * Writes the fields consumed by `CUser::sub_4A42E8` (`0x004A42E8`) in wire order:
 *   str (Client CUser member +0x08)
 *   u8 (+0x24), u8 (+0x30), u32 (+0x3C), u16 (+0x54)
 *   u32 (+0x60), u32 (+0x78), u32 (+0x6C), u32 (+0x48), u8 (+0x90)
 *   u16 (discarded by the Client parser), u16 (+0xC0), u16 (+0xCC), u16 (+0xD8)
 *
 * The property names passed in `user` are this reconstruction's mapping; the Client dump only
 * proves the read widths/order and destination member offsets shown above.
 */
export function writeCUserBlock(w: PacketWriter, user: UserRecord): void {
  w.writeString(user.username);
  w.writeU8(user.gender);
  w.writeU8(user.level);
  w.writeU32(user.exp);
  w.writeU16(user.rankFlag);
  w.writeU32(user.wins);
  w.writeU32(user.losses);
  w.writeU32(user.draws);
  w.writeU32(user.lucci);
  w.writeU8(user.grade);
  w.writeU16(0); // Read and discarded by CUser::sub_4A42E8.
  w.writeU16(0); // CUser member +0xC0; semantics not established here.
  w.writeU16(0); // CUser member +0xCC; semantics not established here.
  w.writeU16(0); // CUser member +0xD8; semantics not established here.
}

/**
 * Writes `CSlotAccessoryPacket::possible_ctor_or_dtor` (`0x00437484`) into a PacketWriter:
 *   u8 equippedCount
 *   if equippedCount > 0:
 *     u8 pad0
 *     equippedCount * [u8 slotType, u16 itemCode]
 *   u8 effectCount
 *   if effectCount > 0:
 *     u8 pad0
 *     effectCount * [u32, u32, u32]
 *   u8 flag29
 *   u8 flag30
 *   u8 flag31
 *   u32 val33
 *   u8 extraCount
 *   if extraCount > 0:
 *     extraCount * [u32, u32, u32]
 */
export function writeSlotAccessoryBlock(
  w: PacketWriter,
  state: WorldState,
  user: UserRecord | null
): void {
  const stock = user ? state.db.getUserStock(user.id).filter((s) => s.equipped > 0) : [];
  w.writeU8(stock.length);
  if (stock.length > 0) {
    w.writeU8(0);
    for (let i = 0; i < stock.length; i++) {
      w.writeU8(i);
      w.writeU16(stock[i]!.itemCode & 0xffff);
    }
  }
  w.writeU8(0); // effectCount = 0
  w.writeU8(0); // flag29
  w.writeU8(0); // flag30
  w.writeU8(0); // flag31
  w.writeU32(0); // val33
  w.writeU8(0); // extraCount = 0
}

/**
 * Builds S->C 102. In the Client's Stage-12 path, `CPrepareStage::sub_4DCF07` falls back to
 * `CSessionStage::sub_4B7DF2`; opcode 102 dispatches through vtable `+328` to
 * `CSlotStage::sub_4B89E4` (`0x004B89E4`). That handler constructs
 * `CSetPlayerOnPreparePacket` via `CSlotAccessoryPacket::possible_ctor_or_dtor_0`
 * (`0x004376E4`), which parses `CSetPlayerPacket` (`0x00437337`) and
 * `CSlotAccessoryPacket` (`0x00437484`).
 *
 * Wire order after the opcode:
 *   u8 slotIdx, u32 slotNetId, u8 selector, u8 packetField20, u8 packetField36, u8 discarded
 *   if selector != 0: u8 conditionalByte
 *   block(3) [stateFlags, charId, teamColor]
 *   CUser::sub_4A42E8 fields, u32 trailing CUser value, u8 wrapper byte
 *   if Client feature 15 is enabled: str + u32 extension fields
 *   CSlotAccessoryPacket
 * The third outer field is called `packetSelector` here only because it selects whether the
 * following conditional byte is present. `CSessionStage::sub_4B72C6` also uses nonzero versus
 * zero to enable or suppress join-notice work, but `CPrepareStage::sub_4D9A28` calls the base
 * slot/user installation path in either case. It therefore must not be described as an avatar
 * enable flag.
 */
export function buildSetPlayerPacket(
  state: WorldState,
  slot: RoomSlot,
  packetSelector: number = 1
): PacketWriter {
  const w = new PacketWriter(102);
  const user: UserRecord = slot.user ?? {
    id: 0,
    username: `player${slot.slotIdx}`,
    password: "",
    nickname: `player${slot.slotIdx}`,
    gender: 0,
    level: 1,
    exp: 0,
    lucci: 10000,
    cash: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    rankFlag: 0,
    grade: 0,
    equippedChar: slot.charId,
    guildName: "",
    guildMark: 0,
  };

  w.writeU8(slot.slotIdx);
  w.writeU32(slot.netSlotId);
  w.writeU8(packetSelector);
  w.writeU8(0); // packet field +20; semantics not established.
  w.writeU8(0); // packet field +36; passed to the Client's slot-state store.
  w.writeU8(0); // Read and discarded by CSetPlayerPacket constructor.
  if (packetSelector !== 0) {
    w.writeU8(0); // Conditional packet field +32; semantics not established.
  }

  const slotBlock = new Uint8Array([
    computeSlotStateFlags(slot),
    slot.charId & 0x3f,
    slot.teamColor & 0x1f,
  ]);
  w.writeBlock(slotBlock);

  writeCUserBlock(w, user);

  // The Client reads a u32, then passes it to a char-parameter setter at CUser+0xB4.
  // Its business meaning is not established by the parser.
  w.writeU32(0);
  w.writeU8(0xff); // Local builder placeholder for the Client's following wrapper byte.
  if (state.config.enabledFeatures.has(15)) {
    // The Client parses these two fields only when Taiwan/region feature 15 is enabled.
    w.writeString(user.guildName || "");
    w.writeU32(user.guildMark || 0);
  }

  writeSlotAccessoryBlock(w, state, slot.user);
  return w;
}

/**
 * Builds the Client-consumed S->C 103 payload:
 *   u8 slotIdx (`CPrepareStage::sub_4D4154`, after rereading the u16 opcode)
 *   u32 removedSlotNetId (`CSessionStage::sub_4B789B`, checked by `sub_5A799E` against slotIdx)
 *   u8 leaveReasonFlag (`CSessionStage::sub_4B789B`)
 * The recovered Client handlers consume these six payload bytes. The prior reconstruction's
 * trailing u16/u8 were not read by either handler and are omitted rather than assigned meanings.
 */
export function buildPlayerLeftSlotPacket(
  slotIdx: number,
  removedSlotNetId: number,
  leaveReasonFlag: number = 0
): PacketWriter {
  const w = new PacketWriter(ServerOpcode.PlayerLeftSlot);
  w.writeU8(slotIdx & 0xff);
  w.writeU32(removedSlotNetId >>> 0);
  w.writeU8(leaveReasonFlag & 0xff);
  return w;
}

/**
 * Builds S->C 104 (`CPrepareStage::sub_4DCF07` -> vtable `+352` -> `CPrepareStage::sub_4D9D08` at `0x004D9D08`):
 *   u8 slotIdx
 *   block(3) [stateFlags, charId, teamColor]
 *   u8 extraFlag
 * Clears `*(this + 1988)` when ready state (`0x04`) or open bit (`0x01`) changes.
 */
export function buildSlotStatePacket(slot: RoomSlot, extraFlag: number = 0): PacketWriter {
  const w = new PacketWriter(ServerOpcode.SlotStateSync);
  w.writeU8(slot.slotIdx);
  w.writeBlock(
    new Uint8Array([
      computeSlotStateFlags(slot),
      slot.charId & 0x3f,
      slot.teamColor & 0x1f,
    ])
  );
  w.writeU8(extraFlag);
  return w;
}

/**
 * Builds S->C 105 (`CPrepareStage::sub_4DCF07` -> `sub_4D4434` at `0x004D4434`):
 *   u8 ((slotIdx << 4) | (teamColor & 0x0F))
 *   u8 subFlag
 *   u8 ((otherSlotIdx << 4) | (otherSubFlag & 0x0F)) (0xF0 = none)
 * Clears `*(this + 1988) == 6` (set by C->S 88).
 */
export function buildTeamColorPacket(
  slotIdx: number,
  teamColor: number,
  subFlag: number = 0,
  otherSlotAndFlag: number = 0xf0
): PacketWriter {
  const w = new PacketWriter(ServerOpcode.TeamColorSync);
  w.writeU8(((slotIdx & 0x0f) << 4) | (teamColor & 0x0f));
  w.writeU8(subFlag & 0xff);
  w.writeU8(otherSlotAndFlag & 0xff);
  return w;
}

/**
 * Builds S->C 106 (`CPrepareStage::sub_4DCF07` -> vtable `+340` -> `CPrepareStage::sub_4D35DA` at `0x004D35DA`):
 *   u8 slotIdx
 *   u8 charId
 *   u8 extraFlag
 * Clears `*(this + 1988) == 5` (set by C->S 89).
 */
export function buildCharSelectPacket(
  slotIdx: number,
  charId: number,
  extraFlag: number = 0
): PacketWriter {
  const w = new PacketWriter(ServerOpcode.CharSelectSync);
  w.writeU8(slotIdx & 0xff);
  w.writeU8(charId & 0x3f);
  w.writeU8(extraFlag & 0xff);
  return w;
}

/**
 * Builds S->C 107 (`CPrepareStage::sub_4DCF07` -> vtable `+356` -> `CPrepareStage::sub_4D2888` at `0x004D2888`):
 *   u8 ((slotIdx << 4) | (openBit & 0x01))
 * Clears `*(this + 1988) == 2` (set by C->S 90).
 */
export function buildSlotOpenClosePacket(slotIdx: number, openBit: number): PacketWriter {
  const w = new PacketWriter(ServerOpcode.SlotOpenCloseSync);
  w.writeU8(((slotIdx & 0x0f) << 4) | (openBit & 0x01));
  return w;
}

/**
 * Builds S->C 108 (`CPrepareStagePractice::sub_4D05C1` at `0x004D05C1`):
 *   u8 slotIdx
 *   u16 handicapValue
 * Clears `*(this + 1988) == 8` (set by C->S 96).
 */
export function buildPracticeHandicapPacket(slotIdx: number, handicapValue: number): PacketWriter {
  const w = new PacketWriter(ServerOpcode.PracticeHandicapSync);
  w.writeU8(slotIdx & 0xff);
  w.writeU16(handicapValue & 0xffff);
  return w;
}

/**
 * Builds S->C 109 (`CPrepareStage::sub_4DCF07` -> `sub_4D27E4` at `0x004D27E4`):
 *   u16 mapId
 *   u32 mapOptionKey
 * Clears `*(this + 1988) == 1` (set by C->S 87).
 */
export function buildMapSelectPacket(mapId: number, mapOptionKey: number = 0): PacketWriter {
  const w = new PacketWriter(ServerOpcode.MapSelectSync);
  w.writeU16(mapId & 0xffff);
  w.writeU32(mapOptionKey >>> 0);
  return w;
}

/**
 * Builds S->C 93 (`CPrepareStage::sub_4DCF07` -> `sub_4DA6E0` -> `sub_4D6BC2` at `0x004D6BC2`):
 *   str roomName
 *   str password
 *   u8 maxPlayers
 *   u8 gameMode
 */
export function buildRoomSettingsPacket(room: GameRoom): PacketWriter {
  const w = new PacketWriter(ServerOpcode.RoomSettingsSync);
  w.writeString(room.name);
  w.writeString(room.password);
  w.writeU8(room.maxPlayers);
  w.writeU8(room.gameMode);
  return w;
}

/**
 * Builds S->C 112 (`CPrepareStage::sub_4DCF07` -> `sub_4D9F26` at `0x004D9F26`):
 *   u8 errCode (0 = ok, 1..7, 9, 13..15, 18 = start failure reason)
 * Clears `*(this + 1988) == 3` (set by C->S 93).
 */
export function buildStartGameErrorPacket(errCode: number): PacketWriter {
  const w = new PacketWriter(ServerOpcode.StartGameError);
  w.writeU8(errCode & 0xff);
  return w;
}

/**
 * Builds S->C 113 (`CPrepareStage::sub_4DCF07` -> `sub_4D9F8A` / `sub_4DA000` at `0x004D9F8A` Start Game transition):
 *   u32 randomSeed
 *   u16 mapIndex
 *   str mapFolderName (must match `sub_4E7DCE(dword_96EB1C, mapIndex)`)
 *   u32 modeSubParam
 *   u8 flag2002 (gameMode)
 *   u8 flag2041 (gameSubMode)
 *   u8 activePlayerCount
 *   For each active player:
 *     u8 slotIdx
 *     u8 spawnIdx
 *     u8 param2
 *     u8 param3
 *     u8 param4
 *     u32 userParam
 *   u8 hasEsfnStream (`0` or `1` + `[CISmartStream esfn.ssd]` via `sub_5CA65A`)
 */
export function buildStartGamePacket(
  state: WorldState,
  room: GameRoom,
  includeEsfnStream: boolean = false
): PacketWriter {
  const w = new PacketWriter(ServerOpcode.StartGameTransition);
  const mapEntry = state.resources.mapList[room.mapId] ?? state.resources.mapList[0];
  const mapFolderName = mapEntry?.folderName ?? "vet01";

  w.writeU32(room.randomSeed);
  w.writeU16(room.mapId);
  w.writeString(mapFolderName);
  w.writeU32(0); // modeSubParam
  w.writeU8(room.gameMode); // flag2002
  w.writeU8(room.gameSubMode); // flag2041

  const activeSlots = room.slots.filter((s) => s.occupied);
  w.writeU8(activeSlots.length);
  for (let idx = 0; idx < activeSlots.length; idx++) {
    const s = activeSlots[idx]!;
    w.writeU8(s.slotIdx);
    w.writeU8(idx); // spawnIdx
    w.writeU8(s.charId & 0x3f);
    w.writeU8(s.teamColor & 0x1f);
    w.writeU8(0);
    w.writeU32(0);
  }

  if (!includeEsfnStream) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    const ss = new SmartStreamWriter();
    ss.writeRaw(state.resources.ssdFiles.esfn.decompressed);
    w.writeSmartStream(ss, true);
  }
  return w;
}

/**
 * Builds only the local Prepare-stage S->C 115 body consumed by `sub_4D2190`:
 *   4 * u8, u16, u8
 * The names are structural fields; this builder does not assign Client business semantics.
 */
export function buildPrepareStageRoute115Packet(
  field0: number,
  field1: number,
  field2: number,
  field3: number,
  field4: number,
  field5: number
): PacketWriter {
  const w = new PacketWriter(ServerOpcode.PrepareStageRoute115);
  w.writeU8(field0 & 0xff);
  w.writeU8(field1 & 0xff);
  w.writeU8(field2 & 0xff);
  w.writeU8(field3 & 0xff);
  w.writeU16(field4 & 0xffff);
  w.writeU8(field5 & 0xff);
  return w;
}

/**
 * Apply the local server's start authorization and readiness policy, then begin a match.
 * Client `C->S 93` carries no `j[92]` room-context word; chief identity is resolved from the
 * sender's occupied room slot and `GameRoom.chiefSlotNetId` instead.
 */
function startMatchOnRoom(
  state: WorldState,
  session: ClientSession,
  room: GameRoom,
  includeEsfnStream: boolean = false,
  firstStartFieldCandidate?: number
): void {
  if (!hasSelectedRoomStageContext(state, session, room, [StageId.Prepare])) {
    logger.warn("Room", "Ignored match-start request without a selected game-channel Prepare room membership", {
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      stageId: formatStageId(session.stageId),
      roomNumber: room.roomNumber,
      responseSent: false,
      roomStateChanged: false,
    });
    return;
  }

  if (!sessionOwnsChiefSlot(session, room)) {
    logger.warn("Room", "Ignored match-start request from a session that does not own the chief slot", {
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      stageId: formatStageId(session.stageId),
      roomNumber: room.roomNumber,
      responseSent: false,
      roomStateChanged: false,
    });
    return;
  }

  // The client issues this request from CPrepareStage. Do not restart an active match or
  // accept a stale room-stage request after the server has advanced the session to Game.
  if (session.stageId !== StageId.Prepare || room.isPlaying) {
    logger.warn("Room", "Ignored match-start request outside an idle Prepare-stage room", {
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      stageId: formatStageId(session.stageId),
      roomNumber: room.roomNumber,
      roomIsPlaying: room.isPlaying,
      responseSent: false,
      roomStateChanged: false,
    });
    return;
  }

  // Check if all occupied non-chief player slots are ready. Error 2 maps to the
  // Client's `AllMustReady` message; a non-chief denial has no confirmed error code.
  const unreadyNonChief = room.slots.some(
    (slot) => slot.occupied && slot.netSlotId !== room.chiefSlotNetId && !slot.ready
  );
  if (unreadyNonChief) {
    session.sendPacket(buildStartGameErrorPacket(2)); // Client error 2 = AllMustReady
    return;
  }

  // Local-only interpretation: treat field 0 as a map-index candidate only when it resolves
  // into the loaded Client map list. The Client writer's field semantics are not established.
  if (
    firstStartFieldCandidate !== undefined &&
    firstStartFieldCandidate < state.resources.mapList.length
  ) {
    room.mapId = firstStartFieldCandidate;
  }

  // Send S->C 112 result 0 (ok)
  session.sendPacket(buildStartGameErrorPacket(0));

  // Mark room playing and reset per-slot match flags
  room.isPlaying = true;
  room.startTick = Date.now() >>> 0;
  state.resetRoomUdpEndpoints(room);
  for (const s of room.slots) {
    if (s.occupied) {
      s.loadedGame = false;
      s.alive = true;
      s.trapped = false;
      s.kills = 0;
      s.saves = 0;
      if (s.session) {
        s.session.stageId = StageId.Game;
      }
    }
  }

  // Broadcast S->C 113 (`sub_4D9F8A`)
  state.broadcastToRoom(room, () => buildStartGamePacket(state, room, includeEsfnStream));
}

/**
 * Handles CPrepareStage C->S room opcodes (`0x004CFA00` - `0x004DCF07`).
 */
export function handlePrepareRoomPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  if (session.currentRoomNumber === null) {
    return;
  }
  const room = state.rooms.get(session.currentRoomNumber);
  if (!room) {
    return;
  }

  switch (opcode) {
    case ClientOpcode.UpdateRoomSettings: {
      // `sub_4D688D` writes strings plus two u8 values; `sub_4D696C` writes only the two strings.
      const payloadBytes = reader.remaining;
      const parsed = parseExactPayload(reader, (probe) => {
        const name = readCompleteString(probe);
        if (name === null) return null;
        const password = readCompleteString(probe);
        if (password === null) return null;
        if (probe.remaining === 0) return { name, password, maxPlayers: null, gameMode: null };
        if (probe.remaining !== 2) return null;
        return { name, password, maxPlayers: probe.readU8(), gameMode: probe.readU8() };
      });
      if (
        !parsed ||
        (parsed.maxPlayers !== null && (parsed.maxPlayers < 1 || parsed.maxPlayers > 8)) ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare]) ||
        !sessionOwnsChiefSlot(session, room)
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "exactly str name + str password, optionally followed by u8 maxPlayers (1..8) + u8 mode; selected-channel Prepare chief member",
          "Ignored malformed or unauthorized C->S 84 room-settings update"
        );
        break;
      }

      // Both Client writer variants are retained: the shorter form updates only strings.
      // Field widths/order are Client evidence; authorization and GameRoom mapping are local policy.
      room.name = parsed.name || room.name;
      room.password = parsed.password;
      room.hasPassword = parsed.password.length > 0;
      if (parsed.maxPlayers !== null && parsed.gameMode !== null) {
        room.maxPlayers = parsed.maxPlayers;
        room.gameMode = parsed.gameMode;
      }
      state.broadcastToRoom(room, () => buildRoomSettingsPacket(room));
      break;
    }

    case ClientOpcode.ToggleReady: {
      // Recovered Client writers are distinct exact forms: `sub_4B2350` writes `[u8 state]`,
      // while Prepare `sub_4D5B2F` writes `[u8 state, u32 ESFN checksum]`.
      const payloadBytes = reader.remaining;
      const parsed = parseExactPayload(reader, (probe) => {
        if (probe.remaining === 1) return { readyState: probe.readU8(), esfnChecksum: null };
        if (probe.remaining !== 5) return null;
        return { readyState: probe.readU8(), esfnChecksum: probe.readU32() };
      });
      const localSlot = getSessionRoomSlot(session, room, 0);
      if (
        !parsed ||
        parsed.readyState > 1 ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare]) ||
        !localSlot
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "exact u8 readyState (0/1), optionally followed by u32 ESFN checksum; selected-channel Prepare member with local slot 0",
          "Ignored malformed or out-of-context C->S 86 ready-state update"
        );
        break;
      }
      void parsed.esfnChecksum; // Client CRC field is not authenticated or interpreted locally.
      localSlot.slot.ready = parsed.readyState !== 0;
      state.broadcastToRoom(room, () => buildSlotStatePacket(localSlot.slot));
      break;
    }

    case ClientOpcode.SelectMap: {
      // Recovered C->S 87 writers are `[u16 mapId]` (`sub_4B247D`) and
      // `[u16 mapId, u32 mapKey]` (`sub_4D1E59`). Requiring chief ownership is a local
      // authorization policy; it is not asserted as recovered official-server behavior.
      if (
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare]) ||
        !sessionOwnsChiefSlot(session, room)
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          reader.remaining,
          "selected-channel Prepare member owning chief slot",
          "Ignored C->S 87 map-selection request outside the local chief policy"
        );
        break;
      }
      if (reader.remaining !== 2 && reader.remaining !== 6) {
        logger.warn("Room", "Ignored malformed C->S 87 map-selection packet", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes: reader.remaining,
          expectedPayloadBytes: [2, 6],
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }

      const hasMapKey = reader.remaining === 6;
      const mapId = reader.readU16();
      const mapKey = hasMapKey ? reader.readU32() : 0;
      if (mapId >= state.resources.mapList.length) {
        logger.warn("Room", "Ignored C->S 87 map ID outside the loaded Client map list", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          mapId,
          mapListLength: state.resources.mapList.length,
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }
      room.mapId = mapId;
      state.broadcastToRoom(room, () => buildMapSelectPacket(room.mapId, mapKey));
      break;
    }

    case ClientOpcode.SelectTeamColor: {
      // `sub_4D2A67` (Prepare) and `sub_4B8475` (CSlotStage) both write the exact packed u8;
      // this room adapter applies it only in selected-channel Prepare context.
      const payloadBytes = reader.remaining;
      if (
        payloadBytes !== 1 ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare])
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "one packed u8; selected-channel Prepare room member",
          "Ignored malformed or out-of-context C->S 88 team-color request"
        );
        break;
      }
      const packed = reader.readU8();
      const localIdx = (packed >>> 4) & 0x0f;
      const teamColor = packed & 0x0f;
      const localSlot = getSessionRoomSlot(session, room, localIdx);
      if (!localSlot) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "packed localIdx must identify an occupied slot owned by this session",
          "Ignored C->S 88 with a local-player index not owned by the session"
        );
        break;
      }
      localSlot.slot.teamColor = teamColor;
      state.broadcastToRoom(room, () => buildTeamColorPacket(localSlot.slotIdx, localSlot.slot.teamColor));
      state.broadcastToRoom(room, () => buildSlotStatePacket(localSlot.slot));
      break;
    }

    case ClientOpcode.SelectCharacter: {
      // `sub_4B8065`, Practice `sub_4D0813`, and Prepare `sub_4D2AFD` write the same exact
      // `[u8 localIdx, u8 charId]` form; the local room adapter below remains Prepare-only.
      const payloadBytes = reader.remaining;
      const parsed = parseExactPayload(reader, (probe) => {
        if (probe.remaining !== 2) return null;
        return { localIdx: probe.readU8(), charId: probe.readU8() };
      });
      if (!parsed || !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare])) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "u8 localIdx, u8 charId; selected-channel Prepare room member",
          "Ignored malformed or out-of-context C->S 89 character-selection request"
        );
        break;
      }
      const localSlot = getSessionRoomSlot(session, room, parsed.localIdx);
      if (!localSlot) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "localIdx must identify an occupied slot owned by this session",
          "Ignored C->S 89 with a local-player index not owned by the session"
        );
        break;
      }
      localSlot.slot.charId = parsed.charId & 0x3f;
      session.equippedCharIds[parsed.localIdx] = localSlot.slot.charId;
      if (localSlot.slot.user) {
        localSlot.slot.user.equippedChar = localSlot.slot.charId;
        state.db.updateEquippedChar(localSlot.slot.user.id, localSlot.slot.charId);
      }
      state.broadcastToRoom(room, () => buildCharSelectPacket(localSlot.slotIdx, localSlot.slot.charId));
      state.broadcastToRoom(room, () => buildSlotStatePacket(localSlot.slot));
      break;
    }

    case ClientOpcode.ToggleSlotOpen: {
      // `sub_4B84FF` (CSlotStage) and `sub_4D2BB8` (Prepare) write one packed byte: high nibble
      // slot index, low nibble desired state. This local adapter applies it only in Prepare;
      // setting the requested state (not toggling) is a reconstruction interpretation.
      const payloadBytes = reader.remaining;
      if (
        payloadBytes !== 1 ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare]) ||
        !sessionOwnsChiefSlot(session, room)
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "one packed u8; selected-channel Prepare member owning chief slot",
          "Ignored malformed or unauthorized C->S 90 slot-open request"
        );
        break;
      }
      const packed = reader.readU8();
      const targetSlotIdx = (packed >>> 4) & 0x0f;
      const requestedOpenState = packed & 0x0f;
      const targetSlot = room.slots[targetSlotIdx];
      if (targetSlotIdx >= room.slots.length || requestedOpenState > 1 || !targetSlot || targetSlot.occupied) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "slot index in room bounds, openState 0/1, unoccupied target",
          "Ignored C->S 90 with an invalid target slot or open-state value"
        );
        break;
      }
      const requestedOpen = requestedOpenState !== 0;
      if (targetSlot.open !== requestedOpen) {
        targetSlot.open = requestedOpen;
        room.maxPlayers = room.slots.filter((slot) => slot.open).length;
        state.broadcastToRoom(room, () => buildSlotOpenClosePacket(targetSlotIdx, requestedOpen ? 1 : 0));
        state.broadcastToRoom(room, () => buildSlotStatePacket(targetSlot));
      }
      break;
    }

    case ClientOpcode.KickPlayer: {
      // `CPrepareStage::sub_4DAE65` sends `[u32 targetSlotNetId, u8 hasSuperChiefItem]`.
      // Chief-only Prepare context is local authorization policy, not a recovered official rule.
      if (
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare]) ||
        !sessionOwnsChiefSlot(session, room)
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          reader.remaining,
          "u32 targetSlotNetId, u8 flag; selected-channel Prepare member owning chief slot",
          "Ignored C->S 91 outside the local chief-only kick policy"
        );
        break;
      }
      if (reader.remaining !== 5) {
        logger.warn("Room", "Ignored malformed C->S 91 kick-player packet", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          payloadBytes: reader.remaining,
          expectedPayloadBytes: 5,
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }
      const targetNetId = reader.readU32();
      const hasSuperChiefItem = reader.readU8();
      const targetSlot = room.slots.find((slot) => slot.occupied && slot.netSlotId === targetNetId);
      if (targetSlot && targetSlot.session && targetSlot.session !== session) {
        const kickedSession = targetSlot.session;
        const kickedSlotIdx = targetSlot.slotIdx;
        const kickedSlotNetId = targetSlot.netSlotId;
        const removedSlotNetIds = new Map(
          room.slots
            .filter((slot) => slot.occupied && slot.session === kickedSession)
            .map((slot) => [slot.slotIdx, slot.netSlotId] as const)
        );
        const { removedSlots } = state.leaveRoom(kickedSession);

        // The Client base handler checks [slotIdx, removedSlotNetId, hasSuperChiefItem];
        // CPrepareStage rereads the opcode and slotIdx to clear its local slot. One matching
        // notice removes the selected local user and takes the kicked multi-local session to Lobby.
        kickedSession.sendPacket(
          buildPlayerLeftSlotPacket(kickedSlotIdx, kickedSlotNetId, hasSuperChiefItem)
        );
        for (const removedSlotIdx of removedSlots) {
          const removedSlotNetId = removedSlotNetIds.get(removedSlotIdx);
          if (removedSlotNetId === undefined) continue;
          state.broadcastToRoom(room, () =>
            buildPlayerLeftSlotPacket(removedSlotIdx, removedSlotNetId, hasSuperChiefItem)
          );
        }
      }
      break;
    }

    case ClientOpcode.BanVoteResponse: {
      // `sub_4D555E`: exact `[u32 targetNetId, u8 agreeFlag]`.
      const payloadBytes = reader.remaining;
      const parsed = parseExactPayload(reader, (probe) => {
        if (probe.remaining !== 5) return null;
        return { targetNetId: probe.readU32(), agreeFlag: probe.readU8() };
      });
      if (
        !parsed ||
        parsed.agreeFlag > 1 ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare])
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "u32 targetNetId, u8 agreeFlag (0/1); selected-channel Prepare room member",
          "Ignored malformed or out-of-context C->S 92 ban-vote response"
        );
        break;
      }
      const targetSlot = room.slots.find(
        (slot) => slot.occupied && slot.netSlotId === parsed.targetNetId
      );
      if (!targetSlot) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "targetNetId must identify an occupied slot in the same room",
          "Ignored C->S 92 with a target that is not an occupied room slot"
        );
        break;
      }
      const w111 = new PacketWriter(ServerOpcode.BanVoteSync);
      w111.writeU8(parsed.agreeFlag ? 1 : 5); // Local S->C mapping; no authoritative vote policy is established.
      w111.writeString(targetSlot.user?.username ?? "");
      state.broadcastToRoom(room, () => w111);
      break;
    }

    case ClientOpcode.StartMatch: {
      // `sub_4D5DB1` + `sub_4DF2EC` builds a 14-byte prefix, an optional
      // 0/1/5-byte map-check suffix, then appends the 4-byte ESFN checksum.
      // Consequently the recovered Client writer's payload sizes are 18, 19, or 23 bytes.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 18 && payloadBytes !== 19 && payloadBytes !== 23) {
        logger.warn("Room", "Ignored malformed C->S 93 start-match packet", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          expectedPayloadBytes: [18, 19, 23],
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }

      const firstStartFieldCandidate = reader.readU32();
      reader.readU32(); // Opaque Client u32 field; not independently validated here.
      reader.readU8(); // Client writer's zero-valued field.
      reader.readU32(); // Opaque Client u32 field; not independently validated here.
      reader.readU8(); // Client flag byte; meaning unresolved and not interpreted locally.

      const mapCheckSuffixBytes = payloadBytes - 18;
      if (mapCheckSuffixBytes === 1) {
        reader.readU8(); // Opaque Client map-check status.
      } else if (mapCheckSuffixBytes === 5) {
        reader.readU8(); // Opaque Client map-check status.
        reader.readU32(); // Client map-file CRC; not independently validated here.
      }

      const esfnCrc = reader.readU32(); // `*(dword_96EB20 + 136)`
      const esfnEntry = state.resources.ssdFiles.esfn;
      const includeEsfn =
        esfnCrc !== 0 &&
        esfnCrc !== esfnEntry.adler32Zero &&
        esfnCrc !== esfnEntry.diskAdler32Zero;
      startMatchOnRoom(state, session, room, includeEsfn, firstStartFieldCandidate);
      break;
    }

    case ClientOpcode.ChangeRoomPassword: {
      // Apply only the exact Prepare/Practice Client writer. Opcode 94 also appears in other
      // stage contexts, whose payload and result policy are not treated as this operation.
      const payloadBytes = reader.remaining;
      const newPassword = parseExactPayload(reader, (probe) => readCompleteString(probe));
      if (newPassword === null) {
        logger.warn("Room", "Ignored malformed or non-exact C->S 94 body", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          expectedPayloadSchema: "exactly one str",
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }
      if (
        !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare, StageId.Practice]) ||
        !sessionOwnsChiefSlot(session, room)
      ) {
        logger.info("PacketAudit", "Observed C->S 94 outside the local Prepare password-update policy", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          payloadSchema: "exactly one str; content withheld",
          responseAssociation: "UNKNOWN outside the local Prepare/Practice policy",
          responseSent: false,
          roomStateChanged: false,
          databaseMutation: false,
        });
        break;
      }
      room.password = newPassword;
      room.hasPassword = newPassword.length > 0;
      const w231 = new PacketWriter(ServerOpcode.RoomPasswordChangeResult);
      w231.writeU8(1); // Local success choice; official status semantics are UNKNOWN.
      session.sendPacket(w231);
      state.broadcastToRoom(room, () => buildRoomSettingsPacket(room));
      break;
    }

    case ClientOpcode.ClientPacket95: {
      // This is a local Prepare-only adapter for the exact five-byte form. The six Client
      // writers' shared width, and the independent Prepare/Game/Exchange 115 parsers, do not
      // establish common field meanings or a common request/reply relationship.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 5 || !hasSelectedRoomStageContext(state, session, room, [StageId.Prepare])) {
        logger.warn("Room", "Ignored malformed or out-of-context C->S 95 ClientPacket95 body", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          expectedPayloadBytes: 5,
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }
      const field0 = reader.readU8();
      const field1 = reader.readU8();
      const field2 = reader.readU8();
      const field3 = reader.readU16();
      // Local adapter policy copies field1 into two Prepare-115 byte positions and appends
      // field5=1. These field mappings/values are not established Client or official-server semantics.
      state.broadcastToRoom(room, () =>
        buildPrepareStageRoute115Packet(field0, field1, field1, field2, field3, 1)
      );
      break;
    }

    case ClientOpcode.PracticeHandicap: {
      // `sub_4D0627`: exact `[u8 slotIdx, u8 delta]` -> local S->C 108 mapping.
      const payloadBytes = reader.remaining;
      const parsed = parseExactPayload(reader, (probe) => {
        if (probe.remaining !== 2) return null;
        return { slotIdx: probe.readU8(), delta: probe.readU8() };
      });
      if (
        !parsed ||
        parsed.slotIdx >= room.slots.length ||
        !room.slots[parsed.slotIdx]?.occupied ||
        !hasSelectedRoomStageContext(state, session, room, [StageId.Practice])
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "u8 occupied room slotIdx, u8 delta; selected-channel Practice room member",
          "Ignored malformed or out-of-context C->S 96 practice-handicap request"
        );
        break;
      }
      state.broadcastToRoom(room, () => buildPracticeHandicapPacket(parsed.slotIdx, parsed.delta));
      break;
    }

    case ClientOpcode.ContextualClientPacket98: {
      // The Shop-success caller `sub_52A129` emits u8(1) only after a successful reply and
      // only for stage IDs 12/19/17/18 (`sub_4B8EE9`). UserMarket's distinct u8(0) caller is
      // routed to shopHandler; equal width does not establish a shared operation. The local
      // Shop-entry transition below is reconstruction policy, not official Server behavior.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 1) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "exactly u8(1) in a selected-channel room stage {Prepare, Practice, Chatting, Exchange}",
          "Ignored malformed C->S 98 Shop-entry body"
        );
        break;
      }
      const fieldValue = reader.readU8();
      if (
        fieldValue !== 1 ||
        !hasSelectedRoomStageContext(state, session, room, [
          StageId.Prepare,
          StageId.Practice,
          StageId.Chatting,
          StageId.Exchange,
        ])
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "u8(1); selected-channel room member in Prepare, Practice, Chatting, or Exchange",
          "Ignored C->S 98 outside the local Shop-entry policy"
        );
        break;
      }
      const localSlot = getSessionRoomSlot(session, room, 0);
      if (!localSlot) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "session local-player slot 0 must remain occupied in the current room",
          "Ignored C->S 98 without a verified local room slot"
        );
        break;
      }
      // Local reconstruction policy: mark this slot as in-Shop and clear ready. Neither
      // this mapping nor the chosen response sequence is established official Server behavior.
      localSlot.slot.inShop = true;
      localSlot.slot.ready = false;
      state.broadcastToRoom(room, () => buildSlotStatePacket(localSlot.slot));
      session.stageId = StageId.Shop;
      session.sendPacket(buildShopInitPacket16(state, session));
      session.sendPacket(buildUserStockPacket(state, session));
      break;
    }

    case ClientOpcode.ExchangeAction: {
      // `CExchangeStage::sub_558142`: state 2/5 are one byte; state 3 adds a u32,
      // u8 count, then count*(u32 stockId, 16-byte SYSTEMTIME). Treat these as Client
      // writer forms only; no trusted trade transaction or official reply policy is recovered.
      const payloadBytes = reader.remaining;
      const parsedExchange = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 1) return null;
        const exchangeState = probe.readU8();
        if (exchangeState !== 3) {
          return probe.remaining === 0 ? { exchangeState, offeredItemCount: 0 } : null;
        }
        if (probe.remaining < 5) return null;
        probe.readU32(); // Client trade amount candidate; never applied locally.
        const itemCount = probe.readU8();
        if (probe.remaining !== itemCount * 20) return null;
        for (let index = 0; index < itemCount; index++) {
          probe.readU32();
          probe.readBlock(16); // SYSTEMTIME bytes, retained only as opaque input.
        }
        return { exchangeState, offeredItemCount: itemCount };
      });
      if (!parsedExchange) {
        logger.warn("Exchange", "Ignored malformed or non-exact C->S 100 exchange body", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          expectedPayloadSchema:
            "u8 state; if state==3, u32 opaque + u8 count + count*(u32 stockId + 16B SYSTEMTIME), exact",
          responseSent: false,
          roomStateChanged: false,
          databaseMutation: false,
        });
        break;
      }
      if (![2, 3, 5].includes(parsedExchange.exchangeState)) {
        logger.warn("Exchange", "Ignored C->S 100 state without a recovered Client writer", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          exchangeState: parsedExchange.exchangeState,
          responseSent: false,
          roomStateChanged: false,
          databaseMutation: false,
        });
        break;
      }
      if (!hasSelectedRoomStageContext(state, session, room, [StageId.Exchange])) {
        logger.warn("Exchange", "Ignored C->S 100 outside the selected-channel Exchange context", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          responseSent: false,
          roomStateChanged: false,
          databaseMutation: false,
        });
        break;
      }
      logger.info("PacketAudit", "Observed exact C->S 100 exchange action without trade validation", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        roomNumber: room.roomNumber,
        payloadBytes,
        exchangeState: parsedExchange.exchangeState,
        offeredItemCount: parsedExchange.offeredItemCount,
        responseAssociation: "UNKNOWN; Client receive parsers do not establish official server reply policy",
        responseSent: false,
        roomStateChanged: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.ExchangePassCheck: {
      // Validate the exact Client string container without exposing it. No trusted exchange
      // password store or official verification/result policy is recovered.
      const payloadBytes = reader.remaining;
      const exactPassword = parseExactPayload(reader, (probe) => readCompleteString(probe));
      if (exactPassword === null) {
        logger.warn("Exchange", "Ignored malformed or non-exact C->S 101 pass-check body", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          expectedPayloadSchema: "exactly one str; content withheld",
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      if (!hasSelectedRoomStageContext(state, session, room, [StageId.Exchange])) {
        logger.warn("Exchange", "Observed C->S 101 outside the selected-channel Exchange context", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          roomNumber: room.roomNumber,
          payloadBytes,
          passwordLogged: false,
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      // Avoid using the parsed plaintext value after exact framing has been validated.
      void exactPassword;
      logger.warn("Exchange", "Ignored pass check because validation is not implemented", {
        sessionId: session.sessionId,
        roomNumber: room.roomNumber,
        payloadBytes,
        passwordLogged: false,
        responseSent: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.LeaveRoom: {
      // `CPrepareStage::sub_4D1F0F` requests StageId.Lobby locally before sending empty C->S 78.
      // Require a real selected-channel room membership; the stage may already have advanced on
      // the Client, so this local leave policy accepts known room-associated stages only.
      const payloadBytes = reader.remaining;
      if (
        payloadBytes !== 0 ||
        !hasSelectedRoomStageContext(state, session, room, [
          StageId.Lobby,
          StageId.Prepare,
          StageId.Shop,
          StageId.Game,
          StageId.Exchange,
          StageId.Practice,
        ])
      ) {
        logRejectedRoomPacket(
          session,
          room,
          opcode,
          payloadBytes,
          "empty body; selected-channel session owns an occupied slot in this room",
          "Ignored malformed or out-of-context C->S 78 leave-room request"
        );
        break;
      }
      // Snapshot each local slot's identity before leaveRoom clears the server's slot records.
      // Do not echo S->C 9: its generic GameServer fallback treats the u32 as a dump-file offset.
      const removedSlotNetIds = new Map(
        room.slots
          .filter((slot) => slot.occupied && slot.session === session)
          .map((slot) => [slot.slotIdx, slot.netSlotId] as const)
      );
      const { room: leftRoom, removedSlots, roomDeleted } = state.leaveRoom(session);

      if (leftRoom && !roomDeleted) {
        for (const removedSlotIdx of removedSlots) {
          const removedSlotNetId = removedSlotNetIds.get(removedSlotIdx);
          if (removedSlotNetId === undefined) continue;
          state.broadcastToRoom(leftRoom, () =>
            buildPlayerLeftSlotPacket(removedSlotIdx, removedSlotNetId, 0)
          );
        }
      }
      break;
    }
  }
}

export const handleRoomPacket = handlePrepareRoomPacket;
