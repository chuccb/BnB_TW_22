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

function sessionOwnsChiefSlot(session: ClientSession, room: GameRoom): boolean {
  return room.slots.some(
    (slot) => slot.occupied && slot.session === session && slot.netSlotId === room.chiefSlotNetId
  );
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
 * Writes `CUser::sub_4A42E8` (`0x004A42E8`) into a PacketWriter:
 *   str username
 *   u8 gender
 *   u8 level
 *   u32 exp
 *   u16 rankFlag
 *   u32 wins
 *   u32 losses
 *   u32 draws
 *   u32 lucci
 *   u8 grade
 *   u16 pad0
 *   u16 stat1
 *   u16 stat2
 *   u16 stat3
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
  w.writeU16(0);
  w.writeU16(0);
  w.writeU16(0);
  w.writeU16(0);
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
 * Builds S->C 102 (`CSessionStage::sub_4B7DF2` case `0x66` -> vtable `+328` -> `CSlotStage::sub_4B89E4` at `0x004B89E4`):
 *   Constructs `CSetPlayerOnPreparePacket` (`CSlotAccessoryPacket::possible_ctor_or_dtor_0` at `0x004376E4`):
 *   `CSetPlayerPacket` (`0x00437337`) + `CSlotAccessoryPacket` (`0x00437484`)
 */
export function buildSetPlayerPacket(
  state: WorldState,
  slot: RoomSlot,
  joinAnnounce: number = 1
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
  w.writeU8(joinAnnounce);
  w.writeU8(0); // flag20
  w.writeU8(0); // flag36
  w.writeU8(0); // unused
  if (joinAnnounce !== 0) {
    w.writeU8(0); // extraJoinFlag
  }

  const slotBlock = new Uint8Array([
    computeSlotStateFlags(slot),
    slot.charId & 0x3f,
    slot.teamColor & 0x1f,
  ]);
  w.writeBlock(slotBlock);

  writeCUserBlock(w, user);

  w.writeU32(0); // userFlags
  w.writeU8(0xff); // coupleSlotIdx (0xFF = none)
  w.writeString(user.guildName || "");
  w.writeU32(user.guildMark || 0);

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
  const senderOwnsChiefSlot = room.slots.some(
    (slot) =>
      slot.occupied &&
      slot.session === session &&
      slot.netSlotId === room.chiefSlotNetId
  );
  if (!senderOwnsChiefSlot) {
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
      if (reader.remaining >= 2) {
        room.name = reader.readString() || room.name;
      }
      if (reader.remaining >= 2) {
        room.password = reader.readString();
        room.hasPassword = room.password.length > 0;
      }
      if (reader.remaining >= 2) {
        room.maxPlayers = reader.readU8();
        room.gameMode = reader.readU8();
      } else if (reader.remaining >= 1) {
        room.gameMode = reader.readU8();
      }
      state.broadcastToRoom(room, () => buildRoomSettingsPacket(room));
      break;
    }

    case ClientOpcode.ToggleReady: {
      // `sub_4D5B2F`: `[u8 readyState, u32 esfnChecksum]`
      const arg0 = reader.remaining >= 1 ? reader.readU8() : 1;
      const slotIdx = session.roomSlotIndices[0] ?? 0;
      const slot = room.slots[slotIdx];
      if (slot && slot.occupied) {
        if (reader.remaining >= 4) {
          reader.readU32(); // esfnChecksum (`dword_96EB20 + 136`)
          slot.ready = arg0 !== 0;
        } else {
          slot.ready = !slot.ready;
        }
        state.broadcastToRoom(room, () => buildSlotStatePacket(slot));
      }
      break;
    }

    case ClientOpcode.SelectMap: {
      // Recovered C->S 87 writers are `[u16 mapId]` (`sub_4B247D`) and
      // `[u16 mapId, u32 mapKey]` (`sub_4D1E59`). An empty packet is not a start request.
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
      // `sub_4D2A67`: `[u8 ((localIdx << 4) | (teamColor & 0x0F))]`
      if (reader.remaining === 1) {
        const packed = reader.readU8();
        const localIdx = (packed >>> 4) & 0x0f;
        const teamColor = packed & 0x0f;
        const slotIdx = session.roomSlotIndices[localIdx] ?? session.roomSlotIndices[0] ?? 0;
        const slot = room.slots[slotIdx];
        if (slot && slot.occupied) {
          slot.teamColor = teamColor & 0x1f;
          state.broadcastToRoom(room, () => buildTeamColorPacket(slotIdx, slot.teamColor));
          state.broadcastToRoom(room, () => buildSlotStatePacket(slot));
        }
      } else {
        const localIdx = reader.remaining >= 1 ? reader.readU8() : 0;
        const charId = reader.remaining >= 1 ? reader.readU8() : 0;
        const slotIdx = session.roomSlotIndices[localIdx] ?? session.roomSlotIndices[0] ?? 0;
        const slot = room.slots[slotIdx];
        if (slot && slot.occupied) {
          slot.charId = charId & 0x3f;
          session.equippedCharIds[localIdx] = slot.charId;
          if (slot.user) {
            slot.user.equippedChar = slot.charId;
            state.db.updateEquippedChar(slot.user.id, slot.charId);
          }
          state.broadcastToRoom(room, () => buildCharSelectPacket(slotIdx, slot.charId));
          state.broadcastToRoom(room, () => buildSlotStatePacket(slot));
        }
      }
      break;
    }

    case ClientOpcode.SelectCharacter: {
      // `sub_4D2AFD`: `[u8 localIdx, u8 charId]`
      const localIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const charId = reader.remaining >= 1 ? reader.readU8() : 0;
      const slotIdx = session.roomSlotIndices[localIdx] ?? session.roomSlotIndices[0] ?? 0;
      const slot = room.slots[slotIdx];
      if (slot && slot.occupied) {
        slot.charId = charId & 0x3f;
        session.equippedCharIds[localIdx] = slot.charId;
        if (slot.user) {
          slot.user.equippedChar = slot.charId;
          state.db.updateEquippedChar(slot.user.id, slot.charId);
        }
        state.broadcastToRoom(room, () => buildCharSelectPacket(slotIdx, slot.charId));
        state.broadcastToRoom(room, () => buildSlotStatePacket(slot));
      }
      break;
    }

    case ClientOpcode.ToggleSlotOpen: {
      // `sub_4D2BB8`: `[u8 ((slotIdx << 4) | (openState & 0x0F))]`
      const raw = reader.remaining >= 1 ? reader.readU8() : 0;
      const targetSlotIdx = raw > 7 ? (raw >>> 4) & 0x0f : raw;
      const targetSlot = room.slots[targetSlotIdx];
      if (targetSlot && !targetSlot.occupied) {
        targetSlot.open = !targetSlot.open;
        room.maxPlayers = room.slots.filter((s) => s.open).length;
        state.broadcastToRoom(room, () =>
          buildSlotOpenClosePacket(targetSlotIdx, targetSlot.open ? 1 : 0)
        );
        state.broadcastToRoom(room, () => buildSlotStatePacket(targetSlot));
      }
      break;
    }

    case ClientOpcode.KickPlayer: {
      // `CPrepareStage::sub_4DAE65` sends `[u32 targetSlotNetId, u8 hasSuperChiefItem]`.
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
      // `sub_4D555E`: `[u32 targetNetId, u8 agreeFlag]`
      const targetNetId = reader.remaining >= 4 ? reader.readU32() : 0;
      const agreeFlag = reader.remaining >= 1 ? reader.readU8() : 0;
      const targetSlot = room.slots.find((s) => s.occupied && s.netSlotId === targetNetId);
      const targetName = targetSlot?.user?.username ?? "";
      const w111 = new PacketWriter(ServerOpcode.BanVoteSync);
      w111.writeU8(agreeFlag ? 1 : 5);
      w111.writeString(targetName);
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
        session.connectionKind !== "game" ||
        !session.channelSelected ||
        (session.stageId !== StageId.Prepare && session.stageId !== StageId.Practice) ||
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
      if (payloadBytes !== 5) {
        logger.warn("Room", "Ignored malformed C->S 95 ClientPacket95 body", {
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
      // `sub_4D0627` is the recovered writer for C->S 96: `[u8 slotIdx, u8 delta]` -> S->C 108.
      if (reader.remaining !== 2) {
        logger.warn("Room", "Ignored malformed C->S 96 practice-handicap packet", {
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          payloadBytes: reader.remaining,
          expectedPayloadBytes: 2,
          responseSent: false,
          roomStateChanged: false,
        });
        break;
      }

      const slotIdx = reader.readU8();
      const delta = reader.readU8();
      state.broadcastToRoom(room, () => buildPracticeHandicapPacket(slotIdx, delta));
      break;
    }

    case ClientOpcode.RoomAux98: {
      // Shared Client writer `sub_4B8E1D` sends one u8; the UserMarket `sub_5723F6` path also sends 0.
      // This room handler applies it as inShopFlag only after the no-room guard above.
      const inShopFlag = reader.remaining >= 1 ? reader.readU8() : 0;
      const slotIdx = session.roomSlotIndices[0] ?? 0;
      const slot = room.slots[slotIdx];
      if (slot && slot.occupied) {
        slot.inShop = inShopFlag !== 0;
        if (slot.inShop) {
          slot.ready = false;
        }
        state.broadcastToRoom(room, () => buildSlotStatePacket(slot));
      }
      if (inShopFlag !== 0) {
        session.stageId = StageId.Shop;
        session.sendPacket(buildShopInitPacket16(state, session));
        session.sendPacket(buildUserStockPacket(state, session));
      } else {
        session.stageId = StageId.Prepare;
        const w99 = new PacketWriter(ServerOpcode.ShopLeaveReturnStage);
        w99.writeU16(StageId.Prepare);
        session.sendPacket(w99);
      }
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
      if (
        session.connectionKind !== "game" ||
        !session.channelSelected ||
        session.stageId !== StageId.Exchange
      ) {
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
      if (
        session.connectionKind !== "game" ||
        !session.channelSelected ||
        session.stageId !== StageId.Exchange
      ) {
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
