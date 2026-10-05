/**
 * Strongly-typed protocol mappings based on current-build `CA.exe` machine code,
 * `CA.exe.c`, and `.rdata` virtual tables (`0x7B322C`–`0x7C2204`).
 *
 * `ClientOpcode` / `ServerOpcode` are reconstruction-side symbols, not enum metadata
 * recovered from the Client PE. Each member's comment carries its own evidence limits.
 * Uses `as const satisfies` for literal numeric types and readable handler names.
 * This working inventory is not proof of exhaustive wire coverage.
 * Numeric aliases, stage-dependent overloads, incomplete parser associations, and
 * unresolved Client writer candidates and incomplete S->C receive dispatch coverage are tracked
 * in `server/docs/unknowns.md` (RE-12, RE-19).
 */

export const StageId = {
  Login: 1, // CLoginStage (0x00567400)
  Credit: 3, // CCreditStage (0x004BF1FF)
  UnverifiedStage8: 8, // Prior CAgreementStage attribution is unsupported in this build; cited VA 0x004A6E26 is inside sub_4A6D91, and the main stage factory has no case 8.
  UnverifiedStage9: 9, // Prior COnePageIDStage attribution is unsupported in this build; cited VA 0x0050EB5A is inside sub_50EA21, and the main stage factory has no case 9.
  SelectServer: 10, // CSelectServerStage (0x0056A9DA)
  Lobby: 11, // CLobbyStage (0x004C86A2)
  Prepare: 12, // CPrepareStage (0x004DCF07)
  Game: 13, // CGameStage (0x004F672F)
  Shop: 14, // CShopStageNew (0x0053C550)
  Chatting: 17, // CChattingStage (0x004B6418)
  Exchange: 18, // CExchangeStage (0x0055C714)
  Practice: 19, // CPrepareStagePractice (0x004D0793)
  UserMarket: 20, // CMainWnd::sub_5AEF3F case 20, only when Taiwan feature 28 is enabled
} as const satisfies Record<string, number>;

export type StageIdValue = (typeof StageId)[keyof typeof StageId];

export const ClientOpcode = {
  // Login, Registration & Security (CFxApp / CLoginStage / CNewUserDlg / password and E-Key dialogs)
  PreLoginSsdCheck: 0, // sub_5A1E40: [u32 dynamic-img context, u32 csysstr, u32 multisvr, u32 filterstr, (opt u32 multisvrn)]
  LoginCredentials: 2, // sub_5D8BD8: 1P/2P keyed username (0x11223344) + password (0x44332211)
  NewUserIdentifierCheck3: 3, // CNewUserDlgChina::sub_496AA6 [str, u8 selector] or CNewUserDlg::sub_498367 [str]; response UNKNOWN, not channel selection
  UnresolvedClientPacket4: 4, // sub_496D15 has feature/state-dependent forms; sub_4985CD emits [5*str, u8]; meaning/reply/backend association UNKNOWN
  SelectChannel: 5, // CSelectServerStage::sub_56AF39
  SessionHandoff: 6, // sub_5D8879 / sub_5D893D / sub_5D8A3F
  UploadCrashReport: 7, // sub_5A885A / sub_5D090B: [str crashInfo] (CA_Crash_info.nfo / Crash_CA.dmp.log)
  UploadCrashDump: 8, // sub_5D06FA: flag=1 u32 byteCount + block; sub_5D137C sends flag=0 without a block (u32 meaning unknown)
  RequestChannelList: 9, // sub_5D3BFC: [u32 channel2_%03d%s.ssd checksum]
  ClientSignal10: 10, // sub_563721 / sub_567400 / sub_5B2878: empty or [str]; server association UNKNOWN (not C->S 9 channel-cache request)
  LoginPassport: 11, // sub_5D85A0: keyed passport (0xAABBCCDD)
  ClientReportOrLobbyEnter: 12, // CStage report or lobby enter alias
  ReturnToChannelSelect: 13, // CLobbyStage::sub_4C1944
  ClientPeriodicStatus: 14, // sub_5AA9CC, emitted by sub_5AB8CB after >5000 ms: [u32 timeGetTime, u32 opaque context]
  ContextualClientPacket16: 16, // CChatStage::sub_4AD598 normal chat [str]; sub_4A3E36 also emits 16 after 72. No pre-login ID-check writer recovered in this build.
  UnresolvedClientPacket17: 17, // No direct writer recovered in the current CA.exe census; former CAgreementStage citation is an interior address, not a writer.
  UnresolvedClientPacket18: 18, // No direct writer recovered in checked CA.exe.c; former sub_516FA7 attribution withdrawn.
  UnresolvedClientPacket19: 19, // No direct writer recovered in the current CA.exe census; sub_4AD598 writes 16, 20, and 97, not 19.
  Whisper: 20, // CChatStage::sub_4AD598: [str targetUsername, str message]; no TCP ping writer confirmed
  MessengerInviteUser: 21, // sub_4B4F83 / sub_4DB16C / sub_55AAF0 / sub_5E9F86: [u16 roomNum, u32 key, str targetUser, u8 flag]
  RoomEmotion: 22, // Emotion packet
  RequestDynI16Table: 27, // sub_59A700: [u32 crc, u16 count]
  RequestAvatarI16Table: 28, // sub_59B5A2: [u32 crc, u16 count]
  NexonClubAuthRequest29: 29, // CNexonClubDlg::sub_46BABD: [str id, str password or feature-64 MD5-derived value]; response association UNKNOWN
  UnresolvedClientPacket30: 30, // Project-side candidate only; no direct numeric writer/caller recovered in bounded CA.exe + CA.exe.c search; origin/compiled status UNKNOWN
  LoginBeanfunToken: 31, // sub_5D8494: Taiwan Beanfun / GASH token login
  EKeyVerify: 32, // CEKeyDlg::sub_55FB0B: PlaySafe / E-Key security token verification
  EKeyChallengeResponse: 33, // CEKeyDlg::sub_561394: E-Key challenge response
  UnresolvedClientPacket34: 34, // sub_49A5CA / sub_49A7F4: [u8 mode(0/1), str]; meaning/reply association UNKNOWN
  UnresolvedClientPacket35: 35, // sub_49AB07: [5*str, u8, 2*str]; meaning/reply/backend association UNKNOWN
  UnresolvedClientPacket36: 36, // sub_49B6E4: [2*str, u8]; meaning/reply/backend association UNKNOWN
  RequestShopConnection: 37, // CShopConnectionMan::sub_529AFB
  AuthenticateShopConnection: 38, // CShopConnectionMan::sub_529D8E
  MacroListQuery: 40, // sub_4A29A1: [u8(0)] -> S->C 50
  QuestAction: 44, // CQuestWnd::sub_551AE2 -> S->C 248
  ChangeAccountPassword: 46, // CNCPasswordDlg::sub_495C32: three strings; response/backend association UNKNOWN
  UnresolvedClientPacket49: 49, // Project-side candidate only; no direct numeric writer/caller recovered in bounded CA.exe + CA.exe.c search; origin/compiled status UNKNOWN

  // User Info, Ranking & Lobby (CLobbyStage / CStage / CRankMan)
  QueryRankingPage: 64, // sub_4A48F2: [u16 startRank] -> S->C 69 / S->C 66
  ModifyUserInfo: 65, // sub_5495CD
  QueryUserInfo66: 66, // CStage::sub_4BC236: [str username, u8(1), u8 localIdx] -> S->C 81 + S->C 248 + S->C 71
  RoomDetailOrUserInfo: 67, // sub_4C266D: [u16 roomIdx, u32 roomKey] -> S->C 83
  UserPagePacket68: 68, // CUserPageDialog::sub_53DEEA emits [str stored name]; response route/schema UNKNOWN
  QueryUserBrief: 69, // sub_4A0321: [u32 userId] -> S->C 70
  QueryUserInfo: 70, // CChatStage::sub_4ABBDE: [u8(0), str username] -> S->C 81 + 70; distinct from S->C ServerOpcode 70 PUserInfoResult
  UpdateUserOptions: 71, // sub_4A63C9: [u8 optionFlags]
  UseSuperSpeaker: 72, // sub_4A3E36: [u8 localIdx, u8 speakerType, str msg] -> S->C 65 + S->C 21
  SaveDefaultChars: 73, // sub_4BABFF / sub_54728B: [u8 playerCount, playerCount * u8 charId]
  UpdatePremiumSlotState: 74, // sub_5ED25A: [u8 playerIdx, u8 state]
  CreateRoom: 75, // sub_4CD379 / sub_4CAC9F / sub_4CB60D / sub_4CC28E -> S->C 79 + S->C 102
  JoinRoom: 76, // sub_4C4D93 -> S->C 80 + S->C 102
  QuickJoin: 77, // sub_4C83BA / CNormalLobbyStrategy::sub_4CCCE2 -> S->C 81
  LeaveRoom: 78, // sub_5AA580: []; Client locally enters Lobby before send; S->C 9 is a dump-offset route in GameServer stages
  CreateRoomShort: 79, // sub_4C070B -> S->C 79 + S->C 102
  RoomListScrollOrDetail: 80, // sub_4A496F -> S->C 83
  QuickJoinShort: 81, // Quick join alias -> S->C 81
  ReturnToRoom: 82, // sub_536E2E -> S->C 80
  EnterLobby: 83, // CStage::sub_4B94A6 -> S->C 89 + local S->C 186 candidate + S->C 82
  LobbyConditionalSignal261: 261, // CLobbyStage::sub_4C99DC: empty; feature 18 + sub_59DBD9()==79 + j[2013] gate; no Shop-click or reply association

  // Room / Prepare / Exchange Stage (CPrepareStage / CExchangeStage)
  UpdateRoomSettings: 84, // sub_4D6803 / sub_4D689B -> S->C 93
  ToggleReady: 86, // sub_4D5B2F: [u8 readyState, u32 esfnChecksum] -> S->C 104
  SelectMap: 87, // sub_4D1E59: [u16 mapId, u32 mapKey] -> S->C 109
  SelectTeamColor: 88, // sub_4D2A67: [u8((localIdx<<4)|team)] -> S->C 105 + S->C 104
  SelectCharacter: 89, // sub_4D2AFD: [u8 localIdx, u8 charId] -> S->C 106 + S->C 104
  ToggleSlotOpen: 90, // sub_4D2BB8: [u8((slotIdx<<4)|open)] -> S->C 107 + S->C 104
  KickPlayer: 91, // CPrepareStage::sub_4DAE65: [u32 targetSlotNetId, u8 hasSuperChiefItem]
  BanVoteResponse: 92, // sub_4D555E -> S->C 111
  StartMatch: 93, // sub_4D5DB1 + sub_4DF2EC -> S->C 112 + S->C 113
  ChangeRoomPassword: 94, // sub_4DB16C -> S->C 231 + S->C 93
  EquipQuickSlotOrEmotion: 95, // sub_4D2716 (5B quick-slot) -> S->C 115 or emotion
  PracticeHandicap: 96, // sub_4D0627 -> S->C 108
  TeamChat: 97, // CChatStage::sub_4AD598 -> S->C 114
  RoomAux98: 98, // shared sub_4B8E1D writer: [u8 value], called from shop-connection and UserMarket sub_5723F6 paths
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
  UnresolvedClientPacket252: 252, // No current-build Client writer recovered; prior packagemap.ini / S->C 157 association withdrawn.
  UnresolvedClientPacket266: 266, // Project-side candidate only; no direct numeric writer/caller recovered in bounded census; no RoomAvatarSync alias evidence, origin/compiled status UNKNOWN.
  UnresolvedClientPacket267: 267, // No current-build Client writer recovered; prior notice-URL request / S->C 163 association withdrawn.
  ShopEnter: 269, // CShopStageNew::sub_536555 / sub_589DB9: [u8 mode] -> S->C 198
  ShopCashQuery: 269, // sub_589DB9: [u8(0)] -> S->C 198
  ShopBuyItem: 270, // sub_58B130: [u32 selected-object +8, u32 opaque caller value] -> S->C 199
  InventoryDeleteItem: 271, // sub_58013E: [u32 stock-container value, feature-26 str?, u32 caller value] -> S->C 202
  ShopAction: 273, // CShopStageNew::sub_53C550 -> sub_5816F4: equip/sync active items
  InventoryEquipSync: 273, // sub_5816F4: [u8 mode, u8 playerIdx, u16 count, count*(u8 slot, u32 stockId)]
  ShopUseOrEquip274: 274, // sub_541682 / sub_594F84: [u8 playerIdx, u8 slotIdx, u32 stockId, str customText]
  InventoryEquipSlot: 274,
  ShopInventoryTab275: 275, // CShopTextDlg::sub_48ED44: [u8 playerIdx, u8 count, count*(u32 stockId, str text)]
  InventoryUpdateText: 275,
  RequestFxStockIni: 276, // sub_594353: request fxstock.ini SmartStream -> S->C 193 (sub_4B95B0)
  ShopBillingCheck: 277, // sub_589D78 -> S->C 201 (sub_58C8EA)
  RequestStringTableIni: 278, // sub_59449A: request stringtable.ini SmartStream -> S->C 200 (sub_4B95F7); distinct from S->C UserMarket notifications 278/279
  ShopSendGift: 279, // CShopGiftSendDlg::sub_52C5A2: [u32 packageId, str receiver, str title, str message, u8 flag]; official response/destination policy UNKNOWN
  ShopBuy280: 280, // CShopCouponDlg::sub_492CD9 / sub_492E5C: [str couponCode, str targetUser] -> S->C 204
  ShopRedeemCoupon: 280,
  RequestPackageMapIni: 281, // sub_5943FB: request packagemap.ini SmartStream -> S->C 210 (sub_4B966A)
  RequestDynamicMapInfoSsd: 282, // sub_4DD5D3: request fxdynmapinfo.ssd SmartStream -> S->C 205 (sub_4E0131)
  ShopResellItem: 283, // sub_58BFE0: [u32 selected-object +8, u32 caller value] -> S->C 212 (sub_546D3F), DB mapping unverified
  NexonClubAuth: 284, // sub_4BCB70 (CNexonClubDlg): [u8, str, str]; field meanings and S->C association UNKNOWN
  ShopLeave: 285, // CShopStageNew::sub_536DB3 / sub_5B76C2 -> S->C 214 / S->C 99
  ShopIdentifyQMark: 285,
  RedeemCouponCode: 286, // CCouponDlg::sub_5B6215: [u32 couponTypeOrId] -> S->C 204
  ShopSaveSlotOrder: 288, // sub_53809C: [u32 playerIdx, u32 count, count*(u32 pkgId, u32 a, u32 b)]
  UserDetailQuery: 289, // sub_549904: [str username] -> S->C 81
  UserPagePacket290: 290, // CUserPageDialog::sub_53DEEA emits [str stored name]; response opcode/schema UNKNOWN
  UserGuildModify: 292, // sub_5495CD: [u8 playerIdx, str guild]
  UserPagePacket293: 293, // CUserPageDialog::sub_53DEEA emits [str stored name] conditionally; response association UNKNOWN
  LobbyInitializationSignal294: 294, // sub_4C135B sends an empty packet from CLobbyStage::sub_4C99DC; meaning/reply association UNKNOWN (not a stringtable checksum).
  ShopStateSync: 295, // sub_5365B3: [u8 state]
  QueryTop3Rank: 296, // sub_4A49D8: empty -> S->C 240 (sub_4A522B)
  SmsSend: 297, // CSmsDlg::sub_4810F3: [str sender, str receiver, str msg] -> S->C 242 + S->C 246
  SmsQuery: 298, // CSmsDlg::sub_47F58F / sub_5E415C: [str username, u8 mode] -> S->C 243 / S->C 246
  SmsDelete: 299, // CSmsDlg::sub_47FDCB: [str username, u32 msgId] -> S->C 244
  SmsDeleteAll: 300, // CSmsDlg::sub_47F5F7: [str username] -> S->C 245
  LobbyInitQuery: 301, // CLobbyStage::sub_4C99DC: empty
  MyPagePreOpen: 302, // CStage::sub_4BC236: empty
  ContextualClientPacket303: 303, // sub_4BB107: [u8 loop index]; sub_55195E: [u8 a2]; sub_5382EA: empty; reply association/meaning UNKNOWN
  CouplePropose: 304, // sub_5BA82D writes [u8 playerIdx, str partnerName, str message]; official reply association UNKNOWN
  CoupleRespond: 305, // CCouple::sub_5B9FD6 writes [u8 playerIdx, u8 accept]; no current-build FxStock-check writer/reply recovered.
  CoupleBreakup: 306, // sub_5BA899 writes [u8 playerIdx]; official reply/fan-out policy UNKNOWN
  GachaponRoll: 307, // CGachaponDlg::sub_5C3330: [u32 couponStockId] -> S->C 255 / 257
  GachaponClose: 308, // sub_5BF559
  ShopBuyItemPass: 309, // sub_58B871: [str NexonPass, u32 selected-object +8, u32 opaque caller value] -> S->C 199
  UnresolvedClientPacket310: 310, // sub_58EBFE conditional writer at 0x005905B8: [u8 caller-supplied n0xB]; reached from S->C 199/238 parsers, but semantics/official reply policy UNKNOWN
  QueryMyCharacterRank: 311, // sub_4A4A0F: empty -> S->C 256 (sub_4B96F3 -> sub_4A527F)
  BasketOpen: 312, // sub_5C2A43
  BasketQueryInfo: 313, // CBasketDlg::sub_5C0C05 -> S->C 258 / 259
  BasketQueryCoupons: 314, // CBasketDlg::sub_5C0C05: [u8 playerIdx] -> S->C 259 / 260
  BasketThrowAway: 315, // sub_5BF4F8: [u32 id, u8 playerIdx]
  RequestShopConnectionAlt: 316, // CShopConnectionMan::sub_529AFB
  ShopActionNotify: 317, // sub_529A40: [u8 action]
  RequestUserMarketConnection: 318, // CShopConnectionMan::sub_529D8E: empty when this+8==2; semantic label is not independently proven
  UserMarketFeeInfoReply320: 320, // CStage::sub_4BB408: [u32 feeRate, str notice, u32 minPrice]
  UserMarketStageEntry321: 321, // sub_5723F6: [u8 fieldA, u8 localIdx]; CSendPacket vtable 0x007BF714 slot +0x40 -> sub_695FE0; then C->S 98
  NexonClubDialogSubmit322: 322, // CChatStage::sub_4B0A63 after CNexonClubDlg result: [str fieldA, str dialogField]
  StageAction323: 323, // sub_4BAC7B: two u8 fields after local user/allowed-stage gates; action meanings unresolved
  UserMarketStageSync324: 324, // CUserMarketStage::sub_5722B3: [u8 localIdx], when this+1982 != 0; CSendPacket vtable 0x007BF714 slot +0x40 -> sub_695FE0 (1 byte)
  UserMarketFilterState325: 325, // CMarketSlotWnd::sub_570B4D: [u8, u8, u16, u8]; field meanings are not fully resolved
  UserMarketRegisterListing326: 326, // CRegisterItemDlg::sub_5753E3: [u32 selectedItemField, u32 priceField]
  UserMarketCancelListing: 327, // sub_56EE29: [u32 selected market field] after stop-selling confirmation
  UserMarketSearchText328: 328, // sub_56EF5B: [str, u16, u8 localIdx]
  UserMarketTransferLucci: 329, // sub_573F64: [u8 localIdx, u32 amount]; no direction byte in this writer
  UserMarketBuyListing: 330, // sub_577C7E: [u32 listingId] -> S->C 277
  SecurityHashReply1: 332, // sub_4B8F3F: [u32 hash] (reply to S->C 281)
  SecurityHashReply2: 333, // sub_4BAE58: [u32 hash] (reply to S->C 284)
  ClientAuditLog: 337, // sub_476AD6 / CChatStage::sub_4AEE8E / sub_53809C: [str tag, str detail]
  PostStageSync338: 338, // empty C->S frame from CStage::sub_4B94A6 -> S->C 207 (sub_4BCABF)
} as const satisfies Record<string, number>;

export const ServerOpcode = {
  // Pre-Login & Auth Responses
  StageSlot45Route0: 0, // On typed-registry miss, CStage::sub_4BDBF5 forwards S->C 0 to current root-vtable slot 45 (+0xB4); payload/meaning UNKNOWN
  MultiServerSsd: 1, // sub_5D7E8E: multisvr.ssd (+ multisvrn.ssd if feature 68)
  SystemStringSsd: 2, // sub_5D00B9: csysstr.ssd
  LoginVariantRoute4: 4, // Normal Login -> sub_567400; China Login -> sub_563721; layouts are not equated
  LoginResult: 4, // Normal CLoginStage::sub_567400 -> sub_566E08; China Login has a separate case-4 parser
  LoginStageRoute5: 5, // Normal Login -> sub_566975; China Login -> sub_5628E2; conditional/result fields and request meaning UNKNOWN
  LoginStageRoute6: 6, // Normal Login -> sub_5690F0; China Login -> sub_562B2C; conditional/result fields and request meaning UNKNOWN
  ChinaLoginStageRoute40: 40, // CLoginStageChina::sub_5654E8 -> sub_5643A0; schema/meaning UNKNOWN
  ChinaLoginStageRoute44: 44, // CLoginStageChina::sub_5654E8 -> sub_562D42; schema/meaning UNKNOWN
  ChinaLoginStageRoute45: 45, // CLoginStageChina::sub_5654E8 -> sub_562F8E; schema/meaning UNKNOWN
  ChinaLoginStageRoute46: 46, // CLoginStageChina::sub_5654E8 -> sub_563359; schema/meaning UNKNOWN
  StageSpecificRoute7: 7, // SelectServer channel result; Chatting -> sub_4B3BF9 and Exchange -> sub_4B7B3E are separate routes
  ChannelSelectResult: 7, // CSelectServerStage::sub_56C0C8
  // Generic CStage::sub_4BDBF5 routes S->C 9 to a Crash_CA.dmp offset request (-> C->S 8);
  // it is not a generic stage transition in the recovered SelectServer/Shop dispatch paths.
  CrashDumpChunkRequest: 9,
  ChannelListSsd: 10, // sub_5D42CF -> sub_5D3E91: channel2_%03d%s.ssd
  LoginStageRoute11: 11, // Normal Login -> sub_567B0F; China Login -> sub_56442A; distinct parsers, schema equivalence UNKNOWN
  MessengerHandoff: 11, // Normal CLoginStage::sub_567B0F; China Login has a separate case-11 parser
  StageSpecificRoute12: 12, // Base/normal Login/China Login/SelectServer have separate parsers; all read a u16 count and u16 entries via sub_697510, then narrow entries to char for sub_5D4025
  ChannelLoads: 12, // Descriptive local alias; do not infer field meaning from the name
  SelectServerStageRoute52: 52, // CSelectServerStage::sub_56D2FB -> sub_4B9D05: [u32, u32], second value narrowed to char; meanings UNKNOWN
  LoginStageRoute59: 59, // CLoginStage::sub_569420 -> sub_565F02; conditional [u8, str] or no field read; request association UNKNOWN
  LoginStageRoute61: 61, // CLoginStage::sub_569420 -> sub_567CCD; feature-gated [u8 result, if 0: 2*str]; request association UNKNOWN
  StageSpecificRoute13: 13, // CStage fallback dispatches through current root slot 48; SelectServer routes this value to Lobby via sub_56A9DA; stage context matters
  LobbyStageTransition: 13, // CSelectServerStage root dispatch: slot 48 -> sub_56A9DA -> CStage::sub_4B96B1; requests StageId.Lobby (11)
  StageSlot50Route14: 14, // CStage::sub_4BDBF5 case 14 -> current root-vtable slot 50 (+0xC8); stage-specific handlers, common payload/meaning UNKNOWN
  LobbyGuildUserOnlyNotice: 15, // CLobbyStage::sub_4C86A2 -> sub_4C5DE7; modal + PostQuitMessage
  StageSpecificRoute16: 16, // CStage fallback parses Shop init; CGameStage has a distinct immediate-return case 16
  ShopInitAndStage14: 16, // sub_4BB82A: shop checksums (fxstock, stringtable, packagemap) + qmarksfn.ssd + banners
  StageSpecificRoute17: 17, // CStage::sub_4BDBF5 -> sub_4B96E5 -> sub_5AAA5C(..., 16); this branch reads no payload; outcome/meaning UNKNOWN
  StageId16TransitionRequest17: 17, // Descriptive alias for the observed Client call only; no StageId-16 factory branch found
  UnresolvedServerPacket18: 18, // CStage::sub_4BDBF5 reads [u32, u32] then dispatches; semantics UNKNOWN
  UserDynamicInfoSync: 19, // CStage fallback -> sub_4BA3BA -> sub_5ED779: u8 count + per-user records; authHandler sends after S->C 4 with only level mapped and opaque defaults for other fields.
  StageRecordList20: 20, // CStage::sub_4BDBF5 -> sub_4B9D2B: [u8 count, count*(u32, u16)] updates the global object at dword_92A1BC; record meanings UNKNOWN, not a confirmed ping
  NormalChat: 21, // CChatStage::sub_4B070C / CGameStage::sub_4F4D49
  StageSlot53Route22: 22, // CStage::sub_4BDBF5 case 22 -> current root-vtable slot 53 (+0xD4); base CStage::sub_4BB98F has a mode-dependent parser; stage-specific
  WhisperOrEmotion: 23, // CChatStage::sub_4A8727 / CGameStage::sub_4F4F4B
  WhisperDeliveryStatus: 24, // CChatStage::sub_4AE106
  LobbyStageRoute25: 25, // CLobbyStage::sub_4C86A2 case 25 -> sub_4C7D37 when sub_5ED6AA(n0xB, 7) == 0; payload semantics/schema not fully mapped
  ChatStageRoute26: 26, // CChatStage::sub_4B0A63 -> sub_4AC937: [str, u8], field meanings UNKNOWN; the common epilogue then calls CStage fallback
  ChatStageRoute27: 27, // CChatStage::sub_4B0A63 -> sub_4AC9BE: [u8, str], field meanings UNKNOWN; the common epilogue then calls CStage fallback
  ChatStageRoute28: 28, // CChatStage::sub_4B0A63 -> sub_4AA81D; field mapping/meaning UNKNOWN
  LobbyStageRoute29: 29, // CLobbyStage::sub_4C86A2 -> sub_4C5EB3; payload semantics/schema not fully mapped
  ChatStageRoute31: 31, // CChatStage::sub_4B0A63 -> sub_4AE20E; field mapping/meaning UNKNOWN
  StageSpecificRoute32: 32, // CStage fallback -> dynamic-I16 parser; CLobbyStage case 32 instead dispatches root slot 56 (+0xE0)
  DynamicI16Data: 32, // CStage fallback -> sub_4B8D5F -> sub_59D0D4; CLobbyStage also has an independent case 32 -> root slot 56 (+0xE0)
  LobbyStageRoute32: 32, // CLobbyStage::sub_4C86A2 case 32 -> root slot 56 (+0xE0); do not assume it is the CStage DynamicI16 parser
  SelectServerDynamicI16Data: 33, // CSelectServerStage root dispatch: slot 54 -> CStage::sub_4B8D5F; not the Lobby transition
  StageSpecificRoute34: 34, // Base-fallback observer -> CNexonClubDlg::sub_46C2AD; CExchangeStage has a separate direct case -> sub_55B6DB
  NexonClubDialogStatus34: 34, // Base-fallback CNexonClubDlg::sub_46C2AD -> sub_46BBB1 reads a u8; no request association confirmed
  ShopReturnHandoff: 41, // CShopConnectionMan::sub_52A23C: [u16, u16, u32 key, str, u8=11]
  StageSpecificRoute48: 48, // CShopConnectionMan has an endpoint parser; Lobby/Session/Prepare/Chatting also dispatch 48 through stage-specific slot 57 (+0xE4)
  ShopServerEndpoint: 48, // CShopConnectionMan::sub_529E8D parser; Lobby/Session/Prepare/Chatting stages also dispatch S->C 48 through stage-specific slot 57 (+0xE4)
  ChatStageRoute49: 49, // CChatStage::sub_4B0A63 -> sub_4ABB7B; field mapping/meaning UNKNOWN
  LobbyStageRoute48: 48, // CLobbyStage::sub_4C86A2 case 48 -> root slot 57 (+0xE4); distinct stage context from Shop endpoint 48
  MacroList: 50, // sub_4A27CB: repeat to EOF [u32 value, u8[15] fields]; empty body = 0 records
  FilterStringSsd: 53, // sub_5C8BE3: filterstr.ssd
  ChatStageRoute57: 57, // CChatStage::sub_4B0A63 -> sub_4A9D9E; field mapping/meaning UNKNOWN
  ChatStageRoute58: 58, // CChatStage::sub_4B0A63 -> sub_4A8537; field mapping/meaning UNKNOWN
  StageFallbackNoOp55: 55, // CStage::sub_4BDBF5 returns immediately for 55 without reading the body or running the observer fan-out
  MapNameOverrides: 60, // sub_5D9F0B -> sub_5C578E: [i32 count, count*(u32 mapId, str name)]
  UserItemsSyncLegacy: 63, // Project label only; Client routes via sub_4BDBF5 -> sub_4B9654 and sub_5B2B2D both reach sub_598BEC(dword_929C70) -> sub_597611; same reader as S->C 197, trigger/meaning UNKNOWN

  // Lobby, Ranking, Room & Exchange Responses
  SuperSpeakerBanner: 65, // sub_4B976C -> sub_4A03EB
  RankingListAlt: 66, // sub_4A51B5: [u16 startRank, u8 count, count*sub_4A4FBD]
  RankingList: 69, // sub_4A5114: [u16 startRank, u8 count, count*sub_4A4FBD]
  UserInfoModal70: 70, // PUserInfoResult -> Lobby sub_4C128B clears stage+6180, then sub_4A6379 -> sub_4BBCA8; modal may re-enter the +380-gated Shop helper, but does not set +380
  StageSpecificRoute71: 71, // CMyInfoDlg profile parser and state-gated CChatStage case -> sub_4ACB63 are distinct; schema/meaning not equated
  UserStats71: 71, // CMyInfoDlg::sub_541F65; CChatStage also has a separate state-gated case 71 -> sub_4ACB63
  ChatStageRoute73: 73, // CChatStage::sub_4B0A63 -> root slot 80 (+0x140); field mapping/meaning UNKNOWN
  ChatStageRoute77: 77, // CChatStage::sub_4B0A63 -> sub_4A9245; field mapping/meaning UNKNOWN
  QuestConfigSync: 75, // CStage::sub_4B94A6 -> C->S 83 + empty C->S 338 when feature 32 is enabled
  StageChannelCacheValidation76: 76, // CStage::sub_4BDBF5 -> sub_4B945F: conditional [u32] cache comparison/reload path; meaning/request association UNKNOWN
  StageRecordList78: 78, // CStage::sub_4BDBF5 -> sub_4B990D -> sub_5935DC: [u32 count, count*(u8, u32, str)]; record meanings UNKNOWN
  CreateRoomResult: 79, // CNormalLobbyStrategy::sub_4CCE53
  JoinRoomResult: 80, // CLobbyStage::sub_4C455D
  QuickJoinOrUserProfile: 81, // CLobbyStage::sub_4C4635 (QuickJoin) / CStage::sub_4BCDFF (UserProfile)
  LobbyRoomListEntry: 82, // CLobbyStage::sub_4C1E57 -> sub_4C1B1B
  RoomDetailInfo: 83, // CNormalLobbyStrategy::sub_4CD139
  LobbyRoomListEntryCompact: 84, // CLobbyStage::sub_4C1E90 -> sub_4C1C0A
  LobbyRoomSlotUpdate: 85, // CLobbyStage::sub_4C1F02 -> sub_4C32E4
  LobbyRoomSlotRemove: 86, // CLobbyStage::sub_4C1EC9
  LobbyStageRoute67: 67, // CLobbyStage::sub_4C86A2 -> sub_4C192A; payload semantics/schema not fully mapped
  LobbyStageRoute88: 88, // CLobbyStage::sub_4C86A2 -> sub_4C4B28; payload semantics/schema not fully mapped
  ExpSync: 89, // CStage::sub_4B992F
  RoomSettingsSync: 93, // CPrepareStage::sub_4D6BC2
  StageSpecificRoute99: 99, // CStage fallback, Shop connection manager, and UserMarket have separate S->C 99 paths
  ShopLeaveReturnStage: 99, // CShopConnectionMan::sub_529EB2: [u16 targetStageId] -> C->S 82 or 78; separate from CStage fallback case 99 -> sub_4B9D81
  SetPlayerOnPrepare: 102, // CSlotStage::sub_4B89E4 (CSetPlayerOnPreparePacket)
  PlayerLeftSlot: 103, // CSessionStage::sub_4B789B [u8 slotIdx, u32 removedNetId, u8 flag] -> CPrepareStage::sub_4D4154
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
  StageSpecificRoute115: 115, // CPrepareStage -> sub_4D2190; CGameStage has a separate case 115 -> sub_4EA184
  QuickSlotEquipSync: 115, // CPrepareStage::sub_4D2190; not generalized to the CGameStage case-115 route
  StageSpecificRoute110: 110, // CPrepareStage -> sub_4D54B1 and CChattingStage -> sub_4B3310; stage-specific payloads/meanings UNKNOWN
  StageSpecificRoute116: 116, // Direct cases in CPrepareStage, CChattingStage, CExchangeStage, and CShopStageNew; no common schema/meaning assumed
  StageSpecificRoute117: 117, // Direct cases in CPrepareStage and CChattingStage; stage-specific payloads/meanings UNKNOWN
  PrepareStageRoute118: 118, // CPrepareStage::sub_4DCF07 -> sub_4D62E7; payload semantics/schema not fully mapped
  PrepareStageRoute119: 119, // CPrepareStage::sub_4DCF07 -> sub_4D639F; payload semantics/schema not fully mapped
  ChattingStageRoute121: 121, // CChattingStage::sub_4B6418 -> sub_4B4780; payload semantics/schema not fully mapped
  PrepareStageRoute124: 124, // CPrepareStage::sub_4DCF07 -> sub_4D645F; payload semantics/schema not fully mapped
  StageSlot47Route122: 122, // CStage::sub_4BDBF5 -> sub_4BB3AE [u8, u32, str] -> current root slot 47; field meanings/stage overrides UNKNOWN
  UserDynamicInfoBytePairs123: 123, // CStage::sub_4BDBF5 -> sub_4B956B: [u8 count, count*(u8, u8)] -> sub_5ED2DC; field meanings UNKNOWN
  ExchangeState: 126, // CExchangeStage::sub_55C14B: [u8 state, u8 msgId, (opt str)]
  ExchangeMessage: 127, // CExchangeStage::sub_559DCC: [u8 msgId, (opt str)]
  ExchangeItems: 128, // CExchangeStage::sub_5578FF -> sub_55D805: [u8 slot, u32 lucci, u8 count, count*(u32 stockId, 16B SYSTEMTIME)]
  ExchangeAccessories: 129, // CExchangeStage::sub_55AA90: maxPlayers * CSlotAccessoryPacket
  ExchangePassResult: 130, // CExchangeStage::sub_55B611: [u8 ok]
  SessionStageRoute133: 133, // CSessionStage::sub_4B7DF2 -> sub_4B722D; payload semantics/schema not fully mapped
  SessionStageRoute134: 134, // CSessionStage::sub_4B7DF2 stores one u8 in j[2014]; meaning UNKNOWN
  SessionStageRoute187: 187, // CSessionStage::sub_4B7DF2 -> sub_4B72A9; payload semantics/schema not fully mapped

  // In-Game Match Responses (CGameStage::sub_4F672F — 0x004F672F)
  UdpRelayFallback: 125, // CUDPPeerManBase::sub_5ECBF0
  GameStageRoute164: 164, // CGameStage::sub_4F672F -> sub_4EE5E6; payload semantics/schema not fully mapped
  StageSpecificRoute165: 165, // CGameStage -> sub_4EAC12 and CPrepareStage -> sub_4D2C53; distinct stage handlers, meanings UNKNOWN
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
  GameStageRoute167: 167, // CGameStage::sub_4F672F -> sub_4EE4DF; payload semantics/schema not fully mapped
  GameStageRoute168: 168, // CGameStage::sub_4F672F -> sub_4F4461; payload semantics/schema not fully mapped
  GameStageRoute169: 169, // CGameStage::sub_4F672F -> sub_4F65C3; payload semantics/schema not fully mapped
  BomberRevived: 156, // CGameStage::sub_4ECDDB: [u8 bomberIdx, u8 slotIdx]
  BomberEliminated: 157, // CGameStage::sub_4ECEF0: [u8 bomberIdx]
  BomberRebirthGhost: 158, // CGameStage::sub_4F13F5: [u8 slotIdx]
  BomberTrapped: 165, // CGameStage::sub_4EAC12: [u8 bomberIdx, u16 x, u16 y]
  RoundTransition: 166, // CGameStage::sub_4F59E4
  BombThrownArc: 170, // CGameStage::sub_4EAA9C: [u8 bomberIdx, u8 bombId, u32 srcX, u32 srcY, u8 dstX, u8 dstY]
  SyncObjectCreate: 175, // CSyncGameObjectMan::sub_5F11FE
  SyncObjectUpdate: 176, // CSyncGameObjectMan::sub_5F11FE
  SyncObjectRemove: 177, // CSyncGameObjectMan::sub_5F11FE
  GameStageRoute171: 171, // CGameStage::sub_4F672F -> sub_4EC561; payload semantics/schema not fully mapped
  GameStageRoute173: 173, // CGameStage::sub_4F672F -> sub_4EE764; payload semantics/schema not fully mapped
  GameStageRoute174: 174, // CGameStage::sub_4F672F -> sub_4EA592; payload semantics/schema not fully mapped
  ChatStageRoute120: 120, // CChatStage::sub_4B0A63 -> sub_4AA868; field mapping/meaning UNKNOWN
  StageSpecificRoute184: 184, // Direct cases in CGameStage, CPrepareStage, and CChattingStage; stage-specific payloads/meanings UNKNOWN
  StageSpecificRoute191: 191, // CGameStage -> sub_4F0621 and CChatStage -> sub_4AD3CA; distinct stage handlers
  BombThrownBroadcast: 180, // CGameStage::sub_4EAC86: [u8 bombId, u8 bomberIdx, u8 x, u8 y]
  SpecialBombBroadcast: 181, // CGameStage::sub_4EEC85
  InGameAliveCheck: 182, // CGameStage::sub_4EA141 -> triggers C->S 145

  // Config / Shop / Inventory / UserMarket / Couple / SMS Responses
  UnresolvedServerPacket163: 163, // No current Client receive route or request association recovered; prior C->S 267 notice-URL guess withdrawn.
  UnresolvedServerPacket179: 179, // No current Client receive route or request association recovered; prior C->S 294 stringtable-ack guess withdrawn.
  GameServerTypedRoute183: 183, // CTimebombComponent registers PTimebombServer through the GameServer typed registry; payload meaning/schema UNKNOWN
  UserRestrictionNotice185: 185, // CStage::sub_4BDBF5 -> current root slot 74 -> sub_4BC508: [u16 restrictionId, u8 restrictionValue]; stage/context effects may vary
  StageDynamicFieldRoute235: 235, // CStage fallback -> sub_4B9D05: [u32, u32], second narrowed to char; same helper is also selected by S->C 52, field meanings UNKNOWN
  UserDynamicInfoFieldSync186: 186, // CStage::sub_4BDBF5 -> sub_4B93FD -> sub_5ED36F: [u32 opaqueA, u32 opaqueB narrowed to char]; field meaning/request association UNKNOWN
  InventoryUpdate: 188, // CStage case 188 -> sub_4B9DAB -> CUserInventoryMan::sub_5953FE; [u8 playerCount, per player: u32 itemCount, itemCount*sub_594ECF]
  DynamicImgInfoSsd: 189, // sub_49E093: fxdynimginfo.ssd
  StageSpecificRoute190: 190, // CGameStage case 190 -> sub_4F054D reads no packet fields; CStage/ShopStage have no direct 190 case in the inspected switches
  ShopLocalUpdate190: 190, // Local Shop purchase path emits one u32 from user.lucci; no Client Shop receive schema/field meaning or official trigger is established
  FxStockIniStream: 193, // sub_4B95B0 -> sub_593FF6: fxstock.ini SmartStream
  InventoryData: 194, // CStage case 194 -> sub_4B963E -> CUserInventoryMan::sub_595272; [u8 playerCount, per player: u32 itemCount, itemCount*sub_594ECF]
  EquippedAvatarData: 196, // CUserInventoryMan::sub_597040: [u8 playerCount, 8 * (u32 stockId, str text)]
  UserItemsData: 197, // Client CStage fallback -> sub_4B9654 -> sub_598BEC(dword_929C70) -> sub_597611; [u16 count, repeated offset-based UserItem fields, optional feature-28 u8]; trigger/meaning UNKNOWN
  StageSpecificRoute198: 198, // CShopStageNew case 198 -> sub_53885C reads [u32, u8]; local builders using this ID have distinct, reconstruction-only bodies
  ShopLocalStockList198: 198, // Reconstruction-only stock-list builder; this body is not established by the direct Client case-198 parser
  ShopCashBalance198: 198,
  ShopBuyResult: 199, // CShopStageNew::sub_5382EA -> sub_58EBFE: [u8 result, 8B f64 LE vtime]
  StringTableIniStream: 200, // sub_4B95F7 -> sub_594136: stringtable.ini SmartStream
  ShopGiftResult: 201, // sub_58C8EA: [u8 result, u32 val1, u32 val2]
  StageSpecificRoute202: 202, // Shop result parser sub_547038 is used in multiple local Shop action contexts; do not infer one C->S association
  ShopUseOrEquipResult202: 202, // CShopDlg::sub_547038: [u8 result=2, u32 stockId, u32 unk=0]
  InventoryDeleteResult: 202,
  ShopGiftList: 203, // CStage case 203 -> sub_4B965F -> CUserInventoryMan::sub_5954D2: u8 playerCount, per-player u8 recordCount, records
  StageSpecificRoute204: 204, // CShopStageNew case 204 -> sub_53A6F1; local request associations are not proof of official response policy
  ShopEquipResult: 204, // CShopStageNew::sub_53A6F1: [u8 res, u32 count, 8B f64 LE vtime, items...]
  ShopCouponResult: 204,
  DynamicMapInfoSsdStream: 205, // sub_4E0131 -> sub_4DFE20: fxdynmapinfo.ssd SmartStream
  StageClearTreeStream: 206, // sub_5180A6: SmartStream [u16 LE count, count*(u32, u32, u32, str)]
  ChatStageRoute226: 226, // CChatStage::sub_4B0A63 -> sub_4A83B3; field mapping/meaning UNKNOWN
  ChatStageRoute227: 227, // CChatStage::sub_4B0A63 -> sub_4A7C9F; field mapping/meaning UNKNOWN
  ChatStageRoute228: 228, // CChatStage::sub_4B0A63 -> sub_4A7DA0; field mapping/meaning UNKNOWN
  DynamicMapAndStageConfig: 207, // sub_4BCABF -> sub_4E0207: [u8 flag, u32 fxdynmapinfoChecksum, ...]
  ShopConfigSync: 208, // CShopStageNew::sub_53660B / sub_5493B7
  PackageMapIniStream: 210, // sub_4B966A -> sub_59426D: packagemap.ini SmartStream
  CStageStockContainerUpdate211: 211, // CStage::sub_4BDBF5 -> sub_4B987B -> CStockContainer; field mapping/trigger UNKNOWN
  ShopResellResult: 212, // CShopDlg::sub_546D3F: [u8 res=0, str itemName, u32 stockId, u32 0, u32 refundLucci]
  NexonClubAuthResult: 213, // CStage::sub_4BDBF5 case 213 -> slot 60 (+0xF0) -> sub_4BC337: [u8 ok, u8 playerIdx, (if ok: str clubId)]
  ShopQMarkResult: 214, // CShopStageNew::sub_5396F0: [u32 type, u32 reward, u32 unk]
  ShopEventNotice: 215, // CShopConnectionMan::sub_52A129 ([u8(0)]) / CShopStageNew::sub_53C550
  MyPageData220: 220, // Client path `sub_5447F0` -> `sub_544049` -> `sub_49D0A6`; field meanings UNKNOWN
  MyPageData221: 221, // Client path `sub_54055D` -> `sub_53E0E5`; extends the S->C 220 record with 2 u32, meanings UNKNOWN
  MyPagePacket222: 222, // Client path `sub_54055D` -> `sub_53EC90`; reads one string, displayed meaning UNKNOWN
  StageSpecificRoute224: 224, // ShopStage reads a config/CRC record; CStage fallback case 224 -> sub_4B9918 reads no packet fields
  ShopConfigCrc224: 224, // ShopStage: [u8(1), u32 fxCrc, u32 strCrc, u32 pkgCrc, str url, u32 banners]; distinct from generic CStage fallback case 224 -> sub_4B9918
  StageSpecificRoute229: 229, // CChatStage::sub_4B0A63 -> sub_4A7F72 and CShopStageNew::sub_53AC96; stage-specific meaning/schema not equated
  ShopSaleModifiers: 229, // Descriptive alias for the ShopStage route only; do not apply its meaning to other stages
  ChatStageRoute230: 230, // CChatStage::sub_4B0A63 -> sub_4A8144; field mapping/meaning UNKNOWN
  ChatStageRoute233: 233, // CChatStage::sub_4B0A63 -> sub_4A8CBB; field mapping/meaning UNKNOWN
  ChatStageRoute234: 234, // CChatStage::sub_4B0A63 -> sub_4A84B5; field mapping/meaning UNKNOWN
  RoomPasswordChangeResult: 231, // sub_4D3FD6
  StageSlot62Route232: 232, // CStage::sub_4BDBF5 case 232 -> current root slot 62 (+0xF8) -> sub_4B9423: [u32 opaqueA, u32 opaqueB narrowed to char]; distinct from NexonClub route 213
  ItemLimitCounts: 237, // sub_4BA3ED: [u16 count, count*(u16 id, u16 a, u16 b, u16 c)]
  ShopStagePacket238: 238, // sub_53C550 -> sub_537B1C: str, u32, 8 raw bytes, then sub_58EBFE status/conditional tail; full schema UNKNOWN
  LobbyStageRoute239: 239, // CLobbyStage::sub_4C86A2 -> sub_4C12AD; payload semantics/schema not fully mapped
  StageSpecificRoute240: 240, // CStage fallback parses RankingTop3; CShopStageNew has a separate purchase-detail case 240
  RankingTop3: 240, // sub_4A522B: [u8 count(<=3), count*sub_4A4FBD]
  LobbyStageRoute241: 241, // CLobbyStage::sub_4C86A2 -> sub_4C5FB4; payload semantics/schema not fully mapped
  ShopPurchaseDetail: 240, // CShopStageNew::sub_53B7D3
  SmsSendResult: 242, // SMS path `CSmsDlg::sub_4838E8` reads u8; C->S 290 response path remains UNKNOWN (sub_544049 is S->C 220)
  SmsList: 243, // CSmsDlg::sub_484465: [u8 status=15, u8 count, msgs...]
  SmsDeleteResult: 244, // CSmsDlg::sub_47F653: [u8 res=1]
  SmsDeleteAllResult: 245, // CSmsDlg::sub_47F66A: [u8 res=1]
  SmsNewNotice: 246, // sub_5E3AC9 -> sub_5E369D: [u8 hasNewMail]
  UserQuestAndSlotInfo248: 248, // CStage::sub_4B9DB6
  ChatStageRoute249: 249, // CChatStage::sub_4B0A63 -> sub_4A743C; field mapping/meaning UNKNOWN
  CoupleInfoSync: 250, // CCouple::sub_5BBF91
  CoupleProposeIncoming: 251, // CCouple::sub_5BAA90 reads [u8 playerIdx, str proposer, str message, u8 grade]
  CoupleStatus252: 252, // CCouple::sub_5BBD3E reads [u8 playerIdx, u8 status, str, str, (if status==12: u8 grade)]; status/request association UNKNOWN
  CoupleStatus253: 253, // CCouple::sub_5BBAA7 reads [u8 playerIdx, u8 status, str]; status semantics UNKNOWN
  CoupleBreakupNotice: 254, // CCouple::sub_5BC155 reads one u8 playerIdx
  GachaponResult: 255, // CShopStageNew::sub_53BBD8 / CGachaponDlg::sub_5C23DB
  MyCharacterRank: 256, // sub_4B96F3 -> sub_4A527F: per player [u8 hasRank, (if hasRank: sub_4A4FBD, u32, u8)]
  GachaponResult257: 257, // sub_5C279C -> sub_5C23DB: [u8(0), u8 playerCount, per player items..., u32 lucci, str, str]
  BasketInfo258: 258, // sub_5C279C -> sub_5C261E: [u8 flag, u16 count, items..., str notice]
  BasketInfo: 259, // CBasketDlg::sub_5C0289 / sub_5C261E
  BasketCouponCounts: 260, // CBasketDlg::sub_5C0289
  StageSpecificRoute261: 261, // Shop connection/UserMarket permission paths; CLobbyStage also has a separate direct case 261
  ShopConnectionPermission: 261, // CShopConnectionMan::sub_52A129 / CUserMarketStage::sub_57224C; distinct Lobby route not equated
  UserMarketPermission: 262, // CShopConnectionMan::sub_52A129 reads the one-byte connection permission
  LobbyStageRoute263: 263, // CLobbyStage::sub_4C86A2 reads a u8 then a stream-like value; fields/meaning UNKNOWN
  ChatStageRoute264: 264, // CChatStage reads [u8, u8], then sub_4AC937 reads [str, u8]; field meanings UNKNOWN
  ChatStageRoute267: 267, // CChatStage::sub_4B0A63 reads a status u8 and conditionally a count/list; field meanings UNKNOWN
  UserMarketFeeInfo: 265, // CStage::sub_4BB408: [u32 feeRate, str notice, u32 minPrice] -> C->S 320
  InventoryExpansionSlots: 268, // CStage::sub_4B9E20 -> sub_5832DB
  UserMarketEnterResult: 269, // CStage::sub_4BC642: [u8 result] -> transitions to Stage 20 on success
  UserMarketMaxLucci: 270, // CUserMarketStage::sub_574380 -> sub_5725C0: [u32]
  UserMarketBalance: 271, // CUserMarketStage::sub_574380 -> sub_5725A4: [u32]
  UserMarketList: 272, // CUserMarketStage::sub_574380 -> sub_57226C -> sub_570D2A: [u16 count, count * entry]
  UserMarketRegisterResult: 273, // CUserMarketStage::sub_574380 -> sub_5734F0: [u16 result, u32 item field]
  UserMarketCancelResult274: 274, // CUserMarketStage::sub_574380 -> sub_5736F5: [u16 result, u32 item field]
  UserMarketMySalesList: 275, // CUserMarketStage::sub_574380 -> sub_57175A -> sub_570E5B: [u16 count, count * entry]
  UserMarketTransferResult: 276, // CUserMarketStage::sub_574380 -> sub_57388F: [u16 result, u32, u32]
  UserMarketPurchaseResult: 277, // CUserMarketStage::sub_574380 -> sub_573991: [u16 result, u32, u32, 8B f64 LE]
  StageSpecificRoute278: 278, // CUserMarketStage and CLobbyStage have direct receive routes; schema/meaning are not equated
  MarketExpiredReturns: 278, // CUserMarketStage::sub_574380 -> CShopStageNew::sub_539A17; not generalized to the Lobby case
  StageSpecificRoute279: 279, // CUserMarketStage and CLobbyStage have direct receive routes; schema/meaning are not equated
  MarketSoldNotifications: 279, // CUserMarketStage::sub_574380 -> CShopStageNew::sub_539C8B; not generalized to the Lobby case
  UserMarketTradeableItems: 280, // CUserMarketStage::sub_574380 -> sub_572277: [i32 count, count * u32]
  ChatStageRoute286: 286, // CChatStage::sub_4B0A63 -> sub_4A9B50; field mapping/meaning UNKNOWN
  ChatStageRoute287: 287, // CChatStage::sub_4B0A63 -> feature-gated CNexonClub dialog path; payload meaning/request association UNKNOWN
  ChatStageRoute288: 288, // CChatStage::sub_4B0A63 -> item-unlimited UI toggle path; payload meaning UNKNOWN
  SecurityChallenge1: 281, // CStage::sub_4BDBF5 -> sub_4B8F3F (sends C->S 332)
  SecurityChallenge2: 282, // CStage::sub_4BDBF5 -> sub_4BAD83
  SecurityChallenge3: 283, // CStage::sub_4BDBF5 -> sub_4BDA18
  SecurityChallenge4: 284, // CStage::sub_4BDBF5 -> sub_4BAE58 (sends C->S 333)
  EventStateUpdate: 289, // CStage::sub_4BDBF5 -> sub_55F830
} as const satisfies Record<string, number>;

export const ClientUdpOpcode = {
  GameLoadRegistration: 1, // `sub_4ED400`: u16 BE opcode in the 36-byte C->S registration
} as const satisfies Record<string, number>;

export const ServerUdpOpcode = {
  KeepaliveAck: 4, // Client `CUDPPeerManBase::sub_5EC943` recognizes one-byte type 4; server use is reconstructed
} as const satisfies Record<string, number>;

export const UdpPeerEnvelopeKind = {
  Control: 0, // one-byte peer envelope type; followed by a control code and peer index
  GameData: 1, // one-byte peer envelope type; followed by sender index and opaque game payload
} as const satisfies Record<string, number>;

export const ClientUdpPeerControlCode = {
  Probe: 0, // `CUDPPeerClient::sub_5EC195`: [0, 0, localPeerIdx]
  AlternateProbe: 1, // `CUDPPeerClient::sub_5EC1FF`: [0, 1, localPeerIdx]
} as const satisfies Record<string, number>;

export const ReconstructedUdpInputOpcode = {
  KeepaliveProbe: 0, // local-only `[u16 BE(0), u32 BE(userId)]` model; Client sender/cadence UNKNOWN
} as const satisfies Record<string, number>;

export const ReconstructedServerUdpPeerControlCode = {
  ProbeResponse: 1, // local server response choice; same value as the Client's alternate probe
} as const satisfies Record<string, number>;
