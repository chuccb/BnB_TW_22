import { ServerOpcode } from "../protocol/opcodes.ts";
import { PacketWriter } from "../protocol/primitives.ts";
import type { GameRoom, WorldState } from "../state/worldState.ts";

/**
 * Lobby room-list protocol (S->C 82/84/85/86) builders and the server-side announcement
 * helpers that keep every Lobby-stage viewer's room list in sync with `WorldState` room
 * mutations (create / join / leave / kick / game start / match end / disconnect).
 *
 * Kept in its own module so `lobbyHandler`, `roomHandler`, `gameHandler` and
 * `network/server` can all announce without import cycles (lobbyHandler already
 * imports roomHandler).
 *
 * Row field semantics are client-verified (`CGameSessionSlot` = the 180-byte row; offsets
 * below are BYTE offsets within the row):
 *   +32  active flag (set by S->C 82/84, cleared by S->C 86)         (`sub_437FB8`)
 *   +68  room-context word (compared by S->C 85/86)                  (`sub_4C20E9`)
 *   +72  hasPassword    (u8; password icon `sub_4C0xxx` render; "WaitRoom" filter requires 0)
 *   +84  mapSelectState (u8; j[93]; 0/1 two-state icon)
 *   +108 isPlaying      (u8; `sub_4C20C5`; joinable filter requires 0)
 *   +120 map field u16  (255 = random-map marker in the compact writer `sub_4C1C0A`)
 *   +132 occupied count (u8; `sub_4C2083` "occ < max"; "%d/%d" text)
 *   +144 maxPlayers     (u8; `sub_4C2083`; 2P viewers additionally require max-occ >= 2)
 *   +96  gameMode       (u8 -> dword; j[2002]; icons for 10..13; 14 = green text)
 *   +168 mapId          (u32; map thumbnail/name via `sub_4DDBEC`/`sub_4DF6B2`)
 *   +156 roomVariant    (u8; badge icon when != 0; j[2014])
 *
 * The default list mode is 1 ("WaitRoom" only — `sub_4C99DC` sets dword 6179 = 1) and
 * `CLobbyStage::sub_4C275B` filters rows through `sub_4C2083` (active && occ < max &&
 * !playing) plus hasPassword == 0. The earlier field mapping put occupied/counts in the
 * password/mode slots, so every row failed that filter and the list looked empty.
 */

function occupiedCount(room: GameRoom): number {
  return room.slots.filter((s) => s.occupied).length;
}

/**
 * Builds S->C 82 (`CLobbyStage::sub_4C1E57` -> `sub_4C1B1B` at `0x004C1B1B`)
 * Lobby Room List Entry Full Add/Set. `sub_4C1B1B` reads, in order:
 *   u16 roomIndex (consumed by `sub_4C1E57`'s `sub_4C1AC6` row lookup)
 *   u32 room-context word -> row +68 (local: `room.chiefSlotNetId`)
 *   str roomName -> row +8
 *   u8 hasPassword -> +72, u8 mapSelectState -> +84, u8 isPlaying -> +108
 *   u16 mapField -> +120, u8 occupied -> +132, u8 maxPlayers -> +144
 *   u8 gameMode -> +96, u32 mapId -> +168, u8 roomVariant -> +156
 * and sets the active flag (+32) = 1, so the same packet both inserts and refreshes.
 */
export function buildLobbyRoomEntryPacket(room: GameRoom): PacketWriter {
  const w82 = new PacketWriter(ServerOpcode.LobbyRoomListEntry);
  w82.writeU16(room.roomNumber);
  w82.writeU32(room.chiefSlotNetId);
  w82.writeString(room.name);
  w82.writeU8(room.hasPassword ? 1 : 0); // +72
  w82.writeU8(room.mapRandom ? 1 : 0); // +84
  w82.writeU8(room.isPlaying ? 1 : 0); // +108
  w82.writeU16(room.mapRandom ? 255 : room.mapId & 0xffff); // +120 (255 = random marker)
  w82.writeU8(occupiedCount(room)); // +132
  w82.writeU8(room.maxPlayers & 0xff); // +144
  w82.writeU8(room.gameMode & 0xff); // +96
  w82.writeU32(room.mapId >>> 0); // +168
  w82.writeU8(room.roomVariant & 0xff); // +156
  return w82;
}

/**
 * Builds S->C 84 (`CLobbyStage::sub_4C1E90` -> `sub_4C1C0A` at `0x004C1C0A`)
 * Compact Lobby Room List Entry. `sub_4C1C0A` forces +108 = 0 (never playing) and
 * +120 = 255 (random-map marker) and reads:
 *   u16 roomIndex, u32 room-context word, str roomName
 *   u8 hasPassword -> +72, u8 mapSelectState -> +84
 *   u8 occupied -> +132, u8 maxPlayers -> +144
 *   u8 gameMode -> +96, u32 mapId -> +168, u8 roomVariant -> +156
 */
export function buildLobbyRoomEntryCompactPacket(room: GameRoom): PacketWriter {
  const w84 = new PacketWriter(ServerOpcode.LobbyRoomListEntryCompact);
  w84.writeU16(room.roomNumber);
  w84.writeU32(room.chiefSlotNetId);
  w84.writeString(room.name);
  w84.writeU8(room.hasPassword ? 1 : 0); // +72
  w84.writeU8(room.mapRandom ? 1 : 0); // +84
  w84.writeU8(occupiedCount(room)); // +132
  w84.writeU8(room.maxPlayers & 0xff); // +144
  w84.writeU8(room.gameMode & 0xff); // +96
  w84.writeU32(room.mapId >>> 0); // +168
  w84.writeU8(room.roomVariant & 0xff); // +156
  return w84;
}

/**
 * Builds S->C 85 (`CLobbyStage::sub_4C3ED0` -> `sub_4C32E4` at `0x004C32E4`)
 * Incremental Lobby row update:
 *   u16 roomIndex (consumed by `sub_4C3ED0`'s row lookup), u32 room-context word, u8 mask
 * Fields follow the parser's bit-check order (0x01, 0x02, 0x04, 0x08, 0x20, 0x10, 0x40, 0x80):
 *   0x01 -> u8 isPlaying (+108)
 *   0x02 -> u16 mapField (+120), u32 mapId (+168)
 *   0x04 -> u8 occupied (+132)
 *   0x08 -> u8 maxPlayers (+144)
 *   0x20 -> u8 hasPassword (+72)
 *   0x10 -> str roomName
 *   0x40 -> u8 roomVariant (+156)
 *   0x80 -> str roomName, u8 hasPassword (+72), u8 gameMode (+96), u8 mapSelectState (+84)
 * The context word must match the row's stored context (`sub_4C20E9` semantics).
 */
export function buildLobbyRoomSlotUpdatePacket(room: GameRoom, mask: number = 0x20): PacketWriter {
  const w85 = new PacketWriter(ServerOpcode.LobbyRoomSlotUpdate);
  w85.writeU16(room.roomNumber);
  w85.writeU32(room.chiefSlotNetId);
  w85.writeU8(mask & 0xff);
  if (mask & 0x01) {
    w85.writeU8(room.isPlaying ? 1 : 0);
  }
  if (mask & 0x02) {
    w85.writeU16(room.mapRandom ? 255 : room.mapId & 0xffff);
    w85.writeU32(room.mapId >>> 0);
  }
  if (mask & 0x04) {
    w85.writeU8(occupiedCount(room));
  }
  if (mask & 0x08) {
    w85.writeU8(room.maxPlayers & 0xff);
  }
  if (mask & 0x20) {
    w85.writeU8(room.hasPassword ? 1 : 0);
  }
  if (mask & 0x10) {
    w85.writeString(room.name);
  }
  if (mask & 0x40) {
    w85.writeU8(room.roomVariant & 0xff);
  }
  if (mask & 0x80) {
    w85.writeString(room.name);
    w85.writeU8(room.hasPassword ? 1 : 0);
    w85.writeU8(room.gameMode & 0xff);
    w85.writeU8(room.mapRandom ? 1 : 0);
  }
  return w85;
}

/**
 * Builds S->C 86 (`CLobbyStage::sub_4C2722` -> `sub_4C20E9` at `0x004C20E9`)
 * Remove a room row from the Lobby list:
 *   u16 roomIndex
 *   u32 room-context word (`sub_4C20E9` deactivates the row only when this matches the
 *   context stored by the row's last S->C 82/84 write, i.e. `room.chiefSlotNetId`)
 */
export function buildLobbyRoomSlotRemovePacket(roomNumber: number, roomContextWord: number): PacketWriter {
  const w86 = new PacketWriter(ServerOpcode.LobbyRoomSlotRemove);
  w86.writeU16(roomNumber & 0xffff);
  w86.writeU32(roomContextWord >>> 0);
  return w86;
}

/**
 * Announces a room row to every Lobby-stage viewer via S->C 82. `sub_4C1E57`'s lookup
 * (`sub_4C1AC6`) indexes a fixed 305-row array sized at Lobby init (`sub_4C99DC`), and
 * `sub_4C1B1B` both inserts and refreshes rows (and rewrites the row context word), so the
 * same packet covers room creation and in-place updates (counts, playing flag, chief change).
 */
export function announceRoomListEntry(state: WorldState, room: GameRoom): void {
  state.broadcastToAllLobby(() => buildLobbyRoomEntryPacket(room));
}

/** Removes a destroyed room's row from every Lobby-stage viewer via S->C 86. */
export function announceRoomListRemoval(state: WorldState, room: GameRoom): void {
  state.broadcastToAllLobby(() =>
    buildLobbyRoomSlotRemovePacket(room.roomNumber, room.chiefSlotNetId)
  );
}

/**
 * Announces the outcome of `WorldState.leaveRoom` to Lobby viewers: the room disappears
 * when it was deleted, otherwise its row is refreshed (occupied count / chief context).
 */
export function announceRoomListAfterLeave(
  state: WorldState,
  leftRoom: GameRoom | null,
  roomDeleted: boolean
): void {
  if (!leftRoom) {
    return;
  }
  if (roomDeleted) {
    announceRoomListRemoval(state, leftRoom);
  } else {
    announceRoomListEntry(state, leftRoom);
  }
}
