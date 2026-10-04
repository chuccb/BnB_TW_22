import { MTUDPPeer } from "../protocol/framing.ts";
import { ClientOpcode, StageId, UdpOpcode } from "../protocol/opcodes.ts";
import { PacketReader } from "../protocol/primitives.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { handleAuthPacket } from "./authHandler.ts";
import { handleChannelPacket } from "./channelHandler.ts";
import { handleCommonPacket } from "./commonHandler.ts";
import { handleGamePacket, markSessionGameLoaded } from "./gameHandler.ts";
import { handleLobbyPacket } from "./lobbyHandler.ts";
import { handleRoomPacket } from "./roomHandler.ts";
import { handleShopPacket } from "./shopHandler.ts";

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
  ClientOpcode.RequestChannelList8,
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
  ClientOpcode.RequestStringTableOrBalance,
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
  ClientOpcode.UserMarketSearch320,
  ClientOpcode.UserMarketDetail321,
  ClientOpcode.UserMarketBuy322,
  ClientOpcode.EnterShopFromLobby,
  ClientOpcode.UserMarketMyListings324,
  ClientOpcode.UserMarketCancel325,
  ClientOpcode.UserMarketLeave326,
  ClientOpcode.UserMarketCancelListing,
  ClientOpcode.ShopBalanceQuery328,
  ClientOpcode.UserMarketTransferLucci,
  ClientOpcode.UserMarketBuyListing,
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
  ClientOpcode.ClientReportOrLobbyEnter,
  ClientOpcode.ReturnToChannelSelect,
  ClientOpcode.AdminNoticeChat,
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

  // 0. Opcode 305: `CCouple::sub_5B9FD6` (`[u8 playerIdx, u8 accept]`, 2 bytes) vs `CheckFxStockLegacy` (4 bytes)
  if (opcode === ClientOpcode.CoupleRespond && reader.remaining === 2) {
    handleCommonPacket(state, session, opcode, reader);
    return;
  }

  // 1. Pre-login, Registration & Authentication opcodes (`CLoginStage`, `COnePageIDStage`, `CAgreementStage`)
  if (
    AUTH_OPCODES.has(opcode) ||
    (opcode === ClientOpcode.CheckIdOrNormalChat && session.stageId < StageId.SelectServer)
  ) {
    handleAuthPacket(state, session, opcode, reader);
    return;
  }

  // 2. Server / Channel Selection & Session Handoff opcodes (`CSelectServerStage`)
  if (CHANNEL_OPCODES.has(opcode)) {
    handleChannelPacket(state, session, opcode, reader);
    return;
  }

  // 3. Shop / Inventory / Market / `.ini` stream opcodes (`CShopConnectionMan` & `CShopStageNew`)
  if (SHOP_OPCODES.has(opcode)) {
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
        handleCommonPacket(state, session, opcode, reader);
        return;
      }
      if (len + 2 === reader.remaining && reader.remaining === 6) {
        const clone = new PacketReader(reader.plain, reader.degree);
        const maybeStr = clone.readString();
        if (/^[\x20-\x7e]+$/.test(maybeStr)) {
          handleCommonPacket(state, session, opcode, reader);
          return;
        }
      }
    }
    handleLobbyPacket(state, session, opcode, reader);
    return;
  }

  // 5. Lobby Stage opcodes (`CLobbyStage`: room list, create room, join room, quick join)
  if (LOBBY_OPCODES.has(opcode)) {
    handleLobbyPacket(state, session, opcode, reader);
    return;
  }

  // 6. Prepare / Room Stage opcodes (`CPrepareStage`: map, character, team, ready, start, leave)
  if (
    ROOM_OPCODES.has(opcode) ||
    (opcode === ClientOpcode.EquipQuickSlotOrEmotion && reader.remaining >= 5)
  ) {
    handleRoomPacket(state, session, opcode, reader);
    return;
  }

  // 7. In-Game Match Stage opcodes (`CGameStage`: load ready, bombs, items, death, finish, relay)
  if (opcode >= ClientOpcode.PlaceBomb && opcode <= 153) {
    handleGamePacket(state, session, opcode, reader);
    return;
  }

  // 8. Common / Chat / Cross-stage opcodes (`CStage`, `CChatStage`, `CPacketDispatcher`)
  if (COMMON_OPCODES.has(opcode)) {
    handleCommonPacket(state, session, opcode, reader);
    return;
  }
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
    return [];
  }

  const out: UdpOutDatagram[] = [];
  const dv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);

  // 1. CUDPPeerMan::sub_57BEAE Keepalive (`[u16(0), u32(userId)]`, 6 bytes) -> 1B `[u8(4)]` (`sub_57BDCE`)
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

  // 2. Legacy 3B UDP Ping (`[0, 0, seq]`) -> `[0, 1, seq]`
  if (inner.length === 3 && inner[0] === 0 && inner[1] === 0) {
    const pongPayload = new Uint8Array([0, 1, inner[2]!]);
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
          const ip0 = dv.getUint32(12, false);
          const port0 = dv.getUint16(16, false);
          const ip1 = dv.getUint32(18, false);
          const port1 = dv.getUint16(22, false);
          for (const sIdx of senderSession.roomSlotIndices) {
            const slot = room.slots[sIdx];
            if (slot) {
              slot.udpEndpoints = [
                { ip: ip0 || 0x7f000001, port: port0 || remotePort },
                { ip: ip1 || 0x7f000001, port: port1 || remotePort },
                { ip: 0x7f000001, port: remotePort },
              ];
            }
          }
        }
        markSessionGameLoaded(state, room, senderSession);
      }
    }
    return out;
  }

  // 4. Peer Keepalive (`[u8(0), u8(slot)]`) or Peer Gameplay Data (`[u8(1), u8(senderSlot), innerOpcode, ...]`)
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
          out.push({
            address: peer.udpEndpoint.address,
            port: peer.udpEndpoint.port,
            datagram: rawDatagram,
          });
        }
      }
    }
  }

  return out;
}
