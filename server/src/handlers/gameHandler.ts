import { getLevelBounds } from "../db/database.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter, ipv4ToUint32 } from "../protocol/primitives.ts";
import type { ClientSession, GameRoom, RoomSlot, WorldState } from "../state/worldState.ts";
import { logger } from "../utils/logger.ts";
import { announceRoomListEntry } from "./lobbyRoomList.ts";

/**
 * Builds S->C 135 (`CGameStage::sub_4F672F` case `135` -> `sub_4F2065` at `0x004F2065`)
 * All Players Loaded / Match Start:
 *   u32 startSeed (`sub_697580`)
 *   u32 durationMs (`*(this + 16008) = sub_697580`)
 *   u32 hurryUpSec (`*(this + 16009) = sub_697580`, multiplied by 1000)
 *   u32 suddenDeathSec (`*(this + 16010) = sub_697580`, multiplied by 1000)
 *   u32 extraParam (`*(this + 16188) = sub_697580`)
 *   u8 is30FpsFlag (`sub_6974B0`, 1 = 30 FPS)
 *   u32 relayIp (`hostlong = sub_697580`)
 *   u16 relayPort (`sub_697510`)
 *   u8 localPrimarySlot (`sub_6974B0`)
 *   For slotIdx = 0 .. 9 (10 slots, `k = 141 .. 150`):
 *     u8 isPresent (`sub_6974B0`)
 *     if isPresent != 0:
 *       For ep = 0 .. 2:
 *         u32 ip (`sub_697580`)
 *         u16 port (`sub_697510`)
 */
export function buildAllLoadedStartPacket(
  room: GameRoom,
  localPrimarySlot = 0,
  relayIp = 0,
  relayPort = 0
): PacketWriter {
  const w135 = new PacketWriter(ServerOpcode.AllPlayersLoadedStart);
  w135.writeU32(room.startTick >>> 0); // startSeed
  w135.writeU32(180_000); // durationMs (3 minutes)
  w135.writeU32(120); // hurryUpSec (120s -> 120,000ms)
  w135.writeU32(150); // suddenDeathSec (150s -> 150,000ms)
  w135.writeU32(0); // extraParam
  w135.writeU8(1); // is30FpsFlag = 1 (30 FPS)
  w135.writeU32(relayIp >>> 0); // relayIp
  w135.writeU16(relayPort & 0xffff); // relayPort
  w135.writeU8(localPrimarySlot & 0xff); // localPrimarySlot

  for (let i = 0; i < 10; i++) {
    const slot = i < 8 ? room.slots[i] : undefined;
    if (!slot || !slot.occupied) {
      w135.writeU8(0); // isPresent = 0
    } else {
      w135.writeU8(1); // isPresent = 1
      for (let ep = 0; ep < 3; ep++) {
        const endpoint = slot.udpEndpoints[ep] ?? { ip: 0, port: 0 };
        w135.writeU32(endpoint.ip >>> 0);
        w135.writeU16(endpoint.port & 0xffff);
      }
    }
  }
  return w135;
}

/**
 * Builds S->C 136 (`CGameStage::sub_4F672F` case `136` -> `sub_4EA206` at `0x004EA206`):
 *   u8 slotIdx (`*(this + slotIdx + 16024) = 1`)
 * Stops the client's 1-second UDP load-registration retry timer (`sub_4ED400`).
 */
export function buildPlayerLoadedAckPacket(slotIdx: number): PacketWriter {
  const w136 = new PacketWriter(ServerOpcode.PlayerLoadedAck);
  w136.writeU8(slotIdx & 0xff);
  return w136;
}

function getPublicUdpRelayIp(state: WorldState): number {
  try {
    const ip = ipv4ToUint32(state.config.publicIp);
    if (ip !== 0) {
      return ip;
    }
    throw new TypeError("PUBLIC_IP cannot be 0.0.0.0");
  } catch (error) {
    logger.error("GameUDP", "Cannot advertise the GameServer UDP relay without a valid PUBLIC_IP", {
      publicIp: state.config.publicIp,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

function broadcastAllLoadedStartPacket(state: WorldState, room: GameRoom): void {
  const relayIp = getPublicUdpRelayIp(state);
  state.broadcastToRoom(room, (targetSession) => {
    const primarySlot = targetSession.roomSlotIndices[0] ?? 0;
    return buildAllLoadedStartPacket(
      room,
      primarySlot,
      relayIp,
      state.config.gameUdpPort
    );
  });
}

/**
 * Marks only slots owned by this session as loaded and sends each new `S->C 136` ack once.
 * On the first transition to all-loaded, it starts the clock and broadcasts `S->C 135`.
 * Repeated registration retries do not restart the timer or rebroadcast either packet.
 */
export function markSessionGameLoaded(
  state: WorldState,
  room: GameRoom,
  session: ClientSession
): void {
  if (!room.isPlaying) return;

  let newlyLoaded = false;
  for (const slotIdx of session.roomSlotIndices) {
    const slot = room.slots[slotIdx];
    if (!slot?.occupied || slot.session !== session || slot.loadedGame) continue;

    slot.loadedGame = true;
    newlyLoaded = true;
    state.broadcastToRoom(room, () => buildPlayerLoadedAckPacket(slot.slotIdx));
  }

  if (!newlyLoaded) return;

  const occupied = room.slots.filter((slot) => slot.occupied);
  if (occupied.length > 0 && occupied.every((slot) => slot.loadedGame)) {
    room.startTick = Date.now() >>> 0;
    broadcastAllLoadedStartPacket(state, room);
  }
}

/**
 * Builds S->C 148 (`CGameStage::sub_4F672F` case `148` -> `*(*this + 344)` = `sub_4F2F8B` at `0x004F2F8B`
 * + `CGOGameResult::sub_455957` at `0x00455957`)
 * and persists EXP, Level, Lucci, Wins/Losses/Draws in SQLite, followed by S->C 153 (`sub_4F2D1A`).
 */
export function finishMatch(
  state: WorldState,
  room: GameRoom,
  winningTeam: number | null
): void {
  if (!room.isPlaying) {
    return;
  }
  room.isPlaying = false;
  // Refresh the room row for Lobby viewers (playing flag back to 0). The room's players
  // are still in the Game stage, so only Lobby viewers receive the S->C 82.
  announceRoomListEntry(state, room);

  const isDraw = winningTeam === null;
  const w148 = new PacketWriter(ServerOpcode.MatchResult);
  w148.writeU8(isDraw ? 0 : 1); // v96
  w148.writeU8(0); // v87
  w148.writeU8(0); // resultType = 0 (normal CGOGameResult)
  w148.writeU8(isDraw ? 1 : 0); // v14
  w148.writeU8(0); // pad

  const occupiedSlots: RoomSlot[] = [];
  const distinctTeams = new Set(room.slots.filter((s) => s.occupied).map((s) => s.teamColor));

  for (let i = 0; i < 8; i++) {
    const slot = room.slots[i]!;
    if (!slot.occupied || !slot.user) {
      w148.writeU8(0); // empty slot
      continue;
    }

    occupiedSlots.push(slot);
    const user = slot.user;
    const isWinner =
      !isDraw &&
      (distinctTeams.size > 1 && winningTeam !== 0
        ? slot.teamColor === winningTeam
        : slot.alive);
    const outcome = isDraw ? 2 : isWinner ? 0 : 3;

    const expGain = isDraw ? 15 : isWinner ? 50 + slot.kills * 10 : 10 + slot.kills * 5;
    const lucciGain = isDraw ? 20 : isWinner ? 100 + slot.kills * 20 : 25;

    user.exp += expGain;
    user.lucci += lucciGain;
    if (isDraw) {
      user.draws += 1;
    } else if (isWinner) {
      user.wins += 1;
    } else {
      user.losses += 1;
    }

    // Recompute level using client's exact curve (`sub_4A49D5`)
    while (user.level < 400 && user.exp >= getLevelBounds(user.level).maxExp) {
      user.level += 1;
    }

    state.db.updateUserStats(
      user.id,
      user.level,
      user.exp,
      user.lucci,
      user.wins,
      user.losses,
      user.draws
    );

    w148.writeU8(1); // slotType = 1 (human)
    w148.writeU32(slot.netSlotId);
    w148.writeU8(outcome);
    w148.writeU8(slot.kills & 0xff);
    w148.writeU8(slot.saves & 0xff);
    w148.writeU8(0); // flag8
    w148.writeU32(expGain);
    w148.writeU8(slot.charId & 0x3f);
    w148.writeU32(user.exp);
    w148.writeU16(user.wins & 0xffff);
    w148.writeU16(user.losses & 0xffff);
    w148.writeU16(user.rankFlag & 0xffff);
    w148.writeU8(0); // flag24
    if (state.config.enabledFeatures.has(9)) {
      w148.writeU8(0); // flag25
    }
    w148.writeU16(expGain & 0xffff); // bonusExp
    w148.writeU16(0); // doubleExpFlag
    w148.writeU32(user.lucci); // totalLucci
  }

  for (let i = 0; i < occupiedSlots.length; i++) {
    w148.writeU8(0); // niceWinMsgType = 0
  }

  state.broadcastToRoom(room, () => w148);

  // Also broadcast S->C 153 (`sub_4F2D1A` at `0x004F2D1A`) to return players to CPrepareStage (Stage 12)
  for (const s of room.slots) {
    s.ready = false;
    s.loadedGame = false;
    if (s.occupied && s.session) {
      s.session.stageId = StageId.Prepare;
    }
  }

  const w153 = new PacketWriter(ServerOpcode.ReturnToPrepareStage);
  w153.writeU8(0); // targetMode = 0 -> Stage 12 (CPrepareStage)
  w153.writeU8(room.mapTheme);
  state.broadcastToRoom(room, () => w153);
}

/**
 * Handles CGameStage C->S opcodes (`0x004EA000`–`0x004F7000`).
 */
export function handleGamePacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  if (session.currentRoomNumber === null || session.stageId !== StageId.Game) {
    return;
  }
  const room = state.rooms.get(session.currentRoomNumber);
  if (!room?.isPlaying) {
    return;
  }

  switch (opcode) {
    case ClientOpcode.PlaceBomb: {
      const slotIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const rest = reader.readBlock(reader.remaining);
      const nowTick = (Date.now() - room.startTick) >>> 0;

      state.broadcastToRoom(room, () => {
        const w138 = new PacketWriter(ServerOpcode.PlaceBombBroadcast);
        w138.writeU8(slotIdx);
        w138.writeU32(nowTick);
        w138.writeU32(nowTick);
        w138.writeU32(nowTick);
        if (rest.length >= 9) {
          w138.writeBlock(rest);
        } else {
          const y = rest[0] ?? 0;
          const x = rest[1] ?? 0;
          const power = rest[2] ?? 1;
          const flags = rest[3] ?? 0;
          const bombId = ((slotIdx << 8) | (nowTick & 0xff)) & 0xffff;
          w138.writeU8(y);
          w138.writeU8(x);
          w138.writeU8(power);
          w138.writeU8(flags & ~0x20);
          w138.writeU16(bombId);
          w138.writeU16(3000);
          w138.writeU8(0);
        }
        return w138;
      });
      break;
    }

    case ClientOpcode.KickBomb: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w139 = new PacketWriter(ServerOpcode.KickBombBroadcast);
        w139.writeBlock(payload);
        return w139;
      });
      break;
    }

    case ClientOpcode.BombExplode: {
      const count = reader.remaining >= 1 ? reader.readU8() : 0;
      const items: { bombId: number; flag: number }[] = [];
      for (let i = 0; i < count && reader.remaining >= 3; i++) {
        items.push({
          bombId: reader.readU16(),
          flag: reader.readU8(),
        });
      }
      const nowTick = (Date.now() - room.startTick) >>> 0;
      state.broadcastToRoom(room, () => {
        const w137 = new PacketWriter(ServerOpcode.BombExplodeBroadcast);
        w137.writeU8(items.length);
        for (const it of items) {
          w137.writeU16(it.bombId);
          w137.writeU8(it.flag);
          if (it.flag === 0) {
            w137.writeU32(nowTick);
          }
        }
        return w137;
      });
      break;
    }

    case ClientOpcode.PushBox: {
      const subType = reader.remaining >= 1 ? reader.readU8() : 2;
      const slotIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const srcY = reader.remaining >= 1 ? reader.readU8() : 0;
      const srcX = reader.remaining >= 1 ? reader.readU8() : 0;
      const destY = reader.remaining >= 1 ? reader.readU8() : srcY;
      const destX = reader.remaining >= 1 ? reader.readU8() : srcX;

      if (subType === 2) {
        state.broadcastToRoom(room, () => {
          const w140 = new PacketWriter(ServerOpcode.PushBoxBroadcast);
          w140.writeU8(1);
          w140.writeU8(srcY);
          w140.writeU8(srcX);
          w140.writeU8(destY);
          w140.writeU8(destX);
          w140.writeU8(slotIdx);
          return w140;
        });
      }
      break;
    }

    case ClientOpcode.PickUpItem: {
      const slotIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const itemNetId = reader.remaining >= 1 ? reader.readU8() : 0;
      if (reader.remaining >= 1) reader.readU8(); // y; the local relay does not model map coordinates.
      if (reader.remaining >= 1) reader.readU8(); // x; retained in the request schema, not the reply.
      const itemType = reader.remaining >= 1 ? reader.readU8() : 0;
      const extra = reader.readBlock(reader.remaining);

      state.broadcastToRoom(room, () => {
        const w141 = new PacketWriter(ServerOpcode.PickUpItemBroadcast);
        w141.writeU8(slotIdx);
        w141.writeU8(itemNetId);
        w141.writeU8(itemType);
        w141.writeBlock(extra);
        return w141;
      });
      break;
    }

    case ClientOpcode.DestroyTile: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w142 = new PacketWriter(ServerOpcode.DestroyTileBroadcast);
        w142.writeBlock(payload);
        return w142;
      });
      break;
    }

    case ClientOpcode.PlayerStateChange: {
      // Recovered C->S 113 writers include a packed subtype/slot byte and two u16 coordinates.
      // Do not reinterpret a shorter, unresolved body as a GameLoadRegistration completion.
      if (reader.remaining < 5) return;

      const firstByte = reader.readU8();
      const slotIdx = firstByte & 0x0f;
      const subType = (firstByte >>> 4) & 0x0f;
      const x = reader.readU16();
      const y = reader.readU16();
      const restBytes = reader.readBlock(reader.remaining);

      const slot = room.slots[slotIdx] ?? room.slots[session.roomSlotIndices[0] ?? 0];
      if (!slot) {
        return;
      }

      if (subType === 2) {
        slot.trapped = true;
      } else if (
        subType === 3 ||
        subType === 12 ||
        subType === 13 ||
        subType === 14 ||
        subType === 15
      ) {
        slot.trapped = false;
        if (subType === 3 && restBytes.length >= 1) {
          const rescuerSlot = room.slots[restBytes[0]!];
          if (rescuerSlot && rescuerSlot.occupied && rescuerSlot.slotIdx !== slot.slotIdx) {
            rescuerSlot.saves += 1;
          }
        }
      } else if (subType === 4) {
        slot.trapped = false;
        slot.alive = false;
        const killerSlotIdx = restBytes.length >= 1 ? restBytes[0]! : 0xff;
        const killerSlot = room.slots[killerSlotIdx];
        if (killerSlot && killerSlot.occupied && killerSlot.slotIdx !== slot.slotIdx) {
          killerSlot.kills += 1;
        }
      } else if (subType === 5) {
        slot.trapped = false;
        slot.alive = false;
        if (restBytes.length >= 1) {
          const count = restBytes[0]!;
          for (let i = 0; i < count && 1 + i * 5 < restBytes.length; i++) {
            const deadSlotIdx = restBytes[1 + i * 5]!;
            if (room.slots[deadSlotIdx]) {
              room.slots[deadSlotIdx]!.trapped = false;
              room.slots[deadSlotIdx]!.alive = false;
            }
          }
        }
      }

      state.broadcastToRoom(room, () => {
        const w144 = new PacketWriter(ServerOpcode.PlayerStateBroadcast);
        w144.writeU8(((subType & 0x0f) << 4) | (slot.slotIdx & 0x0f));
        w144.writeU16(x);
        w144.writeU16(y);
        w144.writeBlock(restBytes);
        return w144;
      });

      if (!slot.alive) {
        const occupied = room.slots.filter((s) => s.occupied);
        const aliveTeams = new Set(occupied.filter((s) => s.alive).map((s) => s.teamColor));
        if (occupied.length === 1 && !slot.alive) {
          finishMatch(state, room, null);
        } else if (occupied.length > 1 && aliveTeams.size <= 1) {
          const winningTeam = aliveTeams.size === 1 ? [...aliveTeams][0]! : null;
          finishMatch(state, room, winningTeam);
        }
      }
      break;
    }

    case ClientOpcode.MatchFinish: {
      const winningTeam =
        reader.remaining >= 1
          ? reader.readU8()
          : (room.slots[session.roomSlotIndices[0] ?? 0]?.teamColor ?? 0);
      finishMatch(state, room, winningTeam === 0xff ? null : winningTeam);
      break;
    }

    // C->S 117 is a map-object/script event stream ([u16 objNetId, u16 eventId, variant...];
    // writers CScriptObject::sub_45B999, CGONpcIceMon::sub_51BBDA, CMapActionObjState::sub_51F5CD,
    // CMapActionSay::sub_51FFA0). The former LeaveMatch handler (mark dead + S->C 153 + finishMatch)
    // was based on the withdrawn name and treated map-script/NPC events as match exits; early leave
    // is C->S 78 LeaveRoom. Observed without room-state mutation pending an established broadcast route.
    case ClientOpcode.MapObjectEvent: {
      break;
    }

    case ClientOpcode.ThrowDart: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w145 = new PacketWriter(ServerOpcode.ThrowDartBroadcast);
        w145.writeU8(0); // result == 0 (success)
        w145.writeBlock(payload);
        return w145;
      });
      break;
    }

    case ClientOpcode.MatchDrawTimeout: {
      if (room.isPlaying) {
        finishMatch(state, room, null);
      }
      break;
    }

    case ClientOpcode.ComponentSubPacket: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w149 = new PacketWriter(ServerOpcode.ComponentSubBroadcast);
        w149.writeBlock(payload);
        return w149;
      });
      break;
    }

    case ClientOpcode.SpawnMapItems: {
      const raw = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w151 = new PacketWriter(ServerOpcode.SpawnMapItemsBroadcast);
        if (raw.length >= 5) {
          w151.writeBlock(raw);
        } else {
          const x = raw[0] ?? 1;
          const y = raw[1] ?? 1;
          const itemType = raw.length >= 4 ? ((raw[2]! << 8) | raw[3]!) : 0;
          w151.writeU16(0);
          w151.writeU16(0);
          w151.writeU8(1); // 1 group
          w151.writeU8(1); // 1 item
          w151.writeU16(itemType);
          w151.writeU8(1); // itemNetId = 1
          w151.writeU8(x);
          w151.writeU8(y);
        }
        return w151;
      });
      break;
    }

    case ClientOpcode.ThrowBomb: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w146 = new PacketWriter(ServerOpcode.ThrowBombBroadcast);
        w146.writeBlock(payload);
        return w146;
      });
      break;
    }

    case ClientOpcode.PlaceSpecialBomb: {
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w181 = new PacketWriter(ServerOpcode.SpecialBombBroadcast);
        w181.writeBlock(payload);
        return w181;
      });
      break;
    }

    case ClientOpcode.RequestUdpRelay: {
      // CUDPPeerMan::sub_57BEF6 sends exactly one byte: the peer index to mark for TCP fallback.
      if (reader.remaining !== 1) {
        logger.warn("GameUDP", "Rejected malformed C->S 149 UDP fallback request", {
          sessionId: session.sessionId,
          roomNumber: room.roomNumber,
          payloadBytes: reader.remaining,
          expectedBytes: 1,
        });
        break;
      }

      const peerIdx = reader.readU8();
      // CUDPPeerManBase::sub_5ECBF0 only marks the 12 client peer entries (indices 0..11).
      if (peerIdx > 11) {
        logger.warn("GameUDP", "Rejected C->S 149 peer index outside the client peer table", {
          sessionId: session.sessionId,
          roomNumber: room.roomNumber,
          peerIdx,
          maxPeerIdx: 11,
        });
        break;
      }

      logger.debug("GameUDP", "Forwarding UDP peer TCP-fallback notice to room", {
        sessionId: session.sessionId,
        roomNumber: room.roomNumber,
        peerIdx,
      });
      state.broadcastToRoom(room, () => {
        const w125 = new PacketWriter(ServerOpcode.UdpRelayFallback);
        w125.writeU8(peerIdx);
        return w125;
      });
      break;
    }

    case ClientOpcode.PushBomb: {
      // C->S 121 (`sub_44B969`: `[u8 flagsAndBomberIdx, u8 x, u8 y]`) -> S->C 146 (`sub_4EEB75`)
      const flagsAndBomberIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const x = reader.remaining >= 1 ? reader.readU8() : 0;
      const y = reader.remaining >= 1 ? reader.readU8() : 0;
      state.broadcastToRoom(room, () => {
        const w146 = new PacketWriter(ServerOpcode.ThrowBombBroadcast);
        w146.writeU8(flagsAndBomberIdx);
        w146.writeU8(x);
        w146.writeU8(y);
        return w146;
      });
      break;
    }

    case ClientOpcode.InGameBubbleChat: {
      // C->S 122 (`sub_44E435`: `[u8 slotIdx, str message]`) -> S->C 21 (`sub_4F4D49`)
      const slotIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const msg = reader.remaining >= 2 ? reader.readString() : "";
      const senderName =
        room.slots[slotIdx]?.user?.username ??
        session.users[0]?.username ??
        `Player${session.sessionId}`;
      const formatted = `${senderName} : ${msg}`;
      state.broadcastToRoom(room, () => {
        const w21 = new PacketWriter(ServerOpcode.NormalChat);
        w21.writeString(formatted);
        w21.writeU8(0);
        return w21;
      });
      break;
    }

    case ClientOpcode.ThrowBombAction: {
      // C->S 123 (`sub_44B72D`: `[u8 x, u8 y, u8 (bomberIdx<<4)|dir]`) -> S->C 180 (`sub_4EAC86`)
      const x = reader.remaining >= 1 ? reader.readU8() : 0;
      const y = reader.remaining >= 1 ? reader.readU8() : 0;
      const packed = reader.remaining >= 1 ? reader.readU8() : 0;
      const bomberIdx = (packed >>> 4) & 0x0f;
      state.broadcastToRoom(room, () => {
        const w180 = new PacketWriter(ServerOpcode.BombThrownBroadcast);
        w180.writeU8(1); // bombId
        w180.writeU8(bomberIdx);
        w180.writeU8(x);
        w180.writeU8(y);
        return w180;
      });
      break;
    }

    case ClientOpcode.BomberSpecialAction: {
      // C->S 118 (`sub_4EA367` / `sub_4EA3CD`: `[u8 bomberIdx, u8 flag, u8 x, u8 y, u8 a5, u8 a4]`) -> S->C 154 (`sub_4ECD11`)
      if (reader.remaining < 6) return;
      const bomberIdx = reader.readU8();
      reader.readU8(); // Opaque flag; its meaning is not modeled by S->C 154.
      const x = reader.readU8();
      const y = reader.readU8();
      const type = reader.readU8();
      reader.readU8(); // Opaque trailing field from the recovered six-byte writer.
      reader.readBlock(reader.remaining); // Preserve packet alignment if the body grows.
      state.broadcastToRoom(room, () => {
        const w154 = new PacketWriter(ServerOpcode.SpecialTileEffect);
        w154.writeU8(x);
        w154.writeU8(y);
        w154.writeU8(((bomberIdx & 0x0f) << 4) | (type & 0x0f));
        return w154;
      });
      break;
    }

    case ClientOpcode.BomberReviveOrGhost: {
      // C->S 125 (`sub_4EE3DF`: `[u8 a2, u8 a3, u8 slotIdx, u8 a4]`) -> S->C 156 (`sub_4ECDDB`)
      if (reader.remaining < 4) return;
      const bomberIdx = reader.readU8();
      reader.readU8(); // Opaque second field from the recovered four-byte writer.
      const slotIdx = reader.readU8();
      reader.readU8(); // Opaque trailing field; no client-backed mapping is used here.
      reader.readBlock(reader.remaining);
      const slot = room.slots[slotIdx];
      if (slot) {
        slot.trapped = false;
        slot.alive = true;
      }
      state.broadcastToRoom(room, () => {
        const w156 = new PacketWriter(ServerOpcode.BomberRevived);
        w156.writeU8(bomberIdx);
        w156.writeU8(slotIdx);
        return w156;
      });
      break;
    }

    case ClientOpcode.PickupMapItem: {
      // C->S 128 (`sub_44F405`: `[u8 bomberIdx, u8 x, u8 y]`) -> S->C 142 (`sub_4EB01C`)
      const bomberIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const x = reader.remaining >= 1 ? reader.readU8() : 0;
      const y = reader.remaining >= 1 ? reader.readU8() : 0;
      state.broadcastToRoom(room, () => {
        const w142 = new PacketWriter(ServerOpcode.DestroyTileBroadcast);
        w142.writeU8(bomberIdx);
        w142.writeU8(x);
        w142.writeU8(y);
        return w142;
      });
      break;
    }

    case ClientOpcode.DestroyTilesBatch: {
      // C->S 132 (`sub_4F1690`: `[u8 count, u16 a5, u16 a4, u8 a2, u16 a9, count*(u8 x, u8 y)]`) -> S->C 151 (`sub_4F24A6`)
      const count = reader.remaining >= 1 ? reader.readU8() : 0;
      const a5 = reader.remaining >= 2 ? reader.readU16() : 0;
      const a4 = reader.remaining >= 2 ? reader.readU16() : 0;
      if (reader.remaining >= 1) reader.readU8(); // Opaque a2 field retained in the Client schema.
      if (reader.remaining >= 2) reader.readU16(); // Opaque a9 field retained in the Client schema.
      const coords: { x: number; y: number }[] = [];
      for (let i = 0; i < count && reader.remaining >= 2; i++) {
        coords.push({ x: reader.readU8(), y: reader.readU8() });
      }
      state.broadcastToRoom(room, () => {
        const w151 = new PacketWriter(ServerOpcode.SpawnMapItemsBroadcast);
        w151.writeU16(a5);
        w151.writeU16(a4);
        w151.writeU8(0); // 0 item groups spawned by default
        return w151;
      });
      break;
    }

    case ClientOpcode.SyncGameObjectUpdate: {
      // C->S 136 (`sub_578D1F`: `[u16 objId, 20B state]`) -> S->C 176 (`CSyncGameObjectMan`)
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w176 = new PacketWriter(ServerOpcode.SyncObjectUpdate);
        w176.writeBlock(payload);
        return w176;
      });
      break;
    }

    case ClientOpcode.SyncGameObjectEvent: {
      // C->S 137 (`sub_579F03`: `[u16 objId, u32 val]`) -> S->C 177 (`CSyncGameObjectMan`)
      const payload = reader.readBlock(reader.remaining);
      state.broadcastToRoom(room, () => {
        const w177 = new PacketWriter(ServerOpcode.SyncObjectRemove);
        w177.writeBlock(payload);
        return w177;
      });
      break;
    }

    case ClientOpcode.TriggerRemoteBomb: {
      // C->S 141 (`sub_58587E`: `[u8 bomberIdx, u8 bombId, u8 flag]`) -> S->C 141 (`sub_4ECAAA`)
      const bomberIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const bombId = reader.remaining >= 1 ? reader.readU8() : 0;
      const flag = reader.remaining >= 1 ? reader.readU8() : 0;
      state.broadcastToRoom(room, () => {
        const w141 = new PacketWriter(ServerOpcode.PickUpItemBroadcast);
        w141.writeU8(bomberIdx);
        w141.writeU8(bombId);
        w141.writeU8(flag);
        return w141;
      });
      break;
    }

    case ClientOpcode.PlayerTrappedInBalloon: {
      // C->S 144 (`sub_508B55`: `[u8 bomberIdx]`) -> S->C 165 (`sub_4EAC12`)
      const bomberIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const slot = room.slots[bomberIdx];
      if (slot) {
        slot.trapped = true;
      }
      state.broadcastToRoom(room, () => {
        const w165 = new PacketWriter(ServerOpcode.BomberTrapped);
        w165.writeU8(bomberIdx);
        w165.writeU16(0);
        w165.writeU16(0);
        return w165;
      });
      break;
    }

    case ClientOpcode.PracticeExit: {
      // C->S 150 (`sub_4D18B3`: exit practice stage) -> S->C 153 (`sub_4F2D1A`)
      session.stageId = StageId.Prepare;
      const w153 = new PacketWriter(ServerOpcode.ReturnToPrepareStage);
      w153.writeU8(0);
      w153.writeU8(room.mapTheme);
      session.sendPacket(w153);
      break;
    }

    case ClientOpcode.UseActiveGameItem: {
      // C->S 153 (`sub_50E781`: `[u8 bomberIdx, u8 itemSlot, u8 itemType]`) -> S->C 139 (`sub_4EC6AE`)
      const bomberIdx = reader.remaining >= 1 ? reader.readU8() : (session.roomSlotIndices[0] ?? 0);
      const itemSlot = reader.remaining >= 1 ? reader.readU8() : 0;
      const itemType = reader.remaining >= 1 ? reader.readU8() : 0;
      state.broadcastToRoom(room, () => {
        const w139 = new PacketWriter(ServerOpcode.KickBombBroadcast);
        w139.writeU8(((itemType & 0x0f) << 4) | (bomberIdx & 0x0f));
        w139.writeU16(itemSlot);
        w139.writeU8(0);
        w139.writeU8(0);
        return w139;
      });
      break;
    }

    case ClientOpcode.NpcAttackDamage:
    case ClientOpcode.NpcStateEvent:
    case ClientOpcode.BossAiSync:
    case ClientOpcode.RoundSyncAck:
    case ClientOpcode.StageTransitionAck:
    case ClientOpcode.BossSkillTarget:
    case ClientOpcode.ReportPerfMetrics:
    case ClientOpcode.BombChainTileCheck:
    case ClientOpcode.MapScriptSync:
    case ClientOpcode.MapScriptTick:
    case ClientOpcode.CustomGameObjectSync:
    case ClientOpcode.InGameAliveAck:
    case ClientOpcode.SuddenDeathHazard:
    case ClientOpcode.ReportUdpPeerRtt:
    case ClientOpcode.ReportGameDesync: {
      break;
    }
  }
}
