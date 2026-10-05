import { decodeUdpDatagram, MTUDPPeer } from "../protocol/framing.ts";
import {
  ClientOpcode,
  ClientUdpOpcode,
  ClientUdpPeerControlCode,
  ReconstructedServerUdpPeerControlCode,
  ReconstructedUdpInputOpcode,
  ServerUdpOpcode,
  StageId,
  UdpPeerEnvelopeKind,
} from "../protocol/opcodes.ts";
import { PacketReader, ipv4ToUint32 } from "../protocol/primitives.ts";
import {
  formatClientOpcode,
  formatClientUdpOpcode,
  formatReconstructedUdpInputOpcode,
  formatStageId,
  logger,
} from "../utils/logger.ts";
import type { ClientSession, UdpEndpoint, WorldState } from "../state/worldState.ts";
import { handleAuthPacket } from "./authHandler.ts";
import { handleChannelPacket } from "./channelHandler.ts";
import { handleCommonPacket } from "./commonHandler.ts";
import { handleGamePacket, markSessionGameLoaded } from "./gameHandler.ts";
import { handleLobbyPacket } from "./lobbyHandler.ts";
import { handleRoomPacket } from "./roomHandler.ts";
import { handleShopPacket } from "./shopHandler.ts";

function getObservedUdpEndpoint(remoteAddress: string, remotePort: number): UdpEndpoint {
  const address = remoteAddress.toLowerCase().startsWith("::ffff:")
    ? remoteAddress.slice(7)
    : remoteAddress;
  try {
    const ip = ipv4ToUint32(address);
    return ip === 0 ? { ip: 0, port: 0 } : { ip, port: remotePort };
  } catch {
    // This client protocol has IPv4-only peer endpoint fields. Mark an unsupported
    // source as absent rather than fabricating a loopback candidate.
    return { ip: 0, port: 0 };
  }
}

const AUTH_OPCODES = new Set<number>([
  ClientOpcode.PreLoginSsdCheck,
  ClientOpcode.LoginCredentials,
  ClientOpcode.UnresolvedClientPacket4,
  ClientOpcode.LoginPassport,
  ClientOpcode.NewUserIdentifierCheck3,
  ClientOpcode.LoginBeanfunToken,
  ClientOpcode.EKeyVerify,
  ClientOpcode.EKeyChallengeResponse,
  ClientOpcode.UnresolvedClientPacket34,
  ClientOpcode.UnresolvedClientPacket35,
  ClientOpcode.UnresolvedClientPacket36,
  ClientOpcode.ChangeAccountPassword,
]);

const CHANNEL_OPCODES = new Set<number>([
  ClientOpcode.SelectChannel,
  ClientOpcode.SessionHandoff,
  ClientOpcode.RequestChannelList,
]);

const SHOP_OPCODES = new Set<number>([
  ClientOpcode.RequestShopConnection,
  ClientOpcode.AuthenticateShopConnection,
  ClientOpcode.ShopEnter,
  ClientOpcode.ShopBuyItem,
  ClientOpcode.InventoryDeleteItem,
  ClientOpcode.ShopAction,
  ClientOpcode.ShopUseOrEquip274,
  ClientOpcode.ShopInventoryTab275,
  ClientOpcode.RequestFxStockIni,
  ClientOpcode.ShopBillingCheck,
  ClientOpcode.RequestStringTableIni,
  ClientOpcode.ShopSendGift,
  ClientOpcode.ShopBuy280,
  ClientOpcode.RequestPackageMapIni,
  ClientOpcode.ShopResellItem,
  ClientOpcode.NexonClubAuth,
  ClientOpcode.ShopIdentifyQMark,
  ClientOpcode.RedeemCouponCode,
  ClientOpcode.ShopSaveSlotOrder,
  ClientOpcode.ShopStateSync,
  ClientOpcode.QueryAvatarLucciSync,
  ClientOpcode.GachaponRoll,
  ClientOpcode.GachaponClose,
  ClientOpcode.ShopBuyItemPass,
  ClientOpcode.UnresolvedClientPacket310,
  ClientOpcode.BasketOpen,
  ClientOpcode.BasketQueryInfo,
  ClientOpcode.BasketQueryCoupons,
  ClientOpcode.BasketThrowAway,
  ClientOpcode.RequestShopConnectionAlt,
  ClientOpcode.ShopActionNotify,
  ClientOpcode.RequestUserMarketConnection,
  ClientOpcode.UserMarketFeeInfoReply320,
  ClientOpcode.UserMarketStageEntry321,
  ClientOpcode.StageAction323,
  ClientOpcode.UserMarketStageSync324,
  ClientOpcode.UserMarketFilterState325,
  ClientOpcode.UserMarketRegisterListing326,
  ClientOpcode.UserMarketCancelListing,
  ClientOpcode.UserMarketSearchText328,
  ClientOpcode.UserMarketTransferLucci,
  ClientOpcode.UserMarketBuyListing,
]);

// Keep ordinary packet logs quiet at INFO while retaining the statically evidenced packets
// that can appear on the Shop-connection path. This records packet arrival only; it does not
// establish that a UI click reached a callback or caused the packet.
const SHOP_FLOW_CANDIDATE_ROLES: ReadonlyMap<number, string> = new Map([
  [ClientOpcode.RequestShopConnection, "initial-state candidate"],
  [ClientOpcode.RequestShopConnectionAlt, "initial-state candidate"],
  [ClientOpcode.ShopEnter, "initial-state candidate"],
  [ClientOpcode.AuthenticateShopConnection, "conditional follow-up"],
  [ClientOpcode.RequestUserMarketConnection, "conditional follow-up"],
  [ClientOpcode.RoomAux98, "conditional follow-up; opcode 98 is shared"],
  [ClientOpcode.RequestFxStockIni, "Shop-stage cache request"],
  [ClientOpcode.RequestStringTableIni, "Shop-stage cache request"],
  [ClientOpcode.RequestPackageMapIni, "Shop-stage cache request"],
]);

const LOBBY_OPCODES = new Set<number>([
  ClientOpcode.CreateRoom,
  ClientOpcode.JoinRoom,
  ClientOpcode.QuickJoin,
  ClientOpcode.CreateRoomShort,
  ClientOpcode.RoomListScrollOrDetail,
  ClientOpcode.QuickJoinShort,
  ClientOpcode.ReturnToRoom,
  ClientOpcode.EnterLobby,
]);

const ROOM_OPCODES = new Set<number>([
  ClientOpcode.LeaveRoom,
  ClientOpcode.UpdateRoomSettings,
  ClientOpcode.ToggleReady,
  ClientOpcode.SelectMap,
  ClientOpcode.SelectTeamColor,
  ClientOpcode.SelectCharacter,
  ClientOpcode.ToggleSlotOpen,
  ClientOpcode.KickPlayer,
  ClientOpcode.BanVoteResponse,
  ClientOpcode.StartMatch,
  ClientOpcode.ChangeRoomPassword,
  ClientOpcode.PracticeHandicap,
  ClientOpcode.RoomAux98,
  ClientOpcode.RoomAvatarSync,
  ClientOpcode.ExchangeAction,
  ClientOpcode.ExchangePassCheck,
]);

const COMMON_OPCODES = new Set<number>([
  ClientOpcode.ClientSignal10,
  ClientOpcode.NexonClubAuthRequest29,
  ClientOpcode.LobbyConditionalSignal261,
  ClientOpcode.UploadCrashReport,
  ClientOpcode.UploadCrashDump,
  ClientOpcode.ClientReportOrLobbyEnter,
  ClientOpcode.ReturnToChannelSelect,
  ClientOpcode.ClientPeriodicStatus,
  ClientOpcode.ContextualClientPacket16,
  ClientOpcode.PingReplyOrWhisper,
  ClientOpcode.MessengerInviteUser,
  ClientOpcode.RoomEmotion,
  ClientOpcode.RequestDynI16Table,
  ClientOpcode.RequestAvatarI16Table,
  ClientOpcode.MacroListQuery,
  ClientOpcode.QuestAction,
  ClientOpcode.QueryRankingPage,
  ClientOpcode.ModifyUserInfo,
  ClientOpcode.QueryUserInfo66,
  ClientOpcode.UserPagePacket68,
  ClientOpcode.QueryUserBrief,
  ClientOpcode.QueryUserInfo,
  ClientOpcode.UpdateUserOptions,
  ClientOpcode.UseSuperSpeaker,
  ClientOpcode.SaveDefaultChars,
  ClientOpcode.UpdatePremiumSlotState,
  ClientOpcode.EquipQuickSlotOrEmotion,
  ClientOpcode.TeamChat,
  ClientOpcode.MyPageUpdateBadge,
  ClientOpcode.RoomChiefBroadcast,
  ClientOpcode.ReportPlayer,
  ClientOpcode.CancelAction,
  ClientOpcode.RequestDynamicMapInfoSsd,
  ClientOpcode.UserDetailQuery,
  ClientOpcode.UserPagePacket290,
  ClientOpcode.UserGuildModify,
  ClientOpcode.UserPagePacket293,
  ClientOpcode.QueryTop3Rank,
  ClientOpcode.SmsSend,
  ClientOpcode.SmsQuery,
  ClientOpcode.SmsDelete,
  ClientOpcode.SmsDeleteAll,
  ClientOpcode.LobbyInitQuery,
  ClientOpcode.MyPagePreOpen,
  ClientOpcode.CouplePropose,
  ClientOpcode.CoupleBreakup,
  ClientOpcode.QueryMyCharacterRank,
  ClientOpcode.SecurityHashReply1,
  ClientOpcode.SecurityHashReply2,
  ClientOpcode.ClientAuditLog,
  ClientOpcode.PostStageSync338,
  ClientOpcode.NexonClubDialogSubmit322,
]);

interface UnresolvedClientCandidate {
  explanation: string;
  payloadSchema?: string;
  semanticRole?: string;
}

const UNRESOLVED_CLIENT_CANDIDATES: ReadonlyMap<number, UnresolvedClientCandidate> = new Map([
  [
    ClientOpcode.UnresolvedClientPacket17,
    {
      explanation:
        "No current-build Client writer recovered; the former agreement writer address is inside Practice UI code, and no StageId 8/9 factory path is established",
    },
  ],
  [
    ClientOpcode.UnresolvedClientPacket18,
    { explanation: "No direct numeric Client writer recovered in the bounded current-build census" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket19,
    { explanation: "No current-build writer recovered; CChatStage::sub_4AD598 writes 16, 20, and 97, not 19" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket30,
    { explanation: "No direct numeric Client writer recovered in the bounded current-build census" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket49,
    { explanation: "No direct numeric Client writer recovered in the bounded current-build census" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket252,
    { explanation: "No current-build writer or packagemap.ini request/reply association recovered" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket266,
    { explanation: "No current-build writer recovered; do not alias this candidate to the distinct C->S 99 writer" },
  ],
  [
    ClientOpcode.UnresolvedClientPacket267,
    { explanation: "No current-build notice-URL request writer or response association recovered" },
  ],
  [
    ClientOpcode.LobbyInitializationSignal294,
    {
      explanation:
        "The recovered Lobby-setup writer sends an empty packet; its meaning and response association are UNKNOWN, not a stringtable checksum request",
      payloadSchema: "empty in the recovered writer",
      semanticRole: "Lobby setup signal; detailed role UNKNOWN",
    },
  ],
]);

function observeUnresolvedClientCandidate(
  session: ClientSession,
  opcode: number,
  reader: PacketReader,
  candidate: UnresolvedClientCandidate
): void {
  logger.info("PacketAudit", `Observed ${formatClientOpcode(opcode)}; ${candidate.explanation}`, {
    direction: "C->S",
    wireOpcode: opcode,
    opcodeName: formatClientOpcode(opcode),
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    payloadBytes: reader.remaining,
    payloadSchema: candidate.payloadSchema ?? "UNKNOWN",
    semanticRole: candidate.semanticRole ?? "UNKNOWN",
    responseAssociation: "UNKNOWN",
    responseSent: false,
    databaseMutation: false,
  });
}

/**
 * Central TCP packet dispatcher corresponding to `CPacketDispatcher::sub_5D821C` (`0x005D821C`)
 * and `CStage::OnPacket` (`0x004BDBF5`) + derived stage `OnPacket` virtual overrides.
 */
export function dispatchTcpPacket(
  state: WorldState,
  session: ClientSession,
  reader: PacketReader
): void {
  const { opcode } = reader;
  session.recordPacketTrace("C->S", opcode, reader.plain.length);
  logger.debug("Dispatcher", `Received ${formatClientOpcode(opcode)}`, {
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    remainingPayloadBytes: reader.remaining,
  });

  const shopFlowRole = SHOP_FLOW_CANDIDATE_ROLES.get(opcode);
  if (shopFlowRole) {
    const shopTraceData = {
      direction: "C->S",
      opcode: formatClientOpcode(opcode),
      sessionId: session.sessionId,
      connectionKind: session.connectionKind,
      remoteAddress: session.remoteAddress,
      remotePort: session.remotePort,
      localPort: session.localPort,
      stageId: formatStageId(session.stageId),
      payloadBytes: reader.remaining,
      candidateRole: shopFlowRole,
    };
    logger.info(
      "ShopTrace",
      `Observed Shop-flow candidate packet: C->S ${formatClientOpcode(opcode)}`,
      shopTraceData,
      {
        displayData: {
          sessionId: shopTraceData.sessionId,
          connectionKind: shopTraceData.connectionKind,
          remoteAddress: shopTraceData.remoteAddress,
          remotePort: shopTraceData.remotePort,
          localPort: shopTraceData.localPort,
          stageId: shopTraceData.stageId,
          payloadBytes: shopTraceData.payloadBytes,
          candidateRole: shopTraceData.candidateRole,
        },
      }
    );
  }

  const logRoute = (handler: string): void => {
    logger.debug("Dispatcher", "Routing client packet", {
      sessionId: session.sessionId,
      opcode: formatClientOpcode(opcode),
      stageId: formatStageId(session.stageId),
      handler,
    });
  };

  // C->S 16 has source-backed chat writers in CChatStage, but the former pre-login
  // COnePageIDStage ID-check attribution is not present in this build. Observe that
  // pre-login context without sending the guessed S->C 59 response.
  if (opcode === ClientOpcode.ContextualClientPacket16 && session.stageId < StageId.SelectServer) {
    observeUnresolvedClientCandidate(session, opcode, reader, {
      explanation:
        "C->S 16 is used by recovered chat/speaker writers in CChatStage; no pre-login ID-check writer or S->C 59 association is established",
    });
    return;
  }

  const unresolvedCandidate = UNRESOLVED_CLIENT_CANDIDATES.get(opcode);
  if (unresolvedCandidate) {
    observeUnresolvedClientCandidate(session, opcode, reader, unresolvedCandidate);
    return;
  }

  // The current Client writer for C->S 305 is the 2-byte CCouple response. Do not
  // reinterpret a different-sized body as the former, unsupported FxStock-check alias.
  if (opcode === ClientOpcode.CoupleRespond) {
    if (reader.remaining === 2) {
      logRoute("handleCommonPacket (C->S 305 CoupleRespond)");
      handleCommonPacket(state, session, opcode, reader);
    } else {
      observeUnresolvedClientCandidate(session, opcode, reader, {
        explanation:
          "The recovered C->S 305 CoupleRespond writer is exactly two bytes; no alternate FxStock-check writer is established",
      });
    }
    return;
  }

  // 1. Pre-login, Registration & Authentication opcodes with current-build writer evidence.
  if (AUTH_OPCODES.has(opcode)) {
    logRoute("handleAuthPacket");
    handleAuthPacket(state, session, opcode, reader);
    return;
  }

  // 2. Server / Channel Selection & Session Handoff opcodes (`CSelectServerStage`)
  if (CHANNEL_OPCODES.has(opcode)) {
    logRoute("handleChannelPacket");
    handleChannelPacket(state, session, opcode, reader);
    return;
  }

  // 3. Shop / Inventory / Market / `.ini` stream opcodes (`CShopConnectionMan` & `CShopStageNew`)
  if (SHOP_OPCODES.has(opcode)) {
    logRoute("handleShopPacket");
    handleShopPacket(state, session, opcode, reader);
    return;
  }

  // 4. Opcode 67: Either `CStage::sub_4BA6C0` (`[u16 idx, u32 key]` -> `S->C 83`) or username query (`[str username]` -> `S->C 70` + `S->C 81`)
  if (opcode === ClientOpcode.RoomDetailOrUserInfo) {
    const saved = reader.offset;
    if (reader.remaining >= 2) {
      const len = reader.readU16();
      reader.offset = saved;
      if (len > 0 && len + 2 === reader.remaining && reader.remaining !== 6) {
        logRoute("handleCommonPacket (RoomDetailOrUserInfo username query)");
        handleCommonPacket(state, session, opcode, reader);
        return;
      }
      if (len + 2 === reader.remaining && reader.remaining === 6) {
        const clone = new PacketReader(reader.plain, reader.degree);
        const maybeStr = clone.readString();
        if (/^[\x20-\x7e]+$/.test(maybeStr)) {
          logRoute("handleCommonPacket (RoomDetailOrUserInfo username query)");
          handleCommonPacket(state, session, opcode, reader);
          return;
        }
      }
    }
    logRoute("handleLobbyPacket (RoomDetailOrUserInfo lobby form)");
    handleLobbyPacket(state, session, opcode, reader);
    return;
  }

  // 5. Lobby Stage opcodes (`CLobbyStage`: room list, create room, join room, quick join)
  if (LOBBY_OPCODES.has(opcode)) {
    logRoute("handleLobbyPacket");
    handleLobbyPacket(state, session, opcode, reader);
    return;
  }

  // 6. Prepare / Room Stage opcodes (`CPrepareStage`: map, character, team, ready, start, leave)
  if (
    ROOM_OPCODES.has(opcode) ||
    (opcode === ClientOpcode.EquipQuickSlotOrEmotion && reader.remaining >= 5)
  ) {
    logRoute("handleRoomPacket");
    handleRoomPacket(state, session, opcode, reader);
    return;
  }

  // 7. In-Game Match Stage opcodes (`CGameStage`: load ready, bombs, items, death, finish, relay)
  if (opcode >= ClientOpcode.PlaceBomb && opcode <= 153) {
    logRoute("handleGamePacket");
    handleGamePacket(state, session, opcode, reader);
    return;
  }

  // 8. Common / Chat / Cross-stage opcodes (`CStage`, `CChatStage`, `CPacketDispatcher`)
  if (COMMON_OPCODES.has(opcode)) {
    logRoute("handleCommonPacket");
    handleCommonPacket(state, session, opcode, reader);
    return;
  }

  logger.warn("Dispatcher", "No TCP handler matched client packet", {
    sessionId: session.sessionId,
    opcode: formatClientOpcode(opcode),
    stageId: formatStageId(session.stageId),
    unhandledPayloadBytes: reader.remaining,
  });
}

export interface UdpOutDatagram {
  address: string;
  port: number;
  datagram: Uint8Array;
}

/**
 * Handles an incoming UDP datagram framed with `MTUDPPeer` (`0x005EBFA0`):
 *   `[u8 L = 1 + inner.length][inner][u8 CRC8(0, frame[0..L])]`
 * Mirrors `MTUDPPeer::sub_5EBF73` by processing every concatenated frame in order.
 */
export function dispatchUdpDatagram(
  state: WorldState,
  rawDatagram: Uint8Array,
  remoteAddress: string,
  remotePort: number
): UdpOutDatagram[] {
  let chunks: Uint8Array[];
  try {
    chunks = decodeUdpDatagram(rawDatagram);
  } catch (error) {
    logger.warn("UDPDispatcher", "Rejected invalid MTUDPPeer datagram", {
      remoteAddress,
      remotePort,
      byteCount: rawDatagram.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (chunks.length === 0 || chunks.some((chunk) => chunk.length === 0)) {
    logger.warn("UDPDispatcher", "Rejected empty MTUDPPeer datagram or frame", {
      remoteAddress,
      remotePort,
      byteCount: rawDatagram.length,
      chunkCount: chunks.length,
    });
    return [];
  }

  if (chunks.length > 1) {
    logger.debug("UDPDispatcher", "Processing multiple MTUDPPeer frames in one datagram", {
      remoteAddress,
      remotePort,
      byteCount: rawDatagram.length,
      chunkCount: chunks.length,
    });
  }

  const out: UdpOutDatagram[] = [];
  for (const inner of chunks) {
    const framedInner = MTUDPPeer.encodeFrame(inner);
    out.push(...dispatchUdpFrame(state, framedInner, inner, remoteAddress, remotePort));
  }
  return out;
}

function dispatchUdpFrame(
  state: WorldState,
  framedInner: Uint8Array,
  inner: Uint8Array,
  remoteAddress: string,
  remotePort: number
): UdpOutDatagram[] {
  const opcodeForLog = inner.length >= 2 && inner[0] === 0 ? inner[1]! : inner[0]!;
  const messageKind =
    inner.length === 6 &&
    inner[0] === 0 &&
    inner[1] === ReconstructedUdpInputOpcode.KeepaliveProbe
      ? "reconstructed-keepalive-probe"
      : inner.length >= 12 &&
          inner[0] === 0 &&
          inner[1] === ClientUdpOpcode.GameLoadRegistration
        ? "game-load-registration"
        : inner.length === 3 && inner[0] === UdpPeerEnvelopeKind.Control
          ? "peer-route-probe/control"
          : inner[0] === UdpPeerEnvelopeKind.GameData
            ? "peer-game-data"
            : "unclassified";
  logger.debug("UDPDispatcher", "Decoded MTUDPPeer frame", {
    remoteAddress,
    remotePort,
    messageKind,
    udpOpcode:
      messageKind === "reconstructed-keepalive-probe"
        ? formatReconstructedUdpInputOpcode(opcodeForLog)
        : messageKind === "game-load-registration"
          ? formatClientUdpOpcode(opcodeForLog)
          : undefined,
    innerBytes: inner.length,
  });
  const out: UdpOutDatagram[] = [];
  const dv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);

  // 1. Reconstructed inbound `[u16(0), u32(userId)]` candidate -> local `[u8(4)]` policy; sender/cadence and production reply remain unverified.
  if (
    inner.length === 6 &&
    inner[0] === 0 &&
    inner[1] === ReconstructedUdpInputOpcode.KeepaliveProbe
  ) {
    const userId = dv.getUint32(2, false);
    for (const s of state.sessions.values()) {
      if (s.users.some((u) => u.id === userId) || s.remoteAddress === remoteAddress) {
        s.udpEndpoint = { address: remoteAddress, port: remotePort };
        break;
      }
    }
    out.push({
      address: remoteAddress,
      port: remotePort,
      datagram: MTUDPPeer.encodeFrame(new Uint8Array([ServerUdpOpcode.KeepaliveAck])),
    });
    return out;
  }

  // 2. CUDPPeerClient::sub_5EC195 probe (`[0, 0, localPeerIdx]`) -> `[0, 1, localPeerIdx]`.
  if (
    inner.length === 3 &&
    inner[0] === UdpPeerEnvelopeKind.Control &&
    inner[1] === ClientUdpPeerControlCode.Probe
  ) {
    const localPeerIdx = inner[2]!;
    const pongPayload = new Uint8Array([
      UdpPeerEnvelopeKind.Control,
      ReconstructedServerUdpPeerControlCode.ProbeResponse,
      localPeerIdx,
    ]);
    logger.debug("UDPDispatcher", "Answered CUDPPeerClient route probe", {
      remoteAddress,
      remotePort,
      localPeerIdx,
    });
    out.push({
      address: remoteAddress,
      port: remotePort,
      datagram: MTUDPPeer.encodeFrame(pongPayload),
    });
    return out;
  }

  // 3. sub_4ED400 Game Load Registration (`[u16(1), u32(userId), u16(roomId), u32(roomGameKey), ...]`, 36 bytes)
  if (
    inner.length >= 12 &&
    inner[0] === 0 &&
    inner[1] === ClientUdpOpcode.GameLoadRegistration
  ) {
    const userId = dv.getUint32(2, false);
    const roomId = dv.getUint16(6, false);

    let senderSession: ClientSession | undefined;
    for (const s of state.sessions.values()) {
      if (s.users.some((u) => u.id === userId)) {
        senderSession = s;
        break;
      }
    }
    if (!senderSession) {
      for (const s of state.sessions.values()) {
        if (s.currentRoomNumber === roomId && s.remoteAddress === remoteAddress) {
          senderSession = s;
          break;
        }
      }
    }

    if (senderSession) {
      senderSession.udpEndpoint = { address: remoteAddress, port: remotePort };
      const room =
        state.rooms.get(roomId) ??
        (senderSession.currentRoomNumber !== null
          ? state.rooms.get(senderSession.currentRoomNumber)
          : undefined);
      if (room) {
        if (inner.length >= 24) {
          const localEndpoints: [UdpEndpoint, UdpEndpoint] = [
            { ip: dv.getUint32(12, false), port: dv.getUint16(16, false) },
            { ip: dv.getUint32(18, false), port: dv.getUint16(22, false) },
          ];
          const observedEndpoint = getObservedUdpEndpoint(remoteAddress, remotePort);

          for (const sIdx of senderSession.roomSlotIndices) {
            const slot = room.slots[sIdx];
            if (slot) {
              slot.udpEndpoints = [
                { ...localEndpoints[0] },
                { ...localEndpoints[1] },
                { ...observedEndpoint },
              ];
            }
          }

          logger.debug("UDPDispatcher", "Updated CGameStage peer endpoint candidates", {
            sessionId: senderSession.sessionId,
            roomNumber: room.roomNumber,
            sourceAddress: remoteAddress,
            sourcePort: remotePort,
            localEndpoints,
            observedEndpoint,
          });
        }
        markSessionGameLoaded(state, room, senderSession);
      }
    }
    return out;
  }

  // 4. Other peer control/route traffic (type 0) or peer gameplay data (`[u8(1), u8(localPeerIdx), ...]`).
  let senderSession: ClientSession | undefined;
  for (const s of state.sessions.values()) {
    if (
      s.udpEndpoint &&
      s.udpEndpoint.address === remoteAddress &&
      s.udpEndpoint.port === remotePort
    ) {
      senderSession = s;
      break;
    }
  }
  if (!senderSession) {
    for (const s of state.sessions.values()) {
      if (s.remoteAddress === remoteAddress && s.currentRoomNumber !== null) {
        senderSession = s;
        s.udpEndpoint = { address: remoteAddress, port: remotePort };
        break;
      }
    }
  }

  if (senderSession && senderSession.currentRoomNumber !== null) {
    const room = state.rooms.get(senderSession.currentRoomNumber);
    if (room) {
      const peerIds = new Set<number>();
      for (const slot of room.slots) {
        if (
          slot.occupied &&
          slot.session !== null &&
          slot.session.sessionId !== senderSession.sessionId
        ) {
          peerIds.add(slot.session.sessionId);
        }
      }
      for (const peerSessionId of peerIds) {
        const peer = state.sessions.get(peerSessionId);
        if (peer?.udpEndpoint) {
          // Re-emit this validated MTUDPPeer frame with its unchanged inner payload; the client
          // validates its CRC and strips `[u8(1), u8(localPeerIdx)]` in sub_5EC943.
          out.push({
            address: peer.udpEndpoint.address,
            port: peer.udpEndpoint.port,
            datagram: framedInner,
          });
        }
      }
    }
  }

  if (out.length === 0) {
    logger.debug("UDPDispatcher", "UDP frame had no live handler or peer target", {
      remoteAddress,
      remotePort,
      messageKind,
      udpOpcode:
        messageKind === "reconstructed-keepalive-probe"
          ? formatReconstructedUdpInputOpcode(opcodeForLog)
          : messageKind === "game-load-registration"
            ? formatClientUdpOpcode(opcodeForLog)
            : undefined,
      senderSessionId: senderSession?.sessionId,
      roomNumber: senderSession?.currentRoomNumber,
    });
  } else {
    logger.debug("UDPDispatcher", "Relayed MTUDPPeer frame to room peers", {
      remoteAddress,
      remotePort,
      senderSessionId: senderSession?.sessionId,
      roomNumber: senderSession?.currentRoomNumber,
      peerMessageType: inner[0],
      peerIdx: inner.length >= 2 ? inner[1] : undefined,
      innerBytes: inner.length,
      frameBytes: framedInner.length,
      recipientCount: out.length,
      recipients: out.map(({ address, port }) => ({ address, port })),
    });
  }
  return out;
}
