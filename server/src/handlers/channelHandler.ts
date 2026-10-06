import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import {
  findCChannelByCategoryOrdinal,
  getCChannelCategoryOrdinal,
  normalizeCChannelCategory,
  writeCChannelCache,
} from "../protocol/channelCache.ts";
import { PacketReader, PacketWriter, ipv4ToUint32 } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import {
  formatClientOpcode,
  formatServerOpcode,
  formatStageId,
  formatU8Hex,
  logger,
} from "../utils/logger.ts";
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

  logger.debug("ChannelSelect", `Received ${formatClientOpcode(ClientOpcode.SelectChannel)}`, {
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
  session.channelSelected = true;

  // The client received this token in S->C 4; update its game-server handoff snapshot.
  if (session.authTokens.length === 0 && session.users.length > 0) {
    const token = state.allocateAuthToken(
      session.users.map((user) => user.username),
      session.netSlotIds,
      session.equippedCharIds,
      session.sessionId
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

  logger.info(
    "ChannelSelect",
    "Routed client to GameServer",
    {
      sessionId: session.sessionId,
      channelIndex,
      channelName: channel.name,
      categoryCode: channel.categoryCode,
      normalizedCategory,
      categoryOrdinal,
      remoteAddress: session.remoteAddress,
      advertisedAddress: state.config.publicIp,
      gameTcpPort: state.config.gameTcpPort,
      responseOpcode: formatServerOpcode(ServerOpcode.ChannelSelectResult, session.stageId),
    },
    {
      displayData: {
        sessionId: session.sessionId,
        channelName: channel.name,
        categoryOrdinal,
        advertisedAddress: state.config.publicIp,
        gameTcpPort: state.config.gameTcpPort,
      },
    }
  );
}

/**
 * The client has three observed C->S 6 writers; they are not one interchangeable schema:
 *
 * - `sub_5D893D` (called by `CSelectServerStage::sub_56C0C8` after successful S->C 7):
 *   `u8 count`, each `[str username, u32 field95 (LoginResult session token),
 *   u32 field97 (meaning unknown)]`, then `[u8 CNetworkFacade+8, u32 handoffFieldA,
 *   u32 handoffFieldB]`.
 * - `sub_5D8A3F`: `u8 count`, each `[str username, u32 field95]`, then one byte.
 *   At the `sub_4B3BF9` call site that byte is `sub_5AA664`'s current StageId, not a
 *   destination StageId.
 * - `sub_5D8879`: `u8 count`, each `[str username, u32 field95]`.
 *
 * Only the full `sub_5D893D` layout is the confirmed SelectServer -> GameServer handoff.
 * Its `CNetworkFacade+8` byte and two trailing u32s are retained as opaque fields; none is
 * compared to a `StageId`.
 *
 * After that handoff the client-side `CSelectServerStage` has state 2. Its root vtable
 * dispatches S->C 13 to `sub_56A9DA`, which passes the feature-22 byte (TW sends `u8(0)`)
 * to `CStage::sub_4B96B1` and requests `StageId.Lobby` (11). S->C 75 then invokes
 * `CStage::sub_4B94A6`, which sends C->S 83 and, when feature 32 is enabled, an empty C->S 338.
 *
 * Do not send S->C 9 as a Lobby transition: the SelectServer fallback interprets S->C 9 as
 * a `Crash_CA.dmp` file offset (`sub_4B8D42`) and prompts a C->S 8 dump-chunk upload.
 */
export type SessionHandoffWireLayout = "sub_5D893D" | "sub_5D8A3F" | "sub_5D8879" | "unknown";

export interface SessionHandoffPlayerFields {
  username: string;
  sessionToken: number;
  /** Per-player u32 read by `sub_5D92F2`; business meaning is not established. */
  field97U32?: number;
}

export interface ParsedSessionHandoffPayload {
  declaredPlayerCount: number;
  players: SessionHandoffPlayerFields[];
  wireLayout: SessionHandoffWireLayout;
  /** The byte read from `CNetworkFacade+8` by `sub_5D893D`; its meaning is unknown. */
  networkObjectByte?: number;
  /** The single byte written by `sub_5D8A3F` (current StageId at the traced call site). */
  reconnectContextByte?: number;
  trailingHandoffFieldsU32: number[];
  unreadTrailingBytes: number;
}

/** Parse the source-derived C->S 6 variants without conflating their trailing bytes. */
export function parseSessionHandoffPayload(reader: PacketReader): ParsedSessionHandoffPayload {
  const declaredPlayerCount = reader.remaining >= 1 ? reader.readU8() : 0;
  const playerCount = Math.min(2, Math.max(1, declaredPlayerCount));
  const playersStart = reader.offset;
  type HandoffCandidate = ParsedSessionHandoffPayload & { endOffset: number };

  const tryParseLayout = (
    wireLayout: SessionHandoffWireLayout,
    hasField97: boolean,
    expectedTailBytes: number
  ): HandoffCandidate | undefined => {
    const probe = new PacketReader(reader.plain, reader.degree, false);
    probe.offset = playersStart;
    const players: SessionHandoffPlayerFields[] = [];

    for (let index = 0; index < playerCount; index++) {
      if (probe.remaining < 2) return undefined;
      const stringOffset = probe.offset;
      const username = probe.readString();
      if (probe.offset === stringOffset || probe.remaining < (hasField97 ? 8 : 4)) {
        return undefined;
      }
      const sessionToken = probe.readU32();
      const player: SessionHandoffPlayerFields = { username, sessionToken };
      if (hasField97) player.field97U32 = probe.readU32();
      players.push(player);
    }

    if (probe.remaining !== expectedTailBytes) return undefined;

    let networkObjectByte: number | undefined;
    let reconnectContextByte: number | undefined;
    const trailingHandoffFieldsU32: number[] = [];
    if (wireLayout === "sub_5D893D") {
      networkObjectByte = probe.readU8();
      trailingHandoffFieldsU32.push(probe.readU32(), probe.readU32());
    } else if (wireLayout === "sub_5D8A3F") {
      reconnectContextByte = probe.readU8();
    }

    if (probe.remaining !== 0) return undefined;
    return {
      declaredPlayerCount,
      players,
      wireLayout,
      ...(networkObjectByte === undefined ? {} : { networkObjectByte }),
      ...(reconnectContextByte === undefined ? {} : { reconnectContextByte }),
      trailingHandoffFieldsU32,
      unreadTrailingBytes: 0,
      endOffset: probe.offset,
    };
  };

  const candidate =
    tryParseLayout("sub_5D893D", true, 9) ??
    tryParseLayout("sub_5D8A3F", false, 1) ??
    tryParseLayout("sub_5D8879", false, 0);
  if (candidate) {
    reader.offset = candidate.endOffset;
    const { endOffset: _endOffset, ...parsed } = candidate;
    return parsed;
  }

  // Preserve a useful username/token prefix for malformed or unrecognized variants, while
  // leaving the rest unread so the handoff log exposes the exact unparsed tail length.
  const fallback = new PacketReader(reader.plain, reader.degree, false);
  fallback.offset = playersStart;
  const players: SessionHandoffPlayerFields[] = [];
  for (let index = 0; index < playerCount; index++) {
    if (fallback.remaining < 2) break;
    const stringOffset = fallback.offset;
    const username = fallback.readString();
    if (fallback.offset === stringOffset || fallback.remaining < 4) break;
    players.push({ username, sessionToken: fallback.readU32() });
  }
  reader.offset = fallback.offset;
  return {
    declaredPlayerCount,
    players,
    wireLayout: "unknown",
    trailingHandoffFieldsU32: [],
    unreadTrailingBytes: reader.remaining,
  };
}

/**
 * Handles the confirmed channel-select C->S 6 (`sub_5D893D`) on a GameServer session.
 * Other same-opcode client writers are parsed for diagnostics, but are not treated as a
 * Lobby destination without independent stage-specific evidence.
 */
export function handleSessionAuthHandoff(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  const handoff = parseSessionHandoffPayload(reader);
  const playerCount = handoff.players.length;
  const usernames = handoff.players.map(
    (player, index) => player.username || `player${session.sessionId}_${index + 1}`
  );
  const tokens = handoff.players.map((player) => player.sessionToken);
  const token = tokens[0] ?? 0;
  const savedSession = state.sessionsByToken.get(token);

  logger.debug("SessionHandoff", `Received ${formatClientOpcode(ClientOpcode.SessionHandoff)}`, {
    sessionId: session.sessionId,
    linkedLoginSessionId: savedSession?.loginSessionId,
    connectionKind: session.connectionKind,
    remoteAddress: session.remoteAddress,
    remotePort: session.remotePort,
    wireLayout: handoff.wireLayout,
    declaredPlayerCount: handoff.declaredPlayerCount,
    playerCount,
    players: handoff.players.map((player, index) => ({
      username: usernames[index],
      tokenPresent: player.sessionToken !== 0,
      field97Present: player.field97U32 !== undefined,
    })),
    networkObjectByte:
      handoff.networkObjectByte === undefined
        ? undefined
        : `${handoff.networkObjectByte} (${formatU8Hex(handoff.networkObjectByte)})`,
    reconnectContextByte:
      handoff.reconnectContextByte === undefined
        ? undefined
        : `${handoff.reconnectContextByte} (${formatU8Hex(handoff.reconnectContextByte)})`,
    trailingHandoffFieldCount: handoff.trailingHandoffFieldsU32.length,
    unreadTrailingBytes: handoff.unreadTrailingBytes,
    tokenFound: savedSession !== undefined,
  });

  const rejectHandoff = (reason: string): void => {
    logger.warn("SessionHandoff", "Rejected GameServer session handoff; no Lobby transition sent", {
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      wireLayout: handoff.wireLayout,
      declaredPlayerCount: handoff.declaredPlayerCount,
      parsedPlayerCount: playerCount,
      tokenPresent: token !== 0,
      tokenFound: savedSession !== undefined,
      rejectionReason: reason,
    });
  };

  if (session.connectionKind !== "game") {
    rejectHandoff("not-a-GameServer-connection");
    return;
  }
  if (handoff.wireLayout !== "sub_5D893D") {
    rejectHandoff("unconfirmed-C-to-S-6-layout");
    return;
  }
  if (
    handoff.declaredPlayerCount < 1 ||
    handoff.declaredPlayerCount > 2 ||
    handoff.declaredPlayerCount !== playerCount
  ) {
    rejectHandoff("invalid-local-player-count");
    return;
  }
  if (!savedSession || token === 0) {
    rejectHandoff("no-auth-session-for-token");
    return;
  }
  if (savedSession.channelIndex === null) {
    rejectHandoff("channel-not-selected-for-token");
    return;
  }
  if (
    savedSession.usernames.length !== playerCount ||
    savedSession.netSlotIds.length !== playerCount ||
    savedSession.charIds.length !== playerCount
  ) {
    rejectHandoff("saved-session-player-count-mismatch");
    return;
  }
  if (tokens.length !== playerCount || tokens.some((playerToken) => playerToken !== token)) {
    rejectHandoff("player-auth-token-mismatch");
    return;
  }
  if (
    handoff.players.some(
      (player, index) => player.username.toLowerCase() !== savedSession.usernames[index]!.toLowerCase()
    )
  ) {
    rejectHandoff("player-name-does-not-match-token");
    return;
  }

  const restoredUsers: ClientSession["users"] = [];
  for (const username of savedSession.usernames) {
    const user = state.db.getUserByUsername(username);
    if (!user) {
      rejectHandoff("saved-user-no-longer-exists");
      return;
    }
    restoredUsers.push(user);
  }

  session.channelIndex = savedSession.channelIndex;
  session.channelSelected = true;
  session.authTokens = [...tokens];
  session.users = restoredUsers;
  session.netSlotIds = [...savedSession.netSlotIds];
  session.equippedCharIds = [...savedSession.charIds];

  const previousStageId = session.stageId;
  session.stageId = StageId.SelectServer;
  session.linkedLoginSessionId = savedSession.loginSessionId;
  session.pendingStageId = StageId.Lobby;
  logger.info("SessionHandoff", "Authenticated GameServer handoff; Lobby transition pending", {
    sessionId: session.sessionId,
    gameSessionId: session.sessionId,
    loginSessionId: session.linkedLoginSessionId,
    previousStageId,
    previousStage: formatStageId(previousStageId),
    currentStageId: session.stageId,
    currentStage: formatStageId(session.stageId),
    pendingStageId: session.pendingStageId,
    pendingStage: formatStageId(StageId.Lobby),
    channelIndex: session.channelIndex,
    users: session.users.map((user) => user.username),
    netSlotIds: session.netSlotIds,
    tokenFound: savedSession !== undefined,
    lobbyEntrySignalObserved: session.lobbyEntryPacketSeen,
  }, {
    displayData: {
      sessionId: session.sessionId,
      loginSessionId: session.linkedLoginSessionId,
      previousStage: formatStageId(previousStageId),
      pendingStage: formatStageId(StageId.Lobby),
      lobbyEntrySignalObserved: session.lobbyEntryPacketSeen,
    },
  });

  // S->C 13: root-vtable slot 48 -> sub_56A9DA -> sub_4B96B1 -> StageId.Lobby (11).
  const lobbyTransition = new PacketWriter(ServerOpcode.LobbyStageTransition);
  if (state.config.enabledFeatures.has(22)) {
    lobbyTransition.writeU8(0); // Taiwan feature 22: sub_4B96B1 consumes one byte.
  }
  session.sendPacket(lobbyTransition);

  // S->C 75: sub_4B94A6 prompts C->S 83 and, with feature 32, an empty C->S 338. The client's
  // sub_5AD7DE packet drain stops when the requested StageId differs, leaving 75 for
  // dispatch after the main loop constructs the StageId 11 Lobby stage.
  const questConfigSync = new PacketWriter(ServerOpcode.QuestConfigSync);
  questConfigSync.writeU32(0); // questConfigCount = 0
  session.sendPacket(questConfigSync);

  logger.info("SessionHandoff", "Sent GameServer Lobby transition sequence", {
    sessionId: session.sessionId,
    gameSessionId: session.sessionId,
    loginSessionId: session.linkedLoginSessionId,
    currentStageId: session.stageId,
    currentStage: formatStageId(session.stageId),
    pendingStageId: session.pendingStageId,
    targetStageId: StageId.Lobby,
    targetStage: formatStageId(StageId.Lobby),
    serverOpcodes: [
      formatServerOpcode(ServerOpcode.LobbyStageTransition, session.stageId),
      formatServerOpcode(ServerOpcode.QuestConfigSync, session.stageId),
    ],
    feature22Enabled: state.config.enabledFeatures.has(22),
    opcode13PayloadBytes: state.config.enabledFeatures.has(22) ? 1 : 0,
    lobbyEntrySignalObserved: session.lobbyEntryPacketSeen,
    clientAcceptanceVerified: false,
    clientStageLifecyclePath:
      "sub_4B96B1 -> sub_5AAA5C(StageId 11) -> CMainSystem::sub_5AA3F4 -> sub_5AEF3F(CMainWnd*)",
    clientStageLifecycleRuntimeVerified: false,
  }, {
    displayData: {
      sessionId: session.sessionId,
      loginSessionId: session.linkedLoginSessionId,
      targetStage: formatStageId(StageId.Lobby),
      serverOpcodes: [
        formatServerOpcode(ServerOpcode.LobbyStageTransition, session.stageId),
        formatServerOpcode(ServerOpcode.QuestConfigSync, session.stageId),
      ],
      lobbyEntrySignalObserved: session.lobbyEntryPacketSeen,
      clientAcceptanceVerified: false,
    },
  });
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
    case ClientOpcode.SelectChannel:
      handleChannelSelect(state, session, reader);
      break;
    case ClientOpcode.SessionHandoff:
      handleSessionAuthHandoff(state, session, reader);
      break;
    case ClientOpcode.RequestChannelList:
      handlePostLoginChannelRequest(state, session, reader);
      break;
  }
}
