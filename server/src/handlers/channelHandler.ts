import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import {
  findCChannelByCategoryOrdinal,
  getCChannelCategoryOrdinal,
  normalizeCChannelCategory,
  writeCChannelCache,
} from "../protocol/channelCache.ts";
import { PacketReader, PacketWriter, ipv4ToUint32 } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import { formatClientOpcode, formatServerOpcode, logger } from "../utils/logger.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { handlePostLoginChannelRequest } from "./authHandler.ts";

/**
 * Builds S->C 10 (`CChannelCache::sub_5D3E91` -> `sub_5D3D3F`) and S->C 12
 * (`CChannelInfo::sub_5D4139`). The `channel2_001.ssd` row layout and category fields are
 * centralized in `protocol/channelCache.ts` to keep the wire representation and selection
 * ordinal logic in agreement.
 */
export function buildChannelListPacket(state: WorldState): PacketWriter {
  const stream = new SmartStreamWriter();
  writeCChannelCache(stream, state.channels);

  const packet = new PacketWriter(ServerOpcode.ChannelListSsd);
  packet.writeU8(1); // hasStream = 1 (`sub_5D3E91`)
  packet.writeSmartStream(stream, true);

  logger.debug("ChannelCache", `Built ${formatServerOpcode(ServerOpcode.ChannelListSsd)}`, {
    channelCount: state.channels.length,
    channels: state.channels.map((channel, channelIndex) => ({
      channelIndex,
      name: channel.name,
      maxUsers: channel.maxUsers,
      currentUsers: channel.currentUsers,
      categoryCode: channel.categoryCode,
      tabIndex: channel.tabIndex,
      categoryOrdinal: getCChannelCategoryOrdinal(state.channels, channelIndex),
    })),
  });
  return packet;
}

/** `S->C 12` is a u16 count followed by one u16 current-user count per cache row. */
export function buildChannelLoadsPacket(state: WorldState): PacketWriter {
  const packet = new PacketWriter(ServerOpcode.ChannelLoads);
  packet.writeU16(state.channels.length);
  for (const channel of state.channels) {
    packet.writeU16(channel.currentUsers);
  }
  return packet;
}

export function sendChannelListAndLoads(state: WorldState, session: ClientSession): void {
  session.sendPacket(buildChannelListPacket(state));
  session.sendPacket(buildChannelLoadsPacket(state));
}

/**
 * Handles C->S 5 (`CSelectServerStage::sub_56AF39`):
 *   u8 normalized category (`sub_5D4071`, normally 10)
 *   u32 category-relative ordinal (`sub_5D40F5`)
 *
 * Replies with S->C 7 (`CSelectServerStage::sub_56C0C8`):
 *   u8 result (0 = ErrCannotConnect, 1 = success)
 *   u8 normalized category
 *   u32 category-relative ordinal
 *   u32 IPv4 address
 *   u16 GameServer TCP port
 */
export function handleChannelSelect(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  let requestedCategory: number;
  let requestedOrdinal: number;
  let selected: ReturnType<typeof findCChannelByCategoryOrdinal>;

  if (reader.remaining >= 5) {
    requestedCategory = reader.readU8();
    requestedOrdinal = reader.readU32();
    selected = findCChannelByCategoryOrdinal(
      state.channels,
      requestedCategory,
      requestedOrdinal
    );
  } else {
    requestedCategory = reader.remaining >= 1 ? reader.readU8() : 0;
    requestedOrdinal = -1;
    selected = undefined;
  }

  logger.info("ChannelSelect", `Received ${formatClientOpcode(ClientOpcode.SelectChannel)}`, {
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: session.stageId,
    requestedCategory,
    normalizedCategory: normalizeCChannelCategory(requestedCategory),
    requestedOrdinal,
    remainingBytes: reader.remaining,
  });

  if (!selected || normalizeCChannelCategory(requestedCategory) !==
      normalizeCChannelCategory(selected.channel.categoryCode)) {
    logger.warn("ChannelSelect", "Rejected channel selection: no matching CChannelInfo", {
      sessionId: session.sessionId,
      requestedCategory,
      requestedOrdinal,
      availableChannels: state.channels.map((channel, channelIndex) => ({
        channelIndex,
        categoryCode: channel.categoryCode,
        normalizedCategory: normalizeCChannelCategory(channel.categoryCode),
        ordinal: getCChannelCategoryOrdinal(state.channels, channelIndex),
      })),
    });
    session.sendPacket(new PacketWriter(ServerOpcode.ChannelSelectResult).writeU8(0));
    return;
  }

  const { channel, channelIndex } = selected;
  const normalizedCategory = normalizeCChannelCategory(channel.categoryCode);
  const categoryOrdinal = getCChannelCategoryOrdinal(state.channels, channelIndex);
  session.channelIndex = channelIndex;

  // The client received this token in S->C 4; update its game-server handoff snapshot.
  if (session.authTokens.length === 0 && session.users.length > 0) {
    const token = state.allocateAuthToken(
      session.users.map((user) => user.username),
      session.netSlotIds,
      session.equippedCharIds
    );
    session.authTokens = session.users.map(() => token);
  }
  for (const token of new Set(session.authTokens)) {
    state.setAuthTokenChannel(token, channelIndex);
  }

  let serverIp: number;
  try {
    serverIp = ipv4ToUint32(state.config.publicIp);
  } catch (error) {
    logger.error("ChannelSelect", "Configured PUBLIC_IP is not a valid IPv4 address", {
      sessionId: session.sessionId,
      publicIp: state.config.publicIp,
      error: error instanceof Error ? error.message : String(error),
    });
    session.sendPacket(new PacketWriter(ServerOpcode.ChannelSelectResult).writeU8(0));
    return;
  }

  const response = new PacketWriter(ServerOpcode.ChannelSelectResult);
  response.writeU8(1); // result = success; 0 is ErrCannotConnect in sub_56C0C8
  response.writeU8(normalizedCategory);
  response.writeU32(categoryOrdinal);
  response.writeU32(serverIp);
  response.writeU16(state.config.gameTcpPort);
  session.sendPacket(response);

  logger.info("ChannelSelect", "Routed client to GameServer", {
    sessionId: session.sessionId,
    channelIndex,
    channelName: channel.name,
    categoryCode: channel.categoryCode,
    normalizedCategory,
    categoryOrdinal,
    remoteAddress: session.remoteAddress,
    advertisedAddress: state.config.publicIp,
    gameTcpPort: state.config.gameTcpPort,
    responseOpcode: formatServerOpcode(ServerOpcode.ChannelSelectResult),
  });
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
 * Lobby-target reply sequence:
 *   - S->C 33 (`CSelectServerStage::sub_56A9DA` -> `CStage::sub_4B96B1`):
 *       if feature 22 is enabled (true in TW): u8(0); transitions to Stage 11 (`CLobbyStage`)
 *   - S->C 75 (`CStage::sub_4B94A6`): u32 questConfigCount (0), prompting `C->S 83` (Enter Lobby)
 *
 * Do not send S->C 9 as a lobby stage transition here. `CSelectServerStage` falls back to
 * `CStage::sub_4BDBF5`, where opcode 9 calls `sub_4B8D42` and interprets the u32 as a
 * `Crash_CA.dmp` file offset, prompting a C->S 8 dump-chunk upload. The non-Lobby targetMode
 * path remains stage-specific and is intentionally left unchanged pending its own verification.
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
  session.channelIndex = savedSession?.channelIndex ?? session.channelIndex;
  session.authTokens = Array.from({ length: playerCount }, () => token);
  logger.info("SessionHandoff", "Received C->S 6 on the GameServer connection", {
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    remoteAddress: session.remoteAddress,
    remotePort: session.remotePort,
    tokenPresent: token !== 0,
    tokenFound: savedSession !== undefined,
    channelIndex: session.channelIndex,
    playerCount,
    usernames,
    targetMode,
  });

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
  logger.info("SessionHandoff", "Restored players on GameServer session", {
    sessionId: session.sessionId,
    stageId: targetStage,
    channelIndex: session.channelIndex,
    users: session.users.map((user) => user.username),
    netSlotIds: session.netSlotIds,
    tokenFound: savedSession !== undefined,
  });

  if (targetStage === StageId.Lobby) {
    // S->C 33 (`CSelectServerStage::sub_56A9DA` -> `CStage::sub_4B96B1`)
    const w33 = new PacketWriter(ServerOpcode.SessionHandoffAck);
    if (state.config.enabledFeatures.has(22)) {
      w33.writeU8(0);
    }
    session.sendPacket(w33);

    // S->C 75 (`CStage::sub_4B94A6` -> triggers C->S 83 Enter Lobby)
    const w75 = new PacketWriter(ServerOpcode.QuestConfigSync);
    w75.writeU32(0); // questConfigCount = 0
    session.sendPacket(w75);

    logger.info("SessionHandoff", "Sent source-confirmed Lobby handoff sequence", {
      sessionId: session.sessionId,
      stageId: StageId.Lobby,
      serverOpcodes: [
        formatServerOpcode(ServerOpcode.SessionHandoffAck),
        formatServerOpcode(ServerOpcode.QuestConfigSync),
      ],
      omittedOpcode9Reason:
        "CStage::sub_4B8D42 expects a Crash_CA.dmp file offset, not a stage id",
    });
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
    case ClientOpcode.RequestChannelList:
    case ClientOpcode.RequestChannelList10:
      handlePostLoginChannelRequest(state, session, reader);
      break;
  }
}
