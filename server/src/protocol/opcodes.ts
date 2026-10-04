/**
 * Strongly-typed protocol opcodes and client stage identifiers extracted from `CA.exe.c`
 * and `.rdata` virtual tables (`0x7B322C`–`0x7C2204`).
 *
 * Uses TypeScript's `as const satisfies` so callers get both literal numeric types
 * and self-documenting symbolic names across all stage handlers.
 *
 * Covers 100% (174/174) of all Client->Server opcodes emitted by `CA.exe` and
 * all Server->Client stage, sub-dispatcher, and UDP opcodes.
 */

export const StageId = {
  Login: 1, // CLoginStage (0x00567400)
  Credit: 3, // CCreditStage (0x004BF1FF)
  Agreement: 8, // CAgreementStage (0x004A6E26)
  OnePageId: 9, // COnePageIDStage (0x0050EB5A)
  SelectServer: 10, // CSelectServerStage (0x0056A9DA)
  Lobby: 11, // CLobbyStage (0x004C86A2)
  Prepare: 12, // CPrepareStage (0x004DCF07)
  Game: 13, // CGameStage (0x004F672F)
  Shop: 14, // CShopStageNew (0x0053C550)
  Exit: 16, // CExitStage (0x004DFBF3)
  Chatting: 17, // CChattingStage (0x004B6418)
  Exchange: 18, // CExchangeStage (0x0055C714)
  Practice: 19, // CPrepareStagePractice (0x004D0793)
  UserMarket: 20, // CUserMarketStage (0x00574380)
} as const satisfies Record<string, number>;

export type StageIdValue = (typeof StageId)[keyof typeof StageId];

export const ClientOpcode = {
  // Pre-Login & Authentication (CFxApp / CLoginStage / COnePageIDStage / CNCPasswordDlg / CEKeyDlg)
  PreLoginSsdCheck: 0, // sub_5A1E40: [u32 dynamic-img context, u32 csysstr, u32 multisvr, u32 filterstr, (opt u32 multisvrn)]
  LoginCredentials: 2, // sub_5D8BD8: 1P/2P keyed username (0x11223344) + password (0x44332211)
  SelectChannelLegacy: 3, // Legacy channel select alias
  CreateOrUpdateAccount: 4, // sub_496D15 / sub_4985CD: account creation / update form
  SelectChannel: 5, // CSelectServerStage::sub_56AF39
  SessionHandoff: 6, // sub_5D8879 / sub_5D893D / sub_5D8A3F
  UploadCrashReport: 7, // sub_5A885A / sub_5D090B: [str crashInfo] (CA_Crash_info.nfo / Crash_CA.dmp.log)
  UploadCrashDump: 8, // sub_5D06FA: [u8 flag=1, u32 byteCount, block(byteCount)]; sub_5D137C sends flag=0 without a block
  RequestChannelList: 9, // sub_5D3BFC: [u32 channel2_%03d%s.ssd checksum]
  RequestChannelList10: 10, // Channel list refresh alias
  LoginPassport: 11, // sub_5D85A0: keyed passport (0xAABBCCDD)
  ClientReportOrLobbyEnter: 12, // CStage report or lobby enter alias
  ReturnToChannelSelect: 13, // CLobbyStage::sub_4C1944
  AdminNoticeChat: 14, // Notice broadcast
  CheckIdOrNormalChat: 16, // COnePageIDStage check ID (stage < 10) or CChatStage::sub_4AD598 normal chat
  AcceptAgreement: 17, // CAgreementStage accept
  RegisterAccount: 18, // COnePageIDStage register
  ChatMessageWithType: 19, // Typed chat message
  PingReplyOrWhisper: 20, // CPacketDispatcher::sub_5D7CA5 (8B ping) or CChatStage::sub_4AD598 (whisper)
  MessengerInviteUser: 21, // sub_4B4F83 / sub_4DB16C / sub_55AAF0 / sub_5E9F86: [u16 roomNum, u32 key, str targetUser, u8 flag]
  RoomEmotion: 22, // Emotion packet
  RequestDynI16Table: 27, // sub_59A700: [u32 crc, u16 count]
  RequestAvatarI16Table: 28, // sub_59B5A2: [u32 crc, u16 count]
  LoginVariant29: 29,
  LoginVariant30: 30,
  LoginBeanfunToken: 31, // sub_5D8494: Taiwan Beanfun / GASH token login
  EKeyVerify: 32, // CEKeyDlg::sub_55FB0B: PlaySafe / E-Key security token verification
  EKeyChallengeResponse: 33, // CEKeyDlg::sub_561394: E-Key challenge response
  CheckUserIdAvailable: 34, // sub_49A5CA / sub_49A7F4: check user ID availability
  SubmitRegistrationForm: 35, // sub_49AB07: submit registration form
  VerifyAccountIdentity: 36, // sub_49B6E4: verify account identity
  RequestShopConnection: 37, // CShopConnectionMan::sub_529AFB
  AuthenticateShopConnection: 38, // CShopConnectionMan::sub_529D8E
  MacroListQuery: 40, // sub_4A29A1: [u8(0)] -> S->C 50
  QuestAction: 44, // CQuestWnd::sub_551AE2 -> S->C 248
  ChangeAccountPassword: 46, // sub_495C32: [str oldPass, str newPass, str confirmPass] -> S->C 34
  LoginVariant49: 49,

  // User Info, Ranking & Lobby (CLobbyStage / CStage / CRankMan)
  QueryRankingPage: 64, // sub_4A48F2: [u16 startRank] -> S->C 69 / S->C 66
  ModifyUserInfo: 65, // sub_5495CD
  QueryUserInfo66: 66, // CStage::sub_4BC236: [str username, u8(1), u8 localIdx] -> S->C 81 + S->C 248 + S->C 71
  RoomDetailOrUserInfo: 67, // sub_4C266D: [u16 roomIdx, u32 roomKey] -> S->C 83
  QueryGuildInfo: 68, // sub_53DEEA -> S->C 34
  QueryUserBrief: 69, // sub_4A0321: [u32 userId] -> S->C 70
  QueryUserInfo: 70, // CChatStage::sub_4ABBDE: [u8(0), str username] -> S->C 81 + S->C 70
  UpdateUserOptions: 71, // sub_4A63C9: [u8 optionFlags]
  UseSuperSpeaker: 72, // sub_4A3E36: [u8 localIdx, u8 speakerType, str msg] -> S->C 65 + S->C 21
  SaveDefaultChars: 73, // sub_4BABFF / sub_54728B: [u8 playerCount, playerCount * u8 charId]
  UpdatePremiumSlotState: 74, // sub_5ED25A: [u8 playerIdx, u8 state]
  CreateRoom: 75, // sub_4CD379 / sub_4CAC9F / sub_4CB60D / sub_4CC28E -> S->C 79 + S->C 102
  JoinRoom: 76, // sub_4C4D93 -> S->C 80 + S->C 102
  QuickJoin: 77, // sub_4C83BA / CNormalLobbyStrategy::sub_4CCCE2 -> S->C 81
  LeaveRoom: 78, // sub_5AA580: []; current server's S->C 9 reply is a separate Prepare-stage defect
  CreateRoomShort: 79, // sub_4C070B -> S->C 79 + S->C 102
  RoomListScrollOrDetail: 80, // sub_4A496F -> S->C 83
  QuickJoinShort: 81, // Quick join alias -> S->C 81
  ReturnToRoom: 82, // sub_536E2E -> S->C 80
  EnterLobby: 83, // CStage::sub_4B94A6 -> S->C 89 + S->C 186 + S->C 82

  // Room / Prepare / Exchange Stage (CPrepareStage / CExchangeStage)
  UpdateRoomSettings: 84, // sub_4D6803 / sub_4D689B -> S->C 93
  ToggleReady: 86, // sub_4D5B2F: [u8 readyState, u32 esfnChecksum] -> S->C 104
  SelectMap: 87, // sub_4D1E59: [u16 mapId, u32 mapKey] -> S->C 109
  SelectTeamColor: 88, // sub_4D2A67: [u8((localIdx<<4)|team)] -> S->C 105 + S->C 104
  SelectCharacter: 89, // sub_4D2AFD: [u8 localIdx, u8 charId] -> S->C 106 + S->C 104
  ToggleSlotOpen: 90, // sub_4D2BB8: [u8((slotIdx<<4)|open)] -> S->C 107 + S->C 104
  KickPlayer: 91, // sub_4DA92C -> S->C 103
  BanVoteResponse: 92, // sub_4D555E -> S->C 111
  StartMatch: 93, // sub_4D5DB1 + sub_4DF2EC -> S->C 112 + S->C 113
  ChangeRoomPassword: 94, // sub_4DB16C -> S->C 231 + S->C 93
  EquipQuickSlotOrEmotion: 95, // sub_4D2716 (5B quick-slot) -> S->C 115 or emotion
  PracticeHandicap: 96, // sub_4D0627 -> S->C 108
  TeamChat: 97, // CChatStage::sub_4AD598 -> S->C 114
  RoomAux98: 98, // CShopConnectionMan::sub_52A04E / sub_52A129: [u8 inShopFlag] -> S->C 104 + S->C 16 / S->C 99
  RoomAvatarSync: 99, // sub_4B24F6: room avatar/accessory sync
  ExchangeAction: 100, // CExchangeStage::sub_558142: [u8 state, (if state==3: u32 lucci, u8 count, count*(u32 stockId, 16B SYSTEMTIME))]
  ExchangePassCheck: 101, // CExchangeStage::sub_55B5B0: [str pass] -> S->C 130 + S->C 126
  MyPageUpdateBadge: 103, // CMyPageDialog::sub_54467A: [u8 playerIdx, u8 badge]
  RoomChiefBroadcast: 104, // sub_4BE3C5: [u16 roomNum, u32 chiefKey, u8 flag]
  ReportPlayer: 105, // sub_476AD6: [str targetUser, u16 reasonCode, u8 flag, str detail]
  CancelAction: 106, // sub_49DC34: empty cancel notification

  // In-Game Match Stage (CGameStage — 0x004F672F)
  PlaceBomb: 107, // sub_4EDCF0 -> S->C 138
  KickBomb: 108, // sub_4EB05B -> S->C 139
  BombExplode: 109, // sub_4EF5F8 -> S->C 137
  PushBox: 110, // sub_4EE2BB -> S->C 140
  PickUpItem: 111, // sub_4F1A2E -> S->C 141
  DestroyTile: 112, // sub_4F1956 -> S->C 142
  PlayerStateChange: 113, // sub_4EA4EE -> S->C 144 (or compact [slot, 0] load ready)
  MatchFinish: 114, // sub_4EC3FD -> S->C 148 + S->C 153
  NpcAttackDamage: 115, // CGONpcAttackMon::sub_5193D8: [u16 npcObjId, u16 damageOrAction]
  NpcStateEvent: 116, // CGONpcAttackMon::sub_518C5B: [u8 npcSlot, u16 stateVal]
  LeaveMatch: 117, // Leave match early -> S->C 153
  BomberSpecialAction: 118, // sub_4EA367 / sub_4EA3CD: [u8 bomberIdx, u8 flag, u8 x, u8 y, u8 a5, u8 a4] -> S->C 154
  BossAiSync: 119, // sub_522107 / sub_522252 / sub_5222B5
  ThrowDart: 120, // sub_4EE0D0 -> S->C 145
  PushBomb: 121, // sub_44B969: [u8 flagsAndBomberIdx, u8 x, u8 y] -> S->C 146 (sub_4EEB75)
  InGameBubbleChat: 122, // sub_44E435: [u8 slotIdx, str message] -> S->C 21
  ThrowBombAction: 123, // sub_44B72D: [u8 x, u8 y, u8 (bomberIdx<<4)|dir] -> S->C 180 (sub_4EAC86)
  BomberReviveOrGhost: 125, // sub_4EE3DF: [u8 a2, u8 a3, u8 slotIdx, u8 a4] -> S->C 156 / 157 / 158
  MatchDrawTimeout: 126, // sub_4EC3FD -> finishMatch(null)
  ComponentSubPacket: 127, // -> S->C 149
  PickupMapItem: 128, // sub_44F405: [u8 bomberIdx, u8 x, u8 y] -> S->C 142 (sub_4EB01C)
  RoundSyncAck: 129, // sub_4F588D: [u8(1)]
  StageTransitionAck: 130, // sub_4F574C: [u8(1)]
  SpawnMapItems: 131, // sub_4F1525 -> S->C 151
  DestroyTilesBatch: 132, // sub_4F1690: [u8 count, u16 a5, u16 a4, u8 a2, u16 a9, count*(u8 x, u8 y)] -> S->C 151
  BossSkillTarget: 133, // sub_50CD79: [u8 randSeed, u32 x, u32 y, tiles...]
  ThrowBomb: 134, // sub_4EDC97 -> S->C 146
  ReportPerfMetrics: 135, // sub_4EA946: [5 * u32 perfMetrics]
  SyncGameObjectUpdate: 136, // sub_578D1F: [u16 objId, 20B state] -> S->C 176
  SyncGameObjectEvent: 137, // sub_579F03: [u16 objId, u32 val] -> S->C 177
  BombChainTileCheck: 138, // sub_4E9A13: [u8 bomberIdx, u8 count, count*(u8 x, u8 y)]
  MapScriptSync: 139, // sub_4FB3B2: [u8 a6, u8 count1, count1*(u8 x, u8 y), u8 count2, count2*(u8 t, u8 x, u8 y)]
  MapScriptTick: 140, // sub_4FB7C9: [u8(0)]
  TriggerRemoteBomb: 141, // sub_58587E: [u8 bomberIdx, u8 bombId, u8 flag] -> S->C 141 (sub_4ECAAA)
  PlaceSpecialBomb: 142, // sub_4EE16E -> S->C 181
  CustomGameObjectSync: 143, // sub_587966: [str data, u8 id, u8 flag]
  PlayerTrappedInBalloon: 144, // sub_508B55: [u8 bomberIdx] -> S->C 165 (sub_4EAC12)
  InGameAliveAck: 145, // sub_4EA141: [u8(1)]
  SuddenDeathHazard: 146, // sub_509789: [u8(3), u8 slotOrTeam]
  ReportUdpPeerRtt: 147, // CUDPPeerMan::sub_57BEF4: [u8 peerIdx, u32 rttMs, u8 count]
  ReportGameDesync: 148, // sub_4EAB99: [u8 bomberIdx, u32 userKey, u8 reason]
  RequestUdpRelay: 149, // CUDPPeerMan::sub_57BEF6: [u8 peerIdx (0..11)] -> S->C 125
  PracticeExit: 150, // sub_4D18B3 -> S->C 153
  UseActiveGameItem: 153, // sub_50E781: [u8 bomberIdx, u8 itemSlot, u8 itemType] -> S->C 153

  // Config / Shop / Inventory / UserMarket / Couple / SMS Requests
  CheckPackageMapLegacy: 252, // -> S->C 157
  EnterShopMode: 261, // -> S->C 261 + S->C 16 + S->C 9
  RoomAux266: 266,
  CheckNoticeUrl: 267, // -> S->C 163
  ShopEnter: 269, // CShopStageNew::sub_536555 / sub_589DB9: [u8 mode] -> S->C 198
  ShopCashQuery: 269, // sub_589DB9: [u8(0)] -> S->C 198
  ShopBuyItem: 270, // sub_58EAEF -> sub_58B130: [u32 packageId, u32 discountCoupon] -> S->C 199
  InventoryDeleteItem: 271, // sub_58013E: [u32 stockId, u32 slotIdx] -> S->C 202
  ShopAction: 273, // CShopStageNew::sub_53C550 -> sub_5816F4: equip/sync active items
  InventoryEquipSync: 273, // sub_5816F4: [u8 mode, u8 playerIdx, u16 count, count*(u8 slot, u32 stockId)]
  ShopUseOrEquip274: 274, // sub_541682 / sub_594F84: [u8 playerIdx, u8 slotIdx, u32 stockId, str customText]
  InventoryEquipSlot: 274,
  ShopInventoryTab275: 275, // CShopTextDlg::sub_48ED44: [u8 playerIdx, u8 count, count*(u32 stockId, str text)]
  InventoryUpdateText: 275,
  RequestFxStockIni: 276, // sub_594353: request fxstock.ini SmartStream -> S->C 193 (sub_4B95B0)
  ShopBillingCheck: 277, // sub_589D78 -> S->C 201 (sub_58C8EA)
  RequestStringTableOrBalance: 278, // sub_59449A: request stringtable.ini SmartStream -> S->C 200 (sub_4B95F7)
  ShopSendGift: 279, // sub_52C5A2: [u32 packageId, str receiver, str title, str msg, u8 flag] -> S->C 199 + S->C 203
  ShopBuy280: 280, // CShopCouponDlg::sub_492CD9 / sub_492E5C: [str couponCode, str targetUser] -> S->C 204
  ShopRedeemCoupon: 280,
  RequestPackageMapIni: 281, // sub_5943FB: request packagemap.ini SmartStream -> S->C 210 (sub_4B966A)
  RequestDynamicMapInfoSsd: 282, // sub_4DD5D3: request fxdynmapinfo.ssd SmartStream -> S->C 205 (sub_4E0131)
  ShopResellItem: 283, // sub_58BFE0: [u32 stockId, u32 slotIdx] -> S->C 212 (sub_546D3F)
  NexonClubAuth: 284, // sub_4BCB70 (CNexonClubDlg): [u8 playerIdx, str clubId, str clubPass]
  ShopLeave: 285, // CShopStageNew::sub_536DB3 / sub_5B76C2 -> S->C 214 / S->C 99
  ShopIdentifyQMark: 285,
  RedeemCouponCode: 286, // CCouponDlg::sub_5B6215: [u32 couponTypeOrId] -> S->C 204
  ShopSaveSlotOrder: 288, // sub_53809C: [u32 playerIdx, u32 count, count*(u32 pkgId, u32 a, u32 b)]
  UserDetailQuery: 289, // sub_549904: [str username] -> S->C 81
  CouplePartnerCheck: 290, // sub_53DEEA: [str partnerName] -> S->C 242
  UserGuildModify: 292, // sub_5495CD: [u8 playerIdx, str guild]
  UserPairStatsQuery: 293, // sub_53DEEA: [str userA, str userB] -> S->C 220
  CheckStringTableLegacy: 294, // -> S->C 179
  ShopStateSync: 295, // sub_5365B3: [u8 state]
  QueryTop3Rank: 296, // sub_4A49D8: empty -> S->C 240 (sub_4A522B)
  SmsSend: 297, // CSmsDlg::sub_4810F3: [str sender, str receiver, str msg] -> S->C 242 + S->C 246
  SmsQuery: 298, // CSmsDlg::sub_47F58F / sub_5E415C: [str username, u8 mode] -> S->C 243 / S->C 246
  SmsDelete: 299, // CSmsDlg::sub_47FDCB: [str username, u32 msgId] -> S->C 244
  SmsDeleteAll: 300, // CSmsDlg::sub_47F5F7: [str username] -> S->C 245
  LobbyInitQuery: 301, // CLobbyStage::sub_4C99DC: empty
  MyPagePreOpen: 302, // CStage::sub_4BC236: empty
  QueryAvatarLucciSync: 303, // CStage::sub_4BB107 / sub_55195E / sub_5382EA: [u8 playerIdx] -> S->C 186
  CouplePropose: 304, // sub_5BA82D: [u8 playerIdx, str partnerName, str message] -> S->C 251 + S->C 252
  CheckFxStockLegacy: 305, // sub_5B9FD6: [u8 playerIdx, u8 accept] (CoupleRespond) or legacy fxstock check
  CoupleRespond: 305,
  CoupleBreakup: 306, // sub_5BA899: [u8 playerIdx] -> S->C 254
  GachaponRoll: 307, // CGachaponDlg::sub_5C3330: [u32 couponStockId] -> S->C 255 / 257
  GachaponClose: 308, // sub_5BF559
  ShopBuyItemPass: 309, // sub_58EAEF -> sub_58B871: [str pass, u32 packageId, u32 discountCoupon] -> S->C 199
  AckGiftDelivery: 310, // sub_58DFE6: [u8 playerIdx]
  QueryMyCharacterRank: 311, // sub_4A4A0F: empty -> S->C 256 (sub_4B96F3 -> sub_4A527F)
  BasketOpen: 312, // sub_5C2A43
  BasketQueryInfo: 313, // CBasketDlg::sub_5C0C05 -> S->C 258 / 259
  BasketQueryCoupons: 314, // CBasketDlg::sub_5C0C05: [u8 playerIdx] -> S->C 259 / 260
  BasketThrowAway: 315, // sub_5BF4F8: [u32 id, u8 playerIdx]
  RequestShopConnectionAlt: 316, // CShopConnectionMan::sub_529AFB
  ShopActionNotify: 317, // sub_529A40: [u8 action]
  RequestUserMarketConnection: 318, // CShopConnectionMan::sub_529A69 -> S->C 262
  UserMarketSearch320: 320, // CShopConnectionMan::sub_529A9A -> S->C 269 + S->C 99 (20)
  UserMarketEnter: 320,
  UserMarketDetail321: 321, // CUserMarketStage::sub_573B0A -> S->C 99 (11)
  UserMarketLeave: 321,
  UserMarketBuy322: 322,
  EnterShopFromLobby: 323, // sub_4BAC7B -> S->C 16 + S->C 9
  UserMarketMyListings324: 324, // CMarketSlotWnd::sub_5707D8: [u8 playerIdx] -> S->C 270 + 271 + 280 + 272
  UserMarketInit: 324,
  UserMarketCancel325: 325, // CMarketSlotWnd::sub_570BD3: [u8 type, str query] -> S->C 272
  UserMarketSearch: 325,
  UserMarketLeave326: 326, // CRegisterItemDlg::sub_5767AD: [u32 stockId, u32 price] -> S->C 273
  UserMarketRegister: 326,
  UserMarketCancelListing: 327, // CMarketSlotWnd::sub_5716AB: [u32 listingId] -> S->C 274
  ShopBalanceQuery328: 328, // CMarketSlotWnd::sub_570D80 -> S->C 275
  UserMarketMySales: 328,
  UserMarketTransferLucci: 329, // CChangeLucciDlg::sub_575DF9: [u8 dir, u32 amount] -> S->C 276
  UserMarketBuyListing: 330, // CUserMarketBuyDlg::sub_577E71: [u32 listingId] -> S->C 277
  SecurityHashReply1: 332, // sub_4B8F3F: [u32 hash] (reply to S->C 281)
  SecurityHashReply2: 333, // sub_4BAE58: [u32 hash] (reply to S->C 284)
  ClientAuditLog: 337, // sub_476AD6 / CChatStage::sub_4AEE8E / sub_53809C: [str tag, str detail]
  PostStageSync338: 338, // CStage::sub_4B94A6 -> S->C 207 (sub_4BCABF)
} as const satisfies Record<string, number>;

export const ServerOpcode = {
  // Pre-Login & Auth Responses
  MultiServerSsd: 1, // sub_5D7E8E: multisvr.ssd (+ multisvrn.ssd if feature 68)
  SystemStringSsd: 2, // sub_5D00B9: csysstr.ssd
  LoginResult: 4, // CLoginStage::sub_567400 -> sub_566E08
  ChannelSelectResult: 7, // CSelectServerStage::sub_56C0C8
  // Stage-specific overload: generic CStage::sub_4BDBF5 routes S->C 9 to a Crash_CA.dmp offset request (-> C->S 8).
  StageTransition: 9,
  ChannelListSsd: 10, // sub_5D42CF -> sub_5D3E91: channel2_%03d%s.ssd
  MessengerHandoff: 11, // CLoginStage::sub_567B0F
  ChannelLoads: 12, // sub_5D4139: [u16 count, u16[count] load]
  ChatBroadcast15: 15,
  ShopInitAndStage14: 16, // sub_4BB82A: shop checksums (fxstock, stringtable, packagemap) + qmarksfn.ssd + banners
  PingRequest: 18, // CStage::sub_4BDBF5: [u32 tick, u32 seq]
  NormalChat: 21, // CChatStage::sub_4B070C / CGameStage::sub_4F4D49
  WhisperOrEmotion: 23, // CChatStage::sub_4A8727 / CGameStage::sub_4F4F4B
  WhisperDeliveryStatus: 24, // CChatStage::sub_4AE106
  DynamicI16Data: 32, // CStage::sub_4B8D5F -> sub_59D0D4: [u32 id, u16 version, u32 size, block(size)]
  SessionHandoffAck: 33, // CSelectServerStage::sub_56A9DA -> CStage::sub_4B96B1
  GuildOrUserStatus: 34, // CMyInfoDlg::sub_54466F / CExchangeStage::sub_55B6DB
  ShopReturnHandoff: 41, // CShopConnectionMan::sub_52A23C: [u16, u16, u32 key, str, u8=11]
  ShopServerEndpoint: 48, // CShopConnectionMan::sub_529E8D: [u8 ok, u8 flag, u32 token, u32 ip, u16 port]
  MacroList: 50, // sub_4A27CB: macro strings
  FilterStringSsd: 53, // sub_5C8BE3: filterstr.ssd
  CheckIdResult: 59,
  MapNameOverrides: 60, // sub_5D9F0B -> sub_5C578E: [i32 count, count*(u32 mapId, str name)]
  RegisterAccountResult: 61,
  UserItemsSyncLegacy: 63, // CUserInventoryMan::sub_598BEC -> sub_597611

  // Lobby, Ranking, Room & Exchange Responses
  SuperSpeakerBanner: 65, // sub_4B976C -> sub_4A03EB
  RankingListAlt: 66, // sub_4A51B5: [u16 startRank, u8 count, count*sub_4A4FBD]
  RankingList: 69, // sub_4A5114: [u16 startRank, u8 count, count*sub_4A4FBD]
  UserInfoModal70: 70, // CChatStage::sub_4AFCFD
  UserStats71: 71, // CMyInfoDlg::sub_541F65
  QuestConfigSync: 75, // CStage::sub_4B94A6 -> triggers client C->S 83 + C->S 338
  CreateRoomResult: 79, // CNormalLobbyStrategy::sub_4CCE53
  JoinRoomResult: 80, // CLobbyStage::sub_4C455D
  QuickJoinOrUserProfile: 81, // CLobbyStage::sub_4C4635 (QuickJoin) / CStage::sub_4BCDFF (UserProfile)
  LobbyRoomListEntry: 82, // CLobbyStage::sub_4C1E57 -> sub_4C1B1B
  RoomDetailInfo: 83, // CNormalLobbyStrategy::sub_4CD139
  LobbyRoomListEntryCompact: 84, // CLobbyStage::sub_4C1E90 -> sub_4C1C0A
  LobbyRoomSlotUpdate: 85, // CLobbyStage::sub_4C1F02 -> sub_4C32E4
  LobbyRoomSlotRemove: 86, // CLobbyStage::sub_4C1EC9
  ExpSync: 89, // CStage::sub_4B992F
  RoomSettingsSync: 93, // CPrepareStage::sub_4D6BC2
  ShopLeaveReturnStage: 99, // CShopConnectionMan::sub_529EB2: [u16 targetStageId] -> C->S 82 or 78
  SetPlayerOnPrepare: 102, // CSlotStage::sub_4B89E4 (CSetPlayerOnPreparePacket)
  PlayerLeftSlot: 103, // CPrepareStage::sub_4D4154
  SlotStateSync: 104, // CPrepareStage::sub_4D9D08
  TeamColorSync: 105, // CPrepareStage::sub_4D4434
  CharSelectSync: 106, // CPrepareStage::sub_4D35DA
  SlotOpenCloseSync: 107, // CPrepareStage::sub_4D2888
  PracticeHandicapSync: 108, // CPrepareStagePractice::sub_4D05C1
  MapSelectSync: 109, // CPrepareStage::sub_4D27E4
  BanVoteSync: 111, // CPrepareStage::sub_4D4300
  StartGameError: 112, // CPrepareStage::sub_4D9F26
  StartGameTransition: 113, // CPrepareStage::sub_4D9F8A + optional esfn.ssd (sub_5CA65A)
  TeamChatBroadcast: 114, // CPrepareStage::sub_4DD1F5
  QuickSlotEquipSync: 115, // CPrepareStage::sub_4D2190
  ExchangeState: 126, // CExchangeStage::sub_55C14B: [u8 state, u8 msgId, (opt str)]
  ExchangeMessage: 127, // CExchangeStage::sub_559DCC: [u8 msgId, (opt str)]
  ExchangeItems: 128, // CExchangeStage::sub_5578FF -> sub_55D805: [u8 slot, u32 lucci, u8 count, count*(u32 stockId, 16B SYSTEMTIME)]
  ExchangeAccessories: 129, // CExchangeStage::sub_55AA90: maxPlayers * CSlotAccessoryPacket
  ExchangePassResult: 130, // CExchangeStage::sub_55B611: [u8 ok]

  // In-Game Match Responses (CGameStage::sub_4F672F — 0x004F672F)
  UdpRelayFallback: 125, // CUDPPeerManBase::sub_5ECBF0
  AllPlayersLoadedStart: 135, // CGameStage::sub_4F2065
  PlayerLoadedAck: 136, // CGameStage::sub_4EA206
  BombExplodeBroadcast: 137, // CGameStage::sub_4EC8CB
  PlaceBombBroadcast: 138, // CGameStage::sub_4EC331
  KickBombBroadcast: 139, // CGameStage::sub_4EC6AE
  PushBoxBroadcast: 140, // CGameStage::sub_4EC806
  PickUpItemBroadcast: 141, // CGameStage::sub_4ECAAA (also BombTriggered)
  DestroyTileBroadcast: 142, // CGameStage::sub_4EB01C (also ItemPickedUp)
  PlayerStateBroadcast: 144, // CGameStage::sub_4F267E
  ThrowDartBroadcast: 145, // CGameStage::sub_4EA9CC
  ThrowBombBroadcast: 146, // CGameStage::sub_4EEB75 (also PushBombBroadcast)
  MatchResult: 148, // CGameStage::sub_4F2F8B + CGOGameResult::sub_455957
  ComponentSubBroadcast: 149, // CGameStage::sub_4EB0BB
  SpawnMapItemsBroadcast: 151, // CGameStage::sub_4F24A6
  ReturnToPrepareStage: 153, // CGameStage::sub_4F2D1A
  SpecialTileEffect: 154, // CGameStage::sub_4ECD11: [u8 x, u8 y, u8 (bomberIdx<<4)|type]
  BomberRevived: 156, // CGameStage::sub_4ECDDB: [u8 bomberIdx, u8 slotIdx]
  BomberEliminated: 157, // CGameStage::sub_4ECEF0: [u8 bomberIdx]
  BomberRebirthGhost: 158, // CGameStage::sub_4F13F5: [u8 slotIdx]
  BomberTrapped: 165, // CGameStage::sub_4EAC12: [u8 bomberIdx, u16 x, u16 y]
  RoundTransition: 166, // CGameStage::sub_4F59E4
  BombThrownArc: 170, // CGameStage::sub_4EAA9C: [u8 bomberIdx, u8 bombId, u32 srcX, u32 srcY, u8 dstX, u8 dstY]
  SyncObjectCreate: 175, // CSyncGameObjectMan::sub_5F11FE
  SyncObjectUpdate: 176, // CSyncGameObjectMan::sub_5F11FE
  SyncObjectRemove: 177, // CSyncGameObjectMan::sub_5F11FE
  BombThrownBroadcast: 180, // CGameStage::sub_4EAC86: [u8 bombId, u8 bomberIdx, u8 x, u8 y]
  SpecialBombBroadcast: 181, // CGameStage::sub_4EEC85
  InGameAliveCheck: 182, // CGameStage::sub_4EA141 -> triggers C->S 145

  // Config / Shop / Inventory / UserMarket / Couple / SMS Responses
  PackageMapCheckAck: 157, // sub_5A1CD8
  NoticeUrlSync: 163, // sub_5A1DF3
  StringTableCheckAck: 179, // sub_5A1B77
  LucciSync: 186, // CStage::sub_4BDBF5 -> sub_4B93FD -> sub_5ED36F: [u32 playerIdx, u32 value narrowed to char]; field meaning needs validation
  FxStockCheckAck: 188, // CUserInventoryMan::sub_5953FE (InventoryUpdate) / sub_5A1A03 (legacy)
  InventoryUpdate: 188, // CUserInventoryMan::sub_5953FE
  DynamicImgInfoSsd: 189, // sub_49E093: fxdynimginfo.ssd
  ShopLucciBalance190: 190, // CShopDlg::sub_546BE3: [u32 lucci]
  FxStockIniStream: 193, // sub_4B95B0 -> sub_593FF6: fxstock.ini SmartStream
  InventoryData: 194, // CUserInventoryMan::sub_595272: [u8 playerCount, i32 itemCount, items...]
  EquippedAvatarData: 196, // CUserInventoryMan::sub_597040: [u8 playerCount, 8 * (u32 stockId, str text)]
  UserItemsData: 197, // CUserInventoryMan::sub_598BEC -> sub_597611: [u16 itemCount, items...]
  ShopUserStockList: 198, // CShopStageNew::sub_53885C: [u32 cash, u8 flag=1]
  ShopCashBalance198: 198,
  ShopBuyResult: 199, // CShopStageNew::sub_5382EA -> sub_58EBFE: [u8 result, 8B f64 LE vtime]
  StringTableIniStream: 200, // sub_4B95F7 -> sub_594136: stringtable.ini SmartStream
  ShopGiftResult: 201, // sub_58C8EA: [u8 result, u32 val1, u32 val2]
  ShopUseOrEquipResult202: 202, // CShopDlg::sub_547038: [u8 result=2, u32 stockId, u32 unk=0]
  InventoryDeleteResult: 202,
  ShopGiftList: 203, // CUserInventoryMan::sub_5954D2: [u8 playerCount, u8 giftCount, gifts...]
  ShopEquipResult: 204, // CShopStageNew::sub_53A6F1: [u8 res, u32 count, 8B f64 LE vtime, items...]
  ShopCouponResult: 204,
  DynamicMapInfoSsdStream: 205, // sub_4E0131 -> sub_4DFE20: fxdynmapinfo.ssd SmartStream
  StageClearTreeStream: 206, // sub_5180A6: SmartStream [u16 LE count, count*(u32, u32, u32, str)]
  DynamicMapAndStageConfig: 207, // sub_4BCABF -> sub_4E0207: [u8 flag, u32 fxdynmapinfoChecksum, ...]
  ShopConfigSync: 208, // CShopStageNew::sub_53660B / sub_5493B7
  PackageMapIniStream: 210, // sub_4B966A -> sub_59426D: packagemap.ini SmartStream
  ShopResellResult: 212, // CShopDlg::sub_546D3F: [u8 res=0, str itemName, u32 stockId, u32 0, u32 refundLucci]
  ShopQMarkResult: 214, // CShopStageNew::sub_5396F0: [u32 type, u32 reward, u32 unk]
  ShopEventNotice: 215, // CShopConnectionMan::sub_52A129 ([u8(0)]) / CShopStageNew::sub_53C550
  PairStatsResult: 220, // CMyInfoDlg::sub_5447F0 -> sub_542D43
  UserGuildAndRank221: 221, // CMyInfoDlg::sub_5447F0 -> sub_542F22
  UserHistory222: 222, // CMyInfoDlg::sub_5447F0 -> sub_5431C7
  ShopConfigCrc224: 224, // sub_5493B7 -> sub_546C6B: [u8(1), u32 fxCrc, u32 strCrc, u32 pkgCrc, str url, u32 banners]
  ShopSaleModifiers: 229, // CShopStageNew::sub_53AC96
  RoomPasswordChangeResult: 231, // sub_4D3FD6
  NexonClubAuthResult: 232, // CStage::sub_4BC337: [u8 ok, u8 playerIdx, (if ok: str clubId)]
  PremiumSlotDuration: 235, // sub_4B9D05: [u32 slotMask, u32 duration]
  ItemLimitCounts: 237, // sub_4BA3ED: [u16 count, count*(u16 id, u16 a, u16 b, u16 c)]
  ShopGiftReceive: 238, // CShopStageNew::sub_537B1C: [str sender, u32 itemId, 8B vtime, sub_58EBFE]
  RankingTop3: 240, // sub_4A522B: [u8 count(<=3), count*sub_4A4FBD]
  ShopPurchaseDetail: 240, // CShopStageNew::sub_53B7D3
  SmsSendResult: 242, // CSmsDlg::sub_4838E8: [u8 res=10] (or CMyInfoDlg::sub_544049 couple check)
  SmsList: 243, // CSmsDlg::sub_484465: [u8 status=15, u8 count, msgs...]
  SmsDeleteResult: 244, // CSmsDlg::sub_47F653: [u8 res=1]
  SmsDeleteAllResult: 245, // CSmsDlg::sub_47F66A: [u8 res=1]
  SmsNewNotice: 246, // sub_5E3AC9 -> sub_5E369D: [u8 hasNewMail]
  UserQuestAndSlotInfo248: 248, // CStage::sub_4B9DB6
  CoupleInfoSync: 250, // CCouple::sub_5BBF91
  CoupleProposeIncoming: 251, // CCouple::sub_5BAA90
  CoupleProposeStatus: 252, // CCouple::sub_5BBD3E: [str proposer, u32 ringType, str msg, u8 flag]
  CoupleCongratulate: 253, // CCouple::sub_5BBAA7: [u8 actionType, u8 resultCode, str partnerName, u32 ringType]
  CoupleBreakupNotice: 254, // CCouple::sub_5BC155
  GachaponResult: 255, // CShopStageNew::sub_53BBD8 / CGachaponDlg::sub_5C23DB
  MyCharacterRank: 256, // sub_4B96F3 -> sub_4A527F: per player [u8 hasRank, (if hasRank: sub_4A4FBD, u32, u8)]
  GachaponResult257: 257, // sub_5C279C -> sub_5C23DB: [u8(0), u8 playerCount, per player items..., u32 lucci, str, str]
  BasketInfo258: 258, // sub_5C279C -> sub_5C261E: [u8 flag, u16 count, items..., str notice]
  BasketInfo: 259, // CBasketDlg::sub_5C0289 / sub_5C261E
  BasketCouponCounts: 260, // CBasketDlg::sub_5C0289
  ShopConnectionPermission: 261, // CShopConnectionMan::sub_52A129 / CUserMarketStage::sub_57224C
  UserMarketPermission: 262, // CShopConnectionMan::sub_52A1D2 -> StageId.UserMarket (20)
  UserMarketFeeInfo: 265, // CStage::sub_4BB408: [u32 feeRate, str notice, u32 minPrice] -> triggers C->S 320
  InventoryExpansionSlots: 268, // CStage::sub_4B9E20 -> sub_5832DB
  UserMarketEnterResult: 269, // CStage::sub_4BC642: [u8 result=1] -> transitions to Stage 20
  UserMarketListingPage: 270, // CUserMarketStage::sub_5725C0: [u32 maxLucci]
  UserMarketMaxLucci: 270,
  UserMarketListingDetail: 271, // CUserMarketStage::sub_5725A4: [u32 marketLucci]
  UserMarketBalance: 271,
  UserMarketBuyResult: 272, // CMarketSlotWnd::sub_57282A: [u16 total, u16 pageCount, listings...]
  UserMarketList: 272,
  UserMarketRegisterResult: 273, // CMarketSlotWnd::sub_56EE29: [u16 res, u32 stockId]
  UserMarketMyListings: 274, // CMarketSlotWnd::sub_56F04F: [u16 res, u32 stockId] (CancelResult)
  UserMarketCancelResult274: 274,
  UserMarketCancelResult: 275, // CMarketSlotWnd::sub_572AC5: [u16 count, listings...] (MySalesList)
  UserMarketMySalesList: 275,
  UserMarketTransferResult: 276, // CMarketSlotWnd::sub_56F8C4: [u16 res, u32 userLucci, u32 marketLucci]
  UserMarketPurchaseResult: 277, // CMarketSlotWnd::sub_56FB09: [u16 res, u32 stockId, u32 remainLucci, 8B f64 LE vtime]
  ShopCashBalance: 278, // CShopStageNew::sub_539A17: expired market returns
  MarketExpiredReturns: 278,
  ShopLucciBalance: 279, // CShopStageNew::sub_539C8B: sold market notifications
  MarketSoldNotifications: 279,
  UserMarketTradeableItems: 280, // CMarketSlotWnd::sub_571A0A: [i32 count, count * u32 stockId]
  SecurityChallenge1: 281, // CStage::sub_4BDBF5 -> sub_4B8F3F (sends C->S 332)
  SecurityChallenge2: 282, // CStage::sub_4BDBF5 -> sub_4BAD83
  SecurityChallenge3: 283, // CStage::sub_4BDBF5 -> sub_4BDA18
  SecurityChallenge4: 284, // CStage::sub_4BDBF5 -> sub_4BAE58 (sends C->S 333)
  EventStateUpdate: 289, // CStage::sub_4BDBF5 -> sub_55F830
} as const satisfies Record<string, number>;

export const UdpOpcode = {
  ServerKeepalive: 0, // reconstructed inner payload: [u16 BE(0), u32 BE(userId)]
  GameLoadRegistration: 1, // sub_4ED400: 36-byte load registration
  P2pPing: 2, // CUDPPeerManBase::sub_5EC6AD
  P2pPong: 3, // CUDPPeer::sub_5ECD2B
  ServerKeepaliveAck: 4, // CUDPPeerManBase::sub_5EC943 (1B [4]) or CGameStage::sub_4ECF93 (in-game frame)
} as const satisfies Record<string, number>;
