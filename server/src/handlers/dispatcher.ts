import { MTUDPPeer } from "../protocol/framing.ts";
import { ClientOpcode, StageId, UdpOpcode } from "../protocol/opcodes.ts";
import { PacketReader, ipv4ToUint32 } from "../protocol/primitives.ts";
import { formatClientOpcode, formatStageId, formatUdpOpcode, logger } from "../utils/logger.ts";
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
  ClientOpcode.CreateOrUpdateAccount,
  ClientOpcode.LoginPassport,
  ClientOpcode.AcceptAgreement,
  ClientOpcode.RegisterAccount,
  ClientOpcode.LoginVariant29,
  ClientOpcode.LoginVariant30,
  ClientOpcode.LoginBeanfunToken,
  ClientOpcode.EKeyVerify,
  ClientOpcode.EKeyChallengeResponse,
  ClientOpcode.CheckUserIdAvailable,
  ClientOpcode.SubmitRegistrationForm,
  ClientOpcode.VerifyAccountIdentity,
  ClientOpcode.ChangeAccountPassword,
  ClientOpcode.LoginVariant49,
  ClientOpcode.CheckPackageMapLegacy,
  ClientOpcode.CheckNoticeUrl,
  ClientOpcode.CheckStringTableLegacy,
  ClientOpcode.CheckFxStockLegacy,
]);

const CHANNEL_OPCODES = new Set<number>([
  ClientOpcode.SelectChannelLegacy,
  ClientOpcode.SelectChannel,
  ClientOpcode.SessionHandoff,
  ClientOpcode.RequestChannelList,
  ClientOpcode.RequestChannelList10,
]);

const SHOP_OPCODES = new Set<number>([
  ClientOpcode.RequestShopConnection,
  ClientOpcode.AuthenticateShopConnection,
  ClientOpcode.EnterShopMode,
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
  ClientOpcode.AckGiftDelivery,
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
  ClientOpcode.RoomAux266,
]);

const COMMON_OPCODES = new Set<number>([
  ClientOpcode.UploadCrashReport,
  ClientOpcode.UploadCrashDump,
  ClientOpcode.ClientReportOrLobbyEnter,
  ClientOpcode.ReturnToChannelSelect,
  ClientOpcode.ClientPeriodicStatus,
  ClientOpcode.CheckIdOrNormalChat,
  ClientOpcode.ChatMessageWithType,
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
  ClientOpcode.QueryGuildInfo,
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
  ClientOpcode.CouplePartnerCheck,
  ClientOpcode.UserGuildModify,
  ClientOpcode.UserPairStatsQuery,
  ClientOpcode.QueryTop3Rank,
  ClientOpcode.SmsSend,
  ClientOpcode.SmsQuery,
  ClientOpcode.SmsDelete,
  ClientOpcode.SmsDeleteAll,
  ClientOpcode.LobbyInitQuery,
  ClientOpcode.MyPagePreOpen,
  ClientOpcode.CouplePropose,
  ClientOpcode.CoupleRespond,
  ClientOpcode.CoupleBreakup,
  ClientOpcode.QueryMyCharacterRank,
  ClientOpcode.SecurityHashReply1,
  ClientOpcode.SecurityHashReply2,
  ClientOpcode.ClientAuditLog,
  ClientOpcode.PostStageSync338,
  ClientOpcode.NexonClubDialogSubmit322,
]);

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

  // 0. Opcode 305: `CCouple::sub_5B9FD6` (`[u8 playerIdx, u8 accept]`, 2 bytes) vs `CheckFxStockLegacy` (4 bytes)
  if (opcode === ClientOpcode.CoupleRespond && reader.remaining === 2) {
    logRoute("handleCommonPacket (CoupleRespond compact form)");
    handleCommonPacket(state, session, opcode, reader);
    return;
  }

  // 1. Pre-login, Registration & Authentication opcodes (`CLoginStage`, `COnePageIDStage`, `CAgreementStage`)
  if (
    AUTH_OPCODES.has(opcode) ||
    (opcode === ClientOpcode.CheckIdOrNormalChat && session.stageId < StageId.SelectServer)
  ) {
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
 */
export function dispatchUdpDatagram(
  state: WorldState,
  rawDatagram: Uint8Array,
  remoteAddress: string,
  remotePort: number
): UdpOutDatagram[] {
  const inner = MTUDPPeer.decodeFrame(rawDatagram);
  if (!inner || inner.length === 0) {
    logger.warn("UDPDispatcher", "Rejected invalid or empty MTUDPPeer datagram", {
      remoteAddress,
      remotePort,
      byteCount: rawDatagram.length,
    });
    return [];
  }

  const opcodeForLog = inner.length >= 2 && inner[0] === 0 ? inner[1]! : inner[0]!;
  const messageKind =
    inner.length === 6 && inner[0] === 0 && inner[1] === UdpOpcode.ServerKeepalive
      ? "server-keepalive"
      : inner.length >= 12 &&
          inner[0] === 0 &&
          inner[1] === UdpOpcode.GameLoadRegistration
        ? "game-load-registration"
        : inner.length === 3 && inner[0] === 0
          ? "peer-route-probe/control"
          : inner[0] === 1
            ? "peer-game-data"
            : "unclassified";
  logger.debug("UDPDispatcher", "Decoded MTUDPPeer datagram", {
    remoteAddress,
    remotePort,
    messageKind,
    udpOpcode:
      messageKind === "server-keepalive" || messageKind === "game-load-registration"
        ? formatUdpOpcode(opcodeForLog)
        : undefined,
    innerBytes: inner.length,
  });
  const out: UdpOutDatagram[] = [];
  const dv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);

  // 1. Reconstructed UDP server keepalive `[u16(0), u32(userId)]` -> `[u8(4)]`; production cadence/reply is unverified.
  if (inner.length === 6 && inner[0] === 0 && inner[1] === UdpOpcode.ServerKeepalive) {
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
      datagram: MTUDPPeer.encodeFrame(new Uint8Array([UdpOpcode.ServerKeepaliveAck])),
    });
    return out;
  }

  // 2. CUDPPeerClient::sub_5EC195 probe (`[0, 0, localPeerIdx]`) -> `[0, 1, localPeerIdx]`.
  if (inner.length === 3 && inner[0] === 0 && inner[1] === 0) {
    const localPeerIdx = inner[2]!;
    const pongPayload = new Uint8Array([0, 1, localPeerIdx]);
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
  if (inner.length >= 12 && inner[0] === 0 && inner[1] === UdpOpcode.GameLoadRegistration) {
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
          // Forward the original MTUDPPeer frame unchanged; the client validates its CRC and
          // strips the `[u8(1), u8(localPeerIdx)]` wrapper in CUDPPeerManBase::sub_5EC943.
          out.push({
            address: peer.udpEndpoint.address,
            port: peer.udpEndpoint.port,
            datagram: rawDatagram,
          });
        }
      }
    }
  }

  if (out.length === 0) {
    logger.debug("UDPDispatcher", "UDP datagram had no live handler or peer target", {
      remoteAddress,
      remotePort,
      messageKind,
      udpOpcode:
        messageKind === "server-keepalive" || messageKind === "game-load-registration"
          ? formatUdpOpcode(opcodeForLog)
          : undefined,
      senderSessionId: senderSession?.sessionId,
      roomNumber: senderSession?.currentRoomNumber,
    });
  } else {
    logger.debug("UDPDispatcher", "Relayed MTUDPPeer datagram to room peers", {
      remoteAddress,
      remotePort,
      senderSessionId: senderSession?.sessionId,
      roomNumber: senderSession?.currentRoomNumber,
      peerMessageType: inner[0],
      peerIdx: inner.length >= 2 ? inner[1] : undefined,
      innerBytes: inner.length,
      datagramBytes: rawDatagram.length,
      recipientCount: out.length,
      recipients: out.map(({ address, port }) => ({ address, port })),
    });
  }
  return out;
}
