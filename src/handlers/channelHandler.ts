import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { PacketReader, PacketWriter } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { handlePostLoginChannelRequest } from "./authHandler.ts";

/**
 * Builds S->C 10 (`CStage::sub_4BDBF5` -> `sub_5D42CF` -> `sub_5D3E91` -> `sub_5D3D3F` at `0x005D3D3F`)
 * and S->C 12 (`sub_5D4139` / `sub_565E9A` channel load array).
 *
 * `sub_5D3D3F` (`0x005D3D3F`) `channel2_001.ssd` SmartStream layout:
 *   u16 LE channelCount
 *   For each channel:
 *     str name (up to 32 bytes)
 *     u16 LE channelNumber
 *     u8 flagA
 *     u8 channelCategory
 *     u16 LE channelFlags
 *     u8 flagB
 *     u8 gameType
 *     u8 minGrade
 *     u8 maxGrade
 *     u16 LE minLv
 *     u16 LE maxLv
 */
export function buildChannelListPacket(state: WorldState): PacketWriter {
  const ss = new SmartStreamWriter();
  ss.writeU16(state.channels.length);

  for (const ch of state.channels) {
    ss.writeString(ch.name);
    ss.writeU16(ch.number);
    ss.writeU8(0); // flagA
    ss.writeU8(ch.type); // channelCategory
    ss.writeU16(ch.eventFlag); // channelFlags
    ss.writeU8(ch.isLadder); // flagB
    ss.writeU8(ch.gameType);
    ss.writeU8(ch.minGrade);
    ss.writeU8(ch.maxGrade);
    ss.writeU16(ch.minLv);
    ss.writeU16(ch.maxLv);
  }

  const w10 = new PacketWriter(ServerOpcode.ChannelListSsd);
  w10.writeU8(1); // hasStream = 1 (`sub_5D3E91`)
  w10.writeSmartStream(ss, true);
  return w10;
}

/**
 * Builds S->C 12 (`sub_5D4139` / `sub_565E9A`):
 *   u16 channelCount
 *   u16[channelCount] load
 */
export function buildChannelLoadsPacket(state: WorldState): PacketWriter {
  const w12 = new PacketWriter(ServerOpcode.ChannelLoads);
  w12.writeU16(state.channels.length);
  for (const ch of state.channels) {
    w12.writeU16(ch.load);
  }
  return w12;
}

export function sendChannelListAndLoads(state: WorldState, session: ClientSession): void {
  session.sendPacket(buildChannelListPacket(state));
  session.sendPacket(buildChannelLoadsPacket(state));
}

/**
 * Handles C->S 5 (`CSelectServerStage::sub_56AF39`):
 * Client sends:
 *   u16 channelIndex (or u8 category + u16 channelIndex)
 * Server replies S->C 7 (`CSelectServerStage::sub_56C0C8` at `0x0056C0C8`):
 *   u8 errCode (0 = success)
 *   u8 channelCategory (`sub_6974B0`)
 *   u32 channelNumber (`sub_697580`)
 *   u32 serverIp (`sub_697580`, host/network u32 IPv4, e.g. 0x7F000001 for 127.0.0.1)
 *   u16 serverPort (`sub_697510`, e.g. 3838 / 9339)
 */
export function handleChannelSelect(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  let channelIdx = 0;
  if (reader.remaining >= 2) {
    channelIdx = reader.readU16();
  } else if (reader.remaining >= 1) {
    channelIdx = reader.readU8();
  }

  const ch = state.channels[channelIdx] ?? state.channels[0]!;
  session.channelIndex = channelIdx;

  // Store token for session handoff if not already stored
  if (session.authTokens.length === 0 && session.users.length > 0) {
    const token = state.allocateAuthToken(
      session.users.map((u) => u.username),
      session.netSlotIds,
      session.equippedCharIds
    );
    session.authTokens = session.users.map(() => token);
  }

  const w7 = new PacketWriter(ServerOpcode.ChannelSelectResult);
  w7.writeU8(0); // errCode = 0 (success)
  w7.writeU8(ch.type); // channelCategory
  w7.writeU32(ch.number); // channelNumber
  w7.writeU32(0x7f000001); // 127.0.0.1
  w7.writeU16(state.config.tcpPort);
  session.sendPacket(w7);
}

/**
 * Handles C->S 6 (`sub_5D8879` / `sub_5D893D` / `sub_5D8A3F` at `0x005D8879`..`0x005D8A3F`):
 * Client sends:
 *   u8 localPlayerCount
 *   For each local player:
 *     str username
 *     u32 sessionToken
 *     [u32 isRegisteredFlag if sent via `sub_5D893D`]
 *   [u8 targetMode, u32 a2, u32 a3]
 *
 * Server replies:
 *   - S->C 33 (`CSelectServerStage::sub_56A9DA` -> `CStage::sub_4B96B1`):
 *       if feature 22 enabled (true in TW): u8(0)
 *       Transitions client to Stage 11 (`CLobbyStage`)
 *   - S->C 9 (`CStage::sub_4B8D42`):
 *       u32 stageId (11 = CLobbyStage, 14 = CShopStageNew)
 *   - S->C 75 (`CStage::sub_4B94A6`):
 *       u32 questConfigCount (0) -> triggers client to send `C->S 83` (Enter Lobby)
 */
export function handleSessionAuthHandoff(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  const playerCount = Math.min(2, Math.max(1, reader.remaining >= 1 ? reader.readU8() : 1));
  const usernames: string[] = [];
  let token = 0;

  for (let i = 0; i < playerCount; i++) {
    const username = reader.remaining >= 2 ? reader.readString() : `player${session.sessionId}`;
    const tok = reader.remaining >= 4 ? reader.readU32() : 0;
    if (i === 0) {
      token = tok;
    }
    // Check if sub_5D893D format includes u32 isRegisteredFlag per player:
    // If remaining has enough bytes for another string (if i+1 < playerCount) or trailing 9 bytes (u8 + u32 + u32)
    if (playerCount === 1 && reader.remaining === 13) {
      reader.readU32(); // isRegisteredFlag
    }
    usernames.push(username);
  }

  let targetMode = 0;
  if (reader.remaining >= 1) {
    targetMode = reader.readU8();
  }

  const savedSession = state.sessionsByToken.get(token);
  session.users = [];
  session.netSlotIds = [];
  session.equippedCharIds = [];

  for (let i = 0; i < playerCount; i++) {
    const uname = savedSession?.usernames[i] ?? usernames[i] ?? `player${session.sessionId}`;
    const auth = state.db.authenticateOrCreate(uname, "");
    if (auth.user) {
      session.users.push(auth.user);
      session.netSlotIds.push(savedSession?.netSlotIds[i] ?? state.allocateNetSlotId());
      session.equippedCharIds.push(savedSession?.charIds[i] ?? auth.user.equippedChar);
    }
  }

  const targetStage = targetMode === StageId.Shop ? StageId.Shop : StageId.Lobby;
  session.stageId = targetStage;

  if (targetStage === StageId.Lobby) {
    // S->C 33 (`CSelectServerStage::sub_56A9DA` -> `CStage::sub_4B96B1`)
    const w33 = new PacketWriter(ServerOpcode.SessionHandoffAck);
    if (state.config.enabledFeatures.has(22)) {
      w33.writeU8(0);
    }
    session.sendPacket(w33);

    // S->C 9 (`CStage::sub_4B8D42`)
    const w9 = new PacketWriter(ServerOpcode.StageTransition);
    w9.writeU32(StageId.Lobby);
    session.sendPacket(w9);

    // S->C 75 (`CStage::sub_4B94A6` -> triggers C->S 83 Enter Lobby)
    const w75 = new PacketWriter(ServerOpcode.QuestConfigSync);
    w75.writeU32(0); // questConfigCount = 0
    session.sendPacket(w75);
  } else {
    const w9 = new PacketWriter(ServerOpcode.StageTransition);
    w9.writeU32(targetStage);
    session.sendPacket(w9);
  }
}

/**
 * Unified Channel & Session Handoff handler (`CSelectServerStage` / `CLoginStage`)
 */
export function handleChannelPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  switch (opcode) {
    case ClientOpcode.SelectChannelLegacy:
    case ClientOpcode.SelectChannel:
      handleChannelSelect(state, session, reader);
      break;
    case ClientOpcode.SessionHandoff:
      handleSessionAuthHandoff(state, session, reader);
      break;
    case ClientOpcode.RequestChannelList8:
    case ClientOpcode.RequestChannelList:
    case ClientOpcode.RequestChannelList10:
      handlePostLoginChannelRequest(state, session, reader);
      break;
  }
}
