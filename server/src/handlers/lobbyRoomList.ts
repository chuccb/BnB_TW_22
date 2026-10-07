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
 */

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
