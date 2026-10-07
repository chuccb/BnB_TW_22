import type { StockEntry, UserRecord } from "../db/database.ts";
import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { ipv4ToBytes, PacketReader, PacketWriter, unixMsToVariantTime } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";
import { formatClientOpcode, formatStageId, logger } from "../utils/logger.ts";

function clonePacketReader(reader: PacketReader): PacketReader {
  const clone = new PacketReader(reader.plain, reader.degree);
  clone.offset = reader.offset;
  return clone;
}

/** Read a length-prefixed string only when its full declared body is present. */
function readCompleteString(reader: PacketReader): string | null {
  if (reader.remaining < 2) return null;
  const length = reader.peekU16();
  // Match the Client's CSendPacket string writer bound.
  if (length > 0x7fff || length > reader.remaining - 2) return null;
  return reader.readString();
}

/** Parse on a clone so malformed packets cannot partially advance the live reader or mutate state. */
function parseExactPayload<T>(
  reader: PacketReader,
  parse: (probe: PacketReader) => T | null
): T | null {
  const probe = clonePacketReader(reader);
  const value = parse(probe);
  if (value === null || probe.remaining !== 0) return null;
  reader.offset = probe.offset;
  return value;
}

function logRejectedShopPacket(
  session: ClientSession,
  opcode: number,
  payloadBytes: number,
  expectedSchema: string,
  reason: string
): void {
  logger.warn("Shop", reason, {
    direction: "C->S",
    wireOpcode: opcode,
    opcodeName: formatClientOpcode(opcode),
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    payloadBytes,
    expectedSchema,
    responseSent: false,
    databaseMutation: false,
  });
}

function logRejectedUserMarketPacket(
  session: ClientSession,
  opcode: number,
  payloadBytes: number,
  expectedSchema: string,
  reason: string
): void {
  logger.warn("UserMarket", reason, {
    direction: "C->S",
    wireOpcode: opcode,
    opcodeName: formatClientOpcode(opcode),
    sessionId: session.sessionId,
    connectionKind: session.connectionKind,
    stageId: formatStageId(session.stageId),
    payloadBytes,
    expectedSchema,
    responseSent: false,
    databaseMutation: false,
  });
}

function synchronizeSessionUserSnapshot(state: WorldState, updatedUser: UserRecord): void {
  for (const activeSession of state.sessions.values()) {
    for (let localIdx = 0; localIdx < activeSession.users.length; localIdx++) {
      if (activeSession.users[localIdx]?.id === updatedUser.id) {
        activeSession.users[localIdx] = updatedUser;
      }
    }
  }
}

function hasAuthenticatedGameContext(state: WorldState, session: ClientSession): boolean {
  return session.connectionKind === "game" &&
    session.channelSelected &&
    Number.isInteger(session.channelIndex) &&
    session.channelIndex >= 0 &&
    session.channelIndex < state.channels.length &&
    session.users.length >= 1 &&
    session.users.length <= 2;
}

function hasShopTransactionContext(state: WorldState, session: ClientSession): boolean {
  return hasAuthenticatedGameContext(state, session) && session.stageId === StageId.Shop;
}

function hasUserMarketTransactionContext(state: WorldState, session: ClientSession): boolean {
  return hasAuthenticatedGameContext(state, session) && session.stageId === StageId.UserMarket;
}

/** Record a Client-carried selector for the local market adapter; this is not a verified server identity rule. */
function selectUserMarketUser(session: ClientSession, localIdx: number): UserRecord | null {
  const user = session.users[localIdx];
  if (!user) return null;
  session.userMarketLocalIdx = localIdx;
  return user;
}

/**
 * Resolve the local market user for a packet with no selector byte. The only implicit fallback
 * is an unambiguous one-user session; a two-user session must have supplied a valid selector.
 */
function getSelectedUserMarketUser(
  session: ClientSession
): { localIdx: number; user: UserRecord } | null {
  const localIdx = session.userMarketLocalIdx ?? (session.users.length === 1 ? 0 : null);
  if (localIdx === null) return null;
  const user = session.users[localIdx];
  return user ? { localIdx, user } : null;
}

/**
 * Builds S->C 194 (`CUserInventoryMan::sub_595272` -> `sub_594ECF`) full inventory load
 * or S->C 188 (`CUserInventoryMan::sub_5953FE` -> `sub_594ECF`) inventory update:
 *   u8 playerCount
 *   For each local player:
 *     i32 itemCount
 *     For each item (`sub_594ECF` at `0x00594ECF`):
 *       u32 stockId (local builder maps SQLite `inventory.id`; official DB mapping UNKNOWN)
 *       u8 slotCategory (`equipped`)
 *       u32 quantity
 *       str customText
 *       8B f64 LE expireVariantTime (`sub_697640` + `VariantTimeToSystemTime`)
 *       u32 remainUnits
 *       u8 marketStatus
 */
export function buildInventoryPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number = ServerOpcode.InventoryData
): PacketWriter {
  const players = session.users.length > 0 ? session.users : [null];
  const w = new PacketWriter(opcode);
  w.writeU8(players.length);

  for (const user of players) {
    const stock = user ? state.db.getUserStock(user.id) : [];
    w.writeI32(stock.length);
    for (const item of stock) {
      w.writeU32(item.id); // Local per-row key; Client field is a lookup key, not proven to equal DB identity.
      w.writeU8(item.equipped & 0xff);
      w.writeU32(item.quantity);
      w.writeString(item.customText ?? "");
      w.writeVariantTime(unixMsToVariantTime(item.expireTs));
      w.writeU32(item.remainUnits ?? 30);
      w.writeU8(item.marketStatus ?? 0);
    }
  }
  return w;
}

/**
 * Builds S->C 196 (`CUserInventoryMan::sub_597040` at `0x00597040`):
 *   u8 playerCount
 *   For each local player:
 *     8 fixed avatar slots (0..7):
 *       u32 stockId (`0` = empty)
 *       str customText
 */
export function buildEquippedAvatarPacket196(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const players = session.users.length > 0 ? session.users : [null];
  const w196 = new PacketWriter(ServerOpcode.EquippedAvatarData);
  w196.writeU8(players.length);

  for (const user of players) {
    const equippedBySlot = new Map<number, StockEntry>();
    if (user) {
      for (const item of state.db.getUserStock(user.id)) {
        const slot = item.equipped - 1;
        if (slot >= 0 && slot < 8 && !equippedBySlot.has(slot)) {
          equippedBySlot.set(slot, item);
        }
      }
    }

    for (let slot = 0; slot < 8; slot++) {
      const match = equippedBySlot.get(slot);
      w196.writeU32(match?.id ?? 0); // Local stock lookup key: SQLite inventory row ID.
      w196.writeString(match?.customText ?? "");
    }
  }
  return w196;
}

/** Wire fields are named by their destination offsets in Client `UserItem`; meanings are unknown. */
export interface UserItemRecord {
  field0x08U32: number;
  field0x14U8: number;
  field0x20String: string;
  field0x38U32: number;
  field0x44U32: number;
  field0x50U32: number;
  field0x5cString: string;
  field0x74U16: number;
  field0x80U8: number;
  /** One additional u8 is read into UserItem+0x9c when feature 28 is enabled. */
  field0x9cU8?: number;
}

export type UserItemRecordsOpcode =
  | typeof ServerOpcode.UserItemsData
  | typeof ServerOpcode.UserItemsSyncLegacy;

export interface UserItemRecordsPacketOptions {
  opcode?: UserItemRecordsOpcode;
  feature28Enabled?: boolean;
}

/**
 * Builds the Client's UserItem-record stream handled by S->C 63 and 197:
 *   u16 count (`CStage::sub_4BDBF5` -> `sub_4B9654` -> `sub_598BEC`)
 *   For each record (`sub_597611` at `0x00597611`):
 *     u32 -> UserItem+0x08, u8 -> +0x14, str -> +0x20,
 *     u32 -> +0x38, u32 -> +0x44, u32 -> +0x50, str -> +0x5c,
 *     u16 -> +0x74, u8 -> +0x80, and (if feature 28) u8 -> +0x9c
 *
 * The Client code establishes widths and destination offsets, not application-level field meanings.
 * The current Taiwan feature set disables feature 28. A caller enabling it must provide each
 * record's additional byte; the builder does not invent a placeholder. No current server handler
 * sends this packet or establishes its trigger or official-server response policy.
 */
export function buildUserItemRecordsPacket(
  records: readonly UserItemRecord[] = [],
  options: UserItemRecordsPacketOptions = {}
): PacketWriter {
  const opcode = options.opcode ?? ServerOpcode.UserItemsData;
  const feature28Enabled = options.feature28Enabled ?? false;

  if (records.length > 0xffff) {
    throw new RangeError(`UserItem record count ${records.length} exceeds the u16 wire limit`);
  }

  const packet = new PacketWriter(opcode);
  packet.writeU16(records.length);
  for (const [index, record] of records.entries()) {
    packet.writeU32(record.field0x08U32);
    packet.writeU8(record.field0x14U8);
    packet.writeString(record.field0x20String);
    packet.writeU32(record.field0x38U32);
    packet.writeU32(record.field0x44U32);
    packet.writeU32(record.field0x50U32);
    packet.writeString(record.field0x5cString);
    packet.writeU16(record.field0x74U16);
    packet.writeU8(record.field0x80U8);

    if (feature28Enabled) {
      if (record.field0x9cU8 === undefined) {
        throw new Error(`UserItem record at index ${index} is missing its feature-28 byte`);
      }
      packet.writeU8(record.field0x9cU8);
    }
  }
  return packet;
}

/**
 * Builds the local reconstruction's S->C 203 packet for the Client receive path:
 * `CShopStageNew::sub_53C550` falls through to `CStage::sub_4BDBF5` case 203,
 * then `sub_4B965F` -> `CUserInventoryMan::sub_5954D2` (`0x005954D2`).
 * Wire fields read there:
 *   u8 playerCount
 *   For each player: u8 recordCount
 *   For each record: u8 type, u32 lookup value, u32 value, u8 flag, u16 value, str, str
 *
 * The field semantics/identity mapping and any official-server response policy are not
 * inferred here. `0x0058DFE6` is not the S->C 203 parser or a recovered function entry.
 */
export function buildGiftListPacket203(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const players = (session.users.length > 0 ? session.users : [null]).slice(0, 255);
  const w203 = new PacketWriter(ServerOpcode.ShopGiftList);
  w203.writeU8(players.length);

  for (const user of players) {
    const gifts = user ? state.db.getGiftsByUser(user.id) : [];
    w203.writeU8(Math.min(255, gifts.length));
    for (const g of gifts.slice(0, 255)) {
      w203.writeU8(200); // Local record-type fixture; parser branches on 200, business meaning UNKNOWN.
      w203.writeU32(g.itemId); // Local database value; Client lookup-key mapping is unverified.
      w203.writeU32(1); // Local quantity/value fixture.
      w203.writeU8(1); // Local flag fixture.
      w203.writeU16(30); // Local u16 fixture.
      w203.writeString(g.senderName);
      w203.writeString(g.message);
    }
  }
  return w203;
}

/**
 * Builds S->C 268 (`CStage::sub_4B9E20` -> `sub_597128` -> `sub_5832DB` at `0x005832DB`):
 *   u8 playerCount
 *   For each local player:
 *     i32 expansionCount (`0`)
 *     expansionCount * [u32 a, u32 b, u32 c]
 */
export function buildInventoryExpansionPacket268(session: ClientSession): PacketWriter {
  const count = Math.max(1, session.users.length);
  const w268 = new PacketWriter(ServerOpcode.InventoryExpansionSlots);
  w268.writeU8(count);
  for (let i = 0; i < count; i++) {
    w268.writeI32(0);
  }
  return w268;
}

/**
 * Builds S->C 198 (`CShopStageNew::sub_53885C` at `0x0053885C` / `CShopDlg::sub_546BE3` at `0x00546BE3`):
 *   u32 cashBalance (`sub_697580`)
 *   u8 statusFlag (`sub_6974B0`, `1` = success so `sub_53885C` does not retry `C->S 269`)
 */
export function buildCashBalancePacket198(session: ClientSession): PacketWriter {
  const user = session.users[0];
  const w198 = new PacketWriter(ServerOpcode.ShopCashBalance198);
  w198.writeU32(user?.cash ?? 0);
  w198.writeU8(1);
  return w198;
}

/**
 * Local reconstruction-only S->C 190 body emitted after Shop purchase success:
 *   u32 value (currently copied from `user.lucci`; Client field meaning/Shop receive path UNKNOWN)
 *
 * The inspected CGameStage case 190 calls `sub_4F054D` without reading packet fields;
 * this local Shop send is not evidence of official behavior or a matching Shop parser.
 */
export function buildShopLocalUpdatePacket190(session: ClientSession): PacketWriter {
  const user = session.users[0];
  const w190 = new PacketWriter(ServerOpcode.ShopLocalUpdate190);
  w190.writeU32(user?.lucci ?? 0);
  return w190;
}

/**
 * Builds S->C 48 (`CShopConnectionMan::sub_529E8D` at `0x00529E8D`):
 *   u8 ok (`1`)
 *   u8 flag (`0`)
 *   u32 opaqueField (this local builder currently writes `session.sessionKey`; the Client reads/discards it)
 *   u32 ipHostLong
 *   u16 portHostShort
 */
export function buildShopRedirectPacket48(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const ipBytes = ipv4ToBytes(state.config.publicIp);
  const ipHostLong =
    ((ipBytes[0]! << 24) | (ipBytes[1]! << 16) | (ipBytes[2]! << 8) | ipBytes[3]!) >>> 0;
  const w48 = new PacketWriter(ServerOpcode.ShopServerEndpoint);
  w48.writeU8(1);
  w48.writeU8(0);
  w48.writeU32(session.sessionKey >>> 0);
  w48.writeU32(ipHostLong);
  w48.writeU16(state.config.tcpPort);
  return w48;
}

/**
 * Builds S->C 198 stock list (retained for compatibility with existing callers/tests).
 */
export function buildUserStockPacket(state: WorldState, session: ClientSession): PacketWriter {
  const user = session.users[0];
  const stock = user ? state.db.getUserStock(user.id) : [];

  const w198 = new PacketWriter(ServerOpcode.ShopLocalStockList198);
  w198.writeU16(stock.length);
  for (const item of stock) {
    w198.writeU32(item.id);
    w198.writeU32(item.itemCode);
    w198.writeU16(item.quantity);
    w198.writeU32(item.expireTs);
    w198.writeU8(item.equipped);
  }
  return w198;
}

/**
 * Builds S->C 257 (`sub_5C279C` -> `CGachaponDlg::sub_5C23DB` at `0x005C23DB`):
 *   u8 resultCode (`0` = success)
 *   u8 playerCount
 *   For each local player:
 *     u32 itemCount (`1`)
 *     For each item:
 *       u32 itemId
 *       u16 count
 *       u16 validDays
 *       u32 bonusType
 *   u32 lucciReward
 *   str msg1
 *   str msg2
 */
export function buildGachaponResultPacket257(
  session: ClientSession,
  rewardStockId: number = 1005,
  lucciReward: number = 0
): PacketWriter {
  const playerCount = Math.max(1, session.users.length);
  const w257 = new PacketWriter(ServerOpcode.GachaponResult257);
  w257.writeU8(0); // 0 = success (`sub_5C23DB`)
  w257.writeU8(playerCount);
  for (let i = 0; i < playerCount; i++) {
    w257.writeU32(1); // 1 prize item
    w257.writeU32(rewardStockId);
    w257.writeU16(1); // quantity
    w257.writeU16(30); // validDays
    w257.writeU32(0); // bonusType
  }
  w257.writeU32(lucciReward);
  w257.writeString("Gachapon Prize");
  w257.writeString("");
  return w257;
}

/**
 * Builds S->C 258 (`sub_5C279C` -> `CBasketDlg::sub_5C261E` at `0x005C261E`):
 *   u8 flag (`1`)
 *   u16 count
 *   For each item:
 *     u32 itemId
 *     u32 originalPrice
 *     u32 discountPrice
 *   str notice
 */
export function buildBasketInfoPacket258(): PacketWriter {
  const w258 = new PacketWriter(ServerOpcode.BasketInfo258);
  w258.writeU8(1);
  w258.writeU16(1);
  w258.writeU32(1001);
  w258.writeU32(1000);
  w258.writeU32(500);
  w258.writeString("Basket Special Offer");
  return w258;
}

/**
 * Builds S->C 259 (`sub_5C279C` -> `CBasketDlg::sub_5C0289` at `0x005C0289`):
 *   u8 playerCount
 *   For each local player:
 *     u16 basketCouponCount
 *     u16 gachaponCouponCount
 */
export function buildBasketCouponCountsPacket259(
  session: ClientSession,
  basketCoupons: number = 1,
  gachaponCoupons: number = 1
): PacketWriter {
  const playerCount = Math.max(1, session.users.length);
  const w259 = new PacketWriter(ServerOpcode.BasketInfo);
  w259.writeU8(playerCount);
  for (let i = 0; i < playerCount; i++) {
    w259.writeU16(basketCoupons);
    w259.writeU16(gachaponCoupons);
  }
  return w259;
}

/**
 * Builds S->C 265 (`CStage::sub_4BB408` at `0x004BB408`):
 *   u32 feeRate
 *   str notice
 *   u32 minPrice
 */
/**
 * Builds the client-confirmed S->C 265 schema. Default values are local reconstruction
 * fixtures, not verified production Taiwan market rates or minimum-price policy.
 */
export function buildUserMarketFeeInfoPacket265(
  feeRate: number = 5,
  notice: string = "",
  minPrice: number = 100
): PacketWriter {
  const w265 = new PacketWriter(ServerOpcode.UserMarketFeeInfo);
  w265.writeU32(feeRate);
  w265.writeString(notice);
  w265.writeU32(minPrice);
  return w265;
}

/**
 * Builds S->C 272 using the verified Client receive route
 * `CUserMarketStage::sub_574380 -> sub_57226C -> sub_570D2A`:
 *   u16 count
 *   count * [u32 field0, u32 field1, str field2, u32 field3, u16 field4]
 *
 * The widths/order are client-source-confirmed. Mapping the local demo listing fields
 * onto these wire fields is reconstruction behavior, not official market data semantics.
 */
export function buildMarketListPacket272(
  state: WorldState,
  searchQuery: string = ""
): PacketWriter {
  const listings = state.db.getActiveMarketListings(searchQuery);
  const w272 = new PacketWriter(ServerOpcode.UserMarketList);
  w272.writeU16(listings.length);
  for (const item of listings) {
    w272.writeU32(item.id);
    w272.writeU32(item.itemCode);
    w272.writeString(item.sellerName);
    w272.writeU32(item.price);
    w272.writeU16(24);
  }
  return w272;
}

/**
 * Builds S->C 275 using the verified Client receive route
 * `CUserMarketStage::sub_574380 -> sub_57175A -> sub_570E5B`:
 *   u16 count
 *   count * [u32 field0, u32 field1, str field2, u32 field3, u16 field4]
 *
 * The widths/order are client-source-confirmed. Mapping the local demo listing fields
 * onto these wire fields is reconstruction behavior, not official market data semantics.
 */
export function buildMarketMySalesPacket275(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const selection = getSelectedUserMarketUser(session);
  const listings = selection ? state.db.getMarketListingsBySeller(selection.user.id) : [];
  const w275 = new PacketWriter(ServerOpcode.UserMarketMySalesList);
  w275.writeU16(listings.length);
  for (const item of listings) {
    w275.writeU32(item.id);
    w275.writeU32(item.itemCode);
    w275.writeString(item.sellerName);
    w275.writeU32(item.price);
    w275.writeU16(24);
  }
  return w275;
}

/**
 * Builds S->C 16 (`CStage::sub_4BDBF5` case `16` -> `sub_4BB82A` at `0x004BB82A`):
 *   u8 localPlayerIdx (`sub_6974B0`)
 *   u8 flag2 (`sub_6974B0`)
 *   u32 cashOrAttr1 (`sub_697580`)
 *   u32 lucciOrAttr2 (`sub_697580`)
 *   u32 fxstockChecksum (`sub_594353` -> if mismatch, client sends `C->S 276`)
 *   u32 stringtableChecksum (`sub_59449A` -> if mismatch, client sends `C->S 278`)
 *   u32 packagemapChecksum (`sub_5943FB` -> if mismatch, client sends `C->S 281`)
 *   str noticeUrl (`sub_698270`)
 *   if feature 23 enabled (`sub_5CEA88(23) != 0`):
 *     u8 hasQmarkStream (+ `[CISmartStream qmarksfn.ssd]` via `sub_5B988A`)
 *   u32 bannerCount (`sub_5935DC`)
 *   bannerCount * [u8 idx, u32 val, str text]
 *   Transitions client to Stage 14 (`CShopStageNew`).
 */
export function buildShopInitPacket16(
  state: WorldState,
  session: ClientSession,
  sendQmarkStream: boolean = false
): PacketWriter {
  const user = session.users[0];
  const { fxstock, stringtable, packagemap, qmarksfn } = state.resources.ssdFiles;

  const w16 = new PacketWriter(ServerOpcode.ShopInitAndStage14);
  w16.writeU8(0); // localPlayerIdx = 0
  w16.writeU8(0); // flag2 = 0
  w16.writeU32(user?.cash ?? 0);
  w16.writeU32(user?.lucci ?? 0);
  w16.writeU32(fxstock.adler32Zero);
  w16.writeU32(stringtable.adler32Zero);
  w16.writeU32(packagemap.adler32Zero);
  w16.writeString(state.config.noticeUrl);

  if (state.config.enabledFeatures.has(23) || sendQmarkStream) {
    if (!sendQmarkStream) {
      w16.writeU8(0);
    } else {
      w16.writeU8(1);
      const ss = new SmartStreamWriter();
      ss.writeRaw(qmarksfn.decompressed);
      w16.writeSmartStream(ss, true);
    }
  }

  // sub_5935DC (0x005935DC): bannerCount = 0
  w16.writeU32(0);
  return w16;
}

/**
 * Builds the minimal S->C 213 (`CStage::sub_4BDBF5` case `213` -> root slot 60):
 *   u8 ok (`0`)
 *   u8 playerIdx (`0`)
 *
 * Client-verified effect: in CShopStageNew the case-213 slot is overridden by
 * `CShopStageNew::sub_536555` (`0x00536555`), which parses `[u8 ok, u8 playerIdx,
 * (if ok: str clubId)]` via `CStage::sub_4BC337` and then unconditionally writes
 * `C->S 269 [u8(1)]` (ShopEnter) through `sub_5AA68F`. That C->S 269 [u8(1)] is the
 * only non-retry writer that asks the server for the Shop-stage data bundle
 * (S->C 198 cash + config/stock sync). `ok = 0` skips the optional clubId field and
 * the `NXClubHasChanged` modal in `sub_4BC337`, so the packet has no UI side effects.
 *
 * Triggering C->S 269 with this packet is local reconstruction policy: the exact
 * official server sequence that follows Shop entry is not recovered from a trace,
 * but the Client's parse/send chain above is binary-verified.
 */
export function buildShopEnterTriggerPacket213(): PacketWriter {
  const w213 = new PacketWriter(ServerOpcode.NexonClubAuthResult);
  w213.writeU8(0); // ok = 0: no clubId field, no NXClubHasChanged modal
  w213.writeU8(0); // playerIdx = 0 (unused while ok = 0)
  return w213;
}

/**
 * Builds S->C 208 or S->C 224 (`sub_53660B` / `sub_5493B7` -> `sub_546C6B` at `0x00546C6B`):
 *   u8 status (1)
 *   u32 fxstockChecksum (`sub_594353`)
 *   u32 stringtableChecksum (`sub_59449A`)
 *   u32 packagemapChecksum (`sub_5943FB`)
 *   str noticeUrl (`sub_698270`)
 *   if feature 23 enabled (`sub_5CEA88(23) != 0`):
 *     u8 hasQmarkStream (+ `[CISmartStream qmarksfn.ssd]` via `sub_5B988A`)
 *   u32 bannerCount (`sub_5935DC`)
 */
export function buildShopConfigPacket208(
  state: WorldState,
  sendQmarkStream: boolean = false,
  opcode: number = ServerOpcode.ShopConfigSync
): PacketWriter {
  const { fxstock, stringtable, packagemap, qmarksfn } = state.resources.ssdFiles;

  const w = new PacketWriter(opcode);
  w.writeU8(1); // status == 1 (`sub_5493B7`)
  w.writeU32(fxstock.adler32Zero);
  w.writeU32(stringtable.adler32Zero);
  w.writeU32(packagemap.adler32Zero);
  w.writeString(state.config.noticeUrl);

  if (state.config.enabledFeatures.has(23) || sendQmarkStream) {
    if (!sendQmarkStream) {
      w.writeU8(0);
    } else {
      w.writeU8(1);
      const ss = new SmartStreamWriter();
      ss.writeRaw(qmarksfn.decompressed);
      w.writeSmartStream(ss, true);
    }
  }

  w.writeU32(0); // bannerCount = 0 (`sub_5935DC`)
  return w;
}

/**
 * Builds S->C 224 (`sub_549E03` -> `sub_5493B7` -> `sub_546C6B`).
 */
export function buildShopConfigCrcPacket224(
  state: WorldState,
  sendQmarkStream: boolean = false
): PacketWriter {
  return buildShopConfigPacket208(state, sendQmarkStream, ServerOpcode.ShopConfigCrc224);
}

/**
 * Builds S->C 193 (`sub_4B95B0` -> `sub_593FF6`: `[CISmartStream fxstock.ini]`),
 * S->C 200 (`sub_4B95F7` -> `sub_594136`: `[CISmartStream stringtable.ini]`), or
 * S->C 210 (`sub_4B966A` -> `sub_59426D`: `[CISmartStream packagemap.ini]`).
 */
export function buildIniSmartStreamPacket(
  state: WorldState,
  responseOpcode:
    | typeof ServerOpcode.FxStockIniStream
    | typeof ServerOpcode.StringTableIniStream
    | typeof ServerOpcode.PackageMapIniStream,
  filename: "fxstock.ini" | "stringtable.ini" | "packagemap.ini"
): PacketWriter {
  const entry = state.resources.ssdFiles.get(filename)!;
  const w = new PacketWriter(responseOpcode);
  const ss = new SmartStreamWriter();
  ss.writeRaw(entry.decompressed);
  w.writeSmartStream(ss, true);
  return w;
}

/**
 * Handles Shop / Inventory / UserMarket / Gachapon / Basket / `.ini` stream opcodes
 * (`CShopConnectionMan` `0x00529CC1`, `CShopStageNew` `0x0053C550`, `CShopDlg` `0x00549E03`,
 * `CUserInventoryMan` `0x00594ECF`, `CUserMarketStage` `0x00574380`).
 */
export function handleShopPacket(
  state: WorldState,
  session: ClientSession,
  opcode: number,
  reader: PacketReader
): void {
  const user = session.users[0];

  switch (opcode) {
    case ClientOpcode.RequestShopConnection:
    case ClientOpcode.RequestShopConnectionAlt: {
      // `sub_529AFB` sets CShopConnectionMan byte-12 state 2 before writing C->S 316/37;
      // `sub_52A129` then consumes state 2 to emit the C->S 38 Shop follow-up. Mirror that
      // one-shot pending latch locally so the C->S 38 reply policy can require it.
      session.shopConnectionPending = true;
      const w261 = new PacketWriter(ServerOpcode.ShopConnectionPermission);
      w261.writeU8(1); // 1 = allowed
      session.sendPacket(w261);

      const redirectPacket = buildShopRedirectPacket48(state, session);
      logger.info("Shop", "Advertising Client redirect endpoint in S->C 48", {
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        requestOpcode: opcode,
        stageId: formatStageId(session.stageId),
        targetAddress: state.config.publicIp,
        targetPort: state.config.tcpPort,
        targetListener: "LoginServer TCP_PORT",
      });
      session.sendPacket(redirectPacket);
      break;
    }

    case ClientOpcode.ShopConnectionFollowUp38: {
      // CShopConnectionMan::sub_529D8E writes a dynamic body on its socket-manager path after
      // `sub_52A129` consumes the CShopConnectionMan pending state established by C->S 316/37.
      // Client-verified context: mode 2 is the Lobby Shop-button caller (`sub_4BAACB`), and
      // mode 2 additionally emits the empty C->S 318 on the same path. The field95 values are
      // credential-like (LoginResult session-token source) but the server-side validation rule
      // for them is not recovered, so they are never treated as proof of identity here.
      const payloadBytes = reader.remaining;
      const parsedFollowUp = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 2) return null;
        const mode = probe.readU8();
        const localPlayerCount = probe.readU8();
        // This Client keeps at most two local users; a larger count cannot be produced by the
        // recovered session model and is rejected before iterating attacker-controlled records.
        if (localPlayerCount > 2) return null;
        for (let index = 0; index < localPlayerCount; index++) {
          if (readCompleteString(probe) === null || probe.remaining < 4) return null;
          probe.readU32(); // Client field95 (LoginResult session-token source); semantics are not validated here.
        }
        if (probe.remaining !== 5) return null;
        probe.readU8(); // trailing Client field; business meaning UNKNOWN
        probe.readU32(); // trailing Client field; business meaning UNKNOWN
        return { mode, localPlayerCount };
      });
      const expectedSchema =
        "u8 mode, u8 localUserCount (0..2), count * (str userIdentifier, u32 field95), u8 fieldA, u32 fieldB";
      if (!parsedFollowUp) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored malformed or non-exact C->S 38 Shop follow-up candidate"
        );
        break;
      }

      // Shop-entry reply policy (local reconstruction; the official server's exact response
      // sequence is not recovered). Client-verified pieces:
      //   - S->C 16 is read by `sub_4BB82A`, which transitions the UI to Stage 14 (CShopStageNew)
      //     via `sub_437FB8(..., 14)` and sets CShopConnectionMan state 1 (`sub_529A84`).
      //   - S->C 213 in the Shop stage is read by `CShopStageNew::sub_536555`, which then
      //     unconditionally emits C->S 269 [u8(1)] (ShopEnter) - see buildShopEnterTriggerPacket213.
      //   - The existing C->S 269 handler below completes the entry with S->C 198 + config sync.
      // Only a Lobby/Shop session that issued the preceding C->S 316/37 (pending latch) enters;
      // room-stage callers are served by the C->S 98 [u8(1)] room-context policy instead, and
      // unauthenticated or unprompted C->S 38 bodies stay observation-only.
      const canEnterShop =
        parsedFollowUp.mode === 2 &&
        session.shopConnectionPending &&
        hasAuthenticatedGameContext(state, session) &&
        (session.stageId === StageId.Lobby || session.stageId === StageId.Shop);
      if (canEnterShop) {
        session.shopConnectionPending = false;
        session.shopEnterReplyPending = true;
        session.stageId = StageId.Shop;
        session.sendPacket(buildShopInitPacket16(state, session));
        session.sendPacket(buildShopEnterTriggerPacket213());
        logger.info("Shop", "Local Shop-entry policy applied to C->S 38 (S->C 16 + S->C 213 trigger)", {
          direction: "C->S",
          wireOpcode: opcode,
          opcodeName: formatClientOpcode(opcode),
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          mode: parsedFollowUp.mode,
          localUserCount: parsedFollowUp.localPlayerCount,
          credentialLikeFieldsLogged: false,
          authenticationValidated: false,
          responseSent: true,
          responses: ["ShopInitAndStage14", "NexonClubAuthResult (C->S 269 trigger)"],
          stageChanged: true,
          databaseMutation: false,
          policyNote:
            "S->C 16 Stage-14 transition and S->C 213 -> C->S 269 chain are Client-verified; the pairing with C->S 38 is local reconstruction policy",
        });
        break;
      }

      logger.info("PacketAudit", "Observed exact C->S 38 Client writer; authentication and socket/session association remain UNKNOWN", {
        direction: "C->S",
        wireOpcode: opcode,
        opcodeName: formatClientOpcode(opcode),
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        mode: parsedFollowUp.mode,
        localUserCount: parsedFollowUp.localPlayerCount,
        shopConnectionPending: session.shopConnectionPending,
        credentialLikeFieldsLogged: false,
        authenticationValidated: false,
        responseSent: false,
        stageChanged: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.StageAction323: {
      // The Client writer is gated and emits two u8 fields, but neither their semantics nor
      // an S->C response association is established. Observe without changing stage or replying.
      const payloadBytes = reader.remaining;
      reader.offset = reader.plain.length;
      logger.info("PacketAudit", "Observed C->S 323; Client writer is gated and server response policy is UNKNOWN", {
        direction: "C->S",
        wireOpcode: ClientOpcode.StageAction323,
        opcodeName: formatClientOpcode(ClientOpcode.StageAction323),
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        payloadSchema: "two u8 fields in the recovered writer; field meanings UNKNOWN",
        semanticRole: "UNKNOWN",
        responseAssociation: "UNKNOWN",
        responseSent: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.ShopEnter: {
      // C->S 269 has distinct `u8 mode` writers for Shop entry and cash query.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 1 || !hasAuthenticatedGameContext(state, session)) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          "authenticated selected-channel Game session; exactly u8 mode in {0,1}",
          "Ignored malformed or unauthenticated C->S 269 Shop-entry/cash-query request"
        );
        break;
      }
      const mode = reader.readU8();
      if (mode !== 0 && mode !== 1) {
        logRejectedShopPacket(session, opcode, payloadBytes, "exactly u8 mode in {0,1}", "Ignored invalid C->S 269 mode");
        break;
      }
      if (
        session.stageId !== StageId.Lobby &&
        session.stageId !== StageId.Shop &&
        session.stageId !== StageId.UserMarket
      ) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          "Lobby, Shop, or UserMarket stage with a selected channel",
          "Ignored C->S 269 outside its local Shop control contexts"
        );
        break;
      }
      session.sendPacket(buildCashBalancePacket198(session));
      if (mode === 1) {
        session.stageId = StageId.Shop;
        session.sendPacket(buildShopConfigPacket208(state));
        session.sendPacket(buildShopConfigCrcPacket224(state));
        session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryData));
        session.sendPacket(buildEquippedAvatarPacket196(state, session));
        session.sendPacket(buildGiftListPacket203(state, session));
      }
      break;
    }

    case ClientOpcode.ShopBuyItem:
    case ClientOpcode.ShopBuyItemPass: {
      // C->S 270 is exactly two u32 values; C->S 309 prefixes the same pair with a string.
      // The first Client value is copied from selected-object +8; only its local itemCode mapping
      // is used below. The second field and Nexon Pass meaning/validation are UNKNOWN.
      const payloadBytes = reader.remaining;
      const parsedPurchase = parseExactPayload(reader, (probe) => {
        if (opcode === ClientOpcode.ShopBuyItemPass && readCompleteString(probe) === null) return null;
        if (probe.remaining !== 8) return null;
        const itemKey = probe.readU32();
        const opaqueRequestValue = probe.readU32();
        return { itemKey, opaqueRequestValue };
      });
      const expectedSchema = opcode === ClientOpcode.ShopBuyItemPass
        ? "str nexonPass, u32 selected-object field, u32 opaque field (exact)"
        : "u32 selected-object field, u32 opaque field (exact)";
      if (!parsedPurchase) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored malformed or non-exact Shop purchase body");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored Shop purchase outside an authenticated Shop-stage context");
        break;
      }
      const { itemKey } = parsedPurchase;
      void parsedPurchase.opaqueRequestValue;

      const price = 100; // Local demo economy only; not a recovered Taiwan shop price.
      const updatedUser = user ? state.db.purchaseStockItem(user.id, itemKey, price) : null;
      const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
      if (!updatedUser) {
        w199.writeU8(1); // Client treats result 1 as a purchase error; no more fields are read.
        session.sendPacket(w199);
        break;
      }

      user!.lucci = updatedUser.lucci;
      user!.cash = updatedUser.cash;
      w199.writeU8(0); // 0 = purchase success (`sub_58EBFE`)
      w199.writeVariantTime();
      session.sendPacket(w199);

      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      session.sendPacket(buildCashBalancePacket198(session));
      session.sendPacket(buildShopLocalUpdatePacket190(session));
      break;
    }

    case ClientOpcode.InventoryDeleteItem: {
      // C->S 271 (`sub_58013E`): resolved stock-container u32, optional feature-26 string,
      // then caller-supplied u32. Taiwan feature 26 is disabled; the second value is opaque.
      const payloadBytes = reader.remaining;
      const parsedDelete = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 4) return null;
        const stockId = probe.readU32();
        if (state.config.enabledFeatures.has(26) && readCompleteString(probe) === null) return null;
        if (probe.remaining !== 4) return null;
        const opaqueClientValue = probe.readU32();
        return { stockId, opaqueClientValue };
      });
      const expectedSchema = state.config.enabledFeatures.has(26)
        ? "u32 stockId, str feature-26 field, u32 opaque field (exact)"
        : "u32 stockId, u32 opaque field (exact; Taiwan feature 26 disabled)";
      if (!parsedDelete) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored malformed or non-exact C->S 271 inventory-delete body");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 271 outside an authenticated Shop-stage context");
        break;
      }
      void parsedDelete.opaqueClientValue;
      const stockOwned = state.db.getUserStock(user!.id).some((item) => item.id === parsedDelete.stockId);
      if (parsedDelete.stockId === 0 || !stockOwned || state.db.deleteStockItemById(user!.id, parsedDelete.stockId) !== 1) {
        logger.info("PacketAudit", "Ignored C->S 271 whose local stock-row mapping did not resolve to owned inventory", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          connectionKind: session.connectionKind,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          responseAssociation: "UNKNOWN for an unresolved local inventory key",
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      const w202 = new PacketWriter(ServerOpcode.InventoryDeleteResult);
      w202.writeU8(2); // local success mapping; Client case 2 consumes the following fields
      w202.writeU32(parsedDelete.stockId);
      w202.writeU32(0); // local remainCount fixture
      session.sendPacket(w202);
      break;
    }

    case ClientOpcode.InventoryEquipSync: {
      const payloadBytes = reader.remaining;
      const parsedSync = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 4) return null;
        const mode = probe.readU8();
        const playerIdx = probe.readU8();
        const count = probe.readU16();
        const suffixBytes = mode === 1 || mode === 4 ? 2 : 0;
        if (probe.remaining !== count * 5 + suffixBytes) return null;

        const rows: Array<{ slotField: number; stockId: number }> = [];
        for (let index = 0; index < count; index++) {
          const slotField = probe.readU8();
          const stockId = probe.readU32();
          // `sub_5816F4` emits only nonzero inventory objects with an active flag.
          if (stockId === 0) return null;
          rows.push({ slotField, stockId });
        }

        const suffix = suffixBytes > 0 ? [probe.readU8(), probe.readU8()] as const : null;
        return { mode, playerIdx, rows, suffix };
      });
      const expectedSchema =
        "u8 mode, u8 localPlayerIdx, u16 count, count * (u8 field, u32 stockId), modes 1/4: u8, u8";

      if (!parsedSync) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored malformed or non-exact C->S 273 inventory-sync body"
        );
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored C->S 273 outside an authenticated Shop-stage context"
        );
        break;
      }
      if (parsedSync.mode !== 0 && parsedSync.mode !== 1 && parsedSync.mode !== 2 && parsedSync.mode !== 4) {
        logger.warn("Shop", "Observed C->S 273 mode with no recovered Client writer context", {
          sessionId: session.sessionId,
          mode: parsedSync.mode,
          playerIdx: parsedSync.playerIdx,
          rowCount: parsedSync.rows.length,
          payloadBytes,
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }

      const targetUser = session.users[parsedSync.playerIdx];
      if (!targetUser) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored C->S 273 with a local-player index not present in this session"
        );
        break;
      }

      // The Client writes four observed modes (0, 1, 2, 4); modes 1 and 4 append two u8s.
      // Mode meanings, slot-field semantics, wire-ID-to-official-DB mapping, and any official
      // reply are UNKNOWN. This reconstruction maps stockId to inventory.id and the opaque
      // slot field directly (zero maps to local slot 1) as a local adapter policy only.
      const applied = state.db.setStockEquippedBatchByIds(
        targetUser.id,
        parsedSync.rows.map(({ slotField, stockId }) => ({
          stockId,
          equipped: slotField > 0 ? slotField : 1,
        }))
      );
      if (!applied) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored C->S 273 containing an unowned or locally market-reserved stock ID"
        );
        break;
      }

      // Local reconstruction output only; no official S->C 196 association is established.
      session.sendPacket(buildEquippedAvatarPacket196(state, session));
      break;
    }

    case ClientOpcode.ShopUseOrEquip274: {
      const payloadBytes = reader.remaining;
      const parsedEquip = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 8) return null;
        const playerIdx = probe.readU8();
        const slotIdx = probe.readU8();
        const stockId = probe.readU32();
        const customText = readCompleteString(probe);
        if (customText === null) return null;
        return { playerIdx, slotIdx, stockId, customText };
      });
      const expectedSchema = "u8 playerIdx, u8 slotIdx, u32 stockId, str customText";
      if (!parsedEquip) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored malformed C->S 274 equip/custom-text request");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 274 outside an authenticated Shop stage");
        break;
      }
      const targetUser = session.users[parsedEquip.playerIdx];
      if (
        !targetUser ||
        parsedEquip.slotIdx >= 8 ||
        parsedEquip.stockId === 0 ||
        !state.db.getUserStock(targetUser.id).some((item) => item.id === parsedEquip.stockId)
      ) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 274 with an invalid local-player/slot or unowned stock ID");
        break;
      }

      // Empty text is a valid length-prefixed value and clears the saved custom text.
      // Equip-slot reassignment and text update share one local DB transaction. `stockId` is
      // mapped to this local inventory row ID only; no official Server/DB mapping is claimed.
      if (
        !state.db.setStockEquippedById(
          targetUser.id,
          parsedEquip.stockId,
          parsedEquip.slotIdx + 1,
          parsedEquip.customText
        )
      ) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 274 stock ID that is unowned or locally market-reserved");
        break;
      }
      session.sendPacket(buildEquippedAvatarPacket196(state, session));
      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      break;
    }

    case ClientOpcode.ShopInventoryTab275: {
      const payloadBytes = reader.remaining;
      const parsedTextUpdates = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 2) return null;
        const playerIdx = probe.readU8();
        const count = probe.readU8();
        if (count > 24) return null; // `sub_48ED44` scans exactly 24 candidate slots.
        if (playerIdx >= session.users.length) return null;
        const updates: Array<{ stockId: number; text: string }> = [];
        for (let index = 0; index < count; index++) {
          if (probe.remaining < 6) return null;
          const stockId = probe.readU32();
          const text = readCompleteString(probe);
          if (text === null) return null;
          updates.push({ stockId, text });
        }
        return { playerIdx, updates };
      });
      const expectedSchema = "u8 playerIdx, u8 count (0..24), count * (u32 stockId, str customText)";
      if (!parsedTextUpdates) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored malformed C->S 275 inventory text-update request");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 275 outside an authenticated Shop stage");
        break;
      }
      const targetUser = session.users[parsedTextUpdates.playerIdx]!;
      const ownedStockIds = new Set(state.db.getUserStock(targetUser.id).map((item) => item.id));
      if (parsedTextUpdates.updates.some(({ stockId }) => stockId === 0 || !ownedStockIds.has(stockId))) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 275 containing an item not owned by the selected local user");
        break;
      }
      const updated = state.db.updateStockCustomTextsByIds(
        targetUser.id,
        parsedTextUpdates.updates.map(({ stockId, text }) => ({ stockId, customText: text }))
      );
      if (!updated) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          expectedSchema,
          "Ignored C->S 275 referencing stock reserved by an active local market listing"
        );
        break;
      }
      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      session.sendPacket(buildEquippedAvatarPacket196(state, session));
      break;
    }

    case ClientOpcode.ShopBillingCheck: {
      // C->S 277's recovered writer is empty. Its local S->C 201 response remains a policy choice.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 0 || !hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          "authenticated selected-channel Shop-stage session; empty body",
          "Ignored malformed or out-of-context C->S 277 billing-check request"
        );
        break;
      }
      const w201 = new PacketWriter(ServerOpcode.ShopGiftResult);
      w201.writeU8(1);
      w201.writeU32(user?.cash ?? 0);
      w201.writeU32(user?.lucci ?? 0);
      session.sendPacket(w201);
      break;
    }

    case ClientOpcode.ShopSendGift: {
      // C->S 279 (`sub_52C5A2`): exact [u32 packageId, str receiver, str title, str message, u8 flag].
      // The local S->C 199/203 sends below are reconstruction behavior, not official response policy.
      const payloadBytes = reader.remaining;
      const parsedGift = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 4) return null;
        const packageId = probe.readU32();
        const receiverName = readCompleteString(probe);
        if (receiverName === null) return null;
        const title = readCompleteString(probe);
        if (title === null) return null;
        const message = readCompleteString(probe);
        if (message === null || probe.remaining !== 1) return null;
        const callerSuppliedFlag = probe.readU8();
        return { packageId, receiverName, title, message, callerSuppliedFlag };
      });
      const expectedSchema = "u32 packageId, str receiverName, str title, str message, u8 opaque flag (exact)";
      if (!parsedGift) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored malformed or non-exact C->S 279 gift body");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, expectedSchema, "Ignored C->S 279 outside an authenticated Shop-stage context");
        break;
      }
      const { packageId, receiverName, title, message, callerSuppliedFlag } = parsedGift;
      void callerSuppliedFlag; // Current Client writer includes this byte; its meaning is unverified.
      const senderName = user!.username;

      if (receiverName) {
        const receiver = state.db.getUserByUsername(receiverName);
        if (receiver) {
          state.db.createGiftAndStockItem(receiver.id, senderName, packageId, packageId, title, message);
          const receiverSession = state.findSessionByUsername(receiverName);
          if (receiverSession) {
            receiverSession.sendPacket(buildGiftListPacket203(state, receiverSession));
          }
        }
      }

      const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
      w199.writeU8(0); // 0 = gift purchase success (`sub_58EBFE`)
      w199.writeVariantTime();
      session.sendPacket(w199);
      break;
    }

    case ClientOpcode.ShopCouponRequest280: {
      // Client `CShopCouponDlg::sub_492CD9` / `sub_492E5C` writes `[str couponCode, str targetUser]`.
      // The repo has no trusted coupon catalog/backend. Do not grant a fixed reward or reinterpret
      // an unverified compact body as a purchase; consume and observe without logging either string.
      const payloadBytes = reader.remaining;
      let couponCode = "";
      let targetUsername = "";
      let parsedCouponRequest = false;

      if (reader.remaining >= 4) {
        const codeLength = reader.peekU16();
        if (codeLength > 0 && codeLength + 2 <= reader.remaining) {
          couponCode = reader.readString();
          if (reader.remaining >= 2) {
            const targetLength = reader.peekU16();
            if (targetLength + 2 === reader.remaining) {
              targetUsername = reader.readString();
              parsedCouponRequest = couponCode.length > 0 && reader.remaining === 0;
            }
          }
        }
      }
      reader.readBlock(reader.remaining);

      logger.warn(
        "Shop",
        parsedCouponRequest
          ? "Observed C->S 280; coupon validation is unavailable"
          : "Ignored malformed or unsupported C->S 280 body",
        {
          sessionId: session.sessionId,
          payloadBytes,
          couponCodePresent: couponCode.length > 0,
          targetUserProvided: targetUsername.length > 0,
          responseSent: false,
          databaseMutation: false,
        }
      );
      break;
    }

    case ClientOpcode.ShopResellItem: {
      // C->S 283 (`sub_58BFE0`): selected-object `+8` u32, then a caller-supplied u32.
      // Neither field's database identity is established. This local fixture maps the first
      // value to inventory.itemId (not inventory.id); that mapping is reconstruction-only.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 8) {
        logRejectedShopPacket(session, opcode, payloadBytes, "exactly u32 selected-object field + u32 opaque field", "Ignored malformed C->S 283 resell body");
        break;
      }
      if (!hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, "authenticated selected-channel Shop-stage session", "Ignored C->S 283 outside an authenticated Shop-stage context");
        break;
      }
      const clientItemKey = reader.readU32();
      const opaqueClientValue = reader.readU32();
      void opaqueClientValue;
      const refundLucci = 500; // Local demo economy only; not a recovered Taiwan resale value.
      const updated = user ? state.db.resellStockItem(user.id, clientItemKey, refundLucci) : null;
      const w212 = new PacketWriter(ServerOpcode.ShopResellResult);
      if (!updated) {
        w212.writeU8(1); // `sub_546D3F` maps result 1 to ResellItemFail; no further fields are read.
        session.sendPacket(w212);
        break;
      }

      user!.lucci = updated.lucci;
      w212.writeU8(0); // Success: `sub_546D3F` reads the item name and result values.
      w212.writeString(`Item #${clientItemKey}`);
      w212.writeU32(clientItemKey);
      w212.writeU32(0);
      w212.writeU32(refundLucci);
      session.sendPacket(w212);
      break;
    }

    case ClientOpcode.NexonClubAuth: {
      // C->S 284 (`CNexonClubDlg::sub_4BCB70`) writes `[u8, str, str]`; field meanings are UNKNOWN.
      // The Client has an S->C 213 NXClub result parser, but no dataflow or official trace proves it answers 284.
      // This local reconstruction policy copies the first string into S->C 213 and ignores the second.
      const payloadBytes = reader.remaining;
      const parsedAuth = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 1) return null;
        const inputByte = probe.readU8();
        const inputFieldA = readCompleteString(probe);
        if (inputFieldA === null) return null;
        const inputFieldB = readCompleteString(probe);
        if (inputFieldB === null || probe.remaining !== 0) return null;
        return { inputByte, inputFieldA, inputFieldB };
      });
      if (!parsedAuth) {
        logRejectedShopPacket(session, opcode, payloadBytes, "u8 field, str fieldA, str fieldB (exact)", "Ignored malformed or non-exact C->S 284 body");
        break;
      }
      void parsedAuth.inputFieldB;
      const w213 = new PacketWriter(ServerOpcode.NexonClubAuthResult);
      w213.writeU8(1); // local success value only; official result mapping/policy are UNKNOWN
      w213.writeU8(parsedAuth.inputByte);
      w213.writeString(parsedAuth.inputFieldA);
      session.sendPacket(w213);
      break;
    }

    case ClientOpcode.ShopPacket285: {
      // Two recovered Shop writers construct C->S 285 with an empty body. Their callers do not
      // establish a shared meaning or either S->C 99/214 association, so this stays audit-only.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 0) {
        logRejectedShopPacket(session, opcode, payloadBytes, "empty C->S 285 body", "Ignored non-empty C->S 285 body");
        break;
      }
      logger.info("PacketAudit", "Observed empty C->S 285 Shop writer without a local effect", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        responseAssociation: "UNKNOWN; empty-body writer callsites have distinct unresolved Shop contexts",
        responseSent: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.ClientPacket286: {
      // `sub_5B621F` writes one u32, but its field mapping, backend validation,
      // reward, and S->C 204 association are not established. Validate only the exact width.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 4) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          "exactly one opaque u32",
          "Ignored malformed C->S 286 ClientPacket286 body"
        );
        break;
      }
      reader.readU32(); // Opaque Client field; intentionally not treated as a reward ID.
      logger.info("PacketAudit", "Validated C->S 286 ClientPacket286 structure only", {
        direction: "C->S",
        wireOpcode: opcode,
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        payloadMeaning: "UNKNOWN",
        responseAssociation: "UNKNOWN",
        responseSent: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.UnresolvedClientPacket310: {
      const payloadBytes = reader.remaining;
      const callerSuppliedValue = payloadBytes > 0 ? reader.readU8() : undefined;
      reader.offset = reader.plain.length;
      logger.info("PacketAudit", "Observed C->S 310 from the conditional sub_58EBFE writer; response policy UNKNOWN", {
        direction: "C->S",
        wireOpcode: ClientOpcode.UnresolvedClientPacket310,
        opcodeName: formatClientOpcode(ClientOpcode.UnresolvedClientPacket310),
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        payloadSchema: "u8 caller-supplied n0xB value; meaning UNKNOWN",
        payloadWidthValid: payloadBytes === 1,
        callerSuppliedValue,
        clientWriter: "sub_58EBFE conditional CSendPacket site at 0x005905B8",
        responseAssociation: "UNKNOWN",
        responseSent: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.ShopSaveSlotOrder:
    case ClientOpcode.ShopStateSync:
    case ClientOpcode.GachaponClose:
    case ClientOpcode.BasketOpen:
    case ClientOpcode.BasketThrowAway: {
      break;
    }

    case ClientOpcode.GachaponRoll: {
      // C->S 307 (`CGachaponDlg::sub_5C3330`) writes one u32 coupon-item candidate. The local
      // reward is a demo fixture; the Client field's inventory identity and reward policy are UNKNOWN.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 4 || !hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(
          session,
          opcode,
          payloadBytes,
          "authenticated selected-channel Shop-stage session; exactly u32 coupon-item candidate",
          "Ignored malformed or out-of-context C->S 307 Gachapon request"
        );
        break;
      }
      const couponStockId = reader.readU32();
      const rewardStockId = 1005;
      if (user) {
        state.db.addStockItem(user.id, rewardStockId, 1, 0);
      }
      // Send S->C 257 (`sub_5C279C` -> `CGachaponDlg::sub_5C23DB`)
      session.sendPacket(buildGachaponResultPacket257(session, rewardStockId, 0));

      // Also send S->C 255 (`CShopStageNew::sub_53BBD8`)
      const w255 = new PacketWriter(ServerOpcode.GachaponResult);
      w255.writeU8(1);
      w255.writeU32(couponStockId);
      w255.writeString("Gachapon Prize");
      const ss = new SmartStreamWriter();
      ss.writeU32(1);
      ss.writeU32(rewardStockId);
      w255.writeSmartStream(ss, true);
      w255.writeU32(1);
      session.sendPacket(w255);
      break;
    }

    case ClientOpcode.BasketQueryInfo: {
      // C->S 313 is the empty-body Basket snapshot writer.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 0 || !hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, "authenticated Shop-stage session; empty body", "Ignored malformed or out-of-context C->S 313 Basket query");
        break;
      }
      session.sendPacket(buildBasketInfoPacket258());
      session.sendPacket(buildBasketCouponCountsPacket259(session));
      break;
    }

    case ClientOpcode.BasketQueryCoupons: {
      // C->S 314 is distinct: `CBasketDlg::sub_5C0C05` appends the selected local u8 index.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 1 || !hasShopTransactionContext(state, session)) {
        logRejectedShopPacket(session, opcode, payloadBytes, "authenticated Shop-stage session; exactly u8 localPlayerIdx", "Ignored malformed or out-of-context C->S 314 Basket query");
        break;
      }
      const localPlayerIdx = reader.readU8();
      if (!session.users[localPlayerIdx]) {
        logRejectedShopPacket(session, opcode, payloadBytes, "localPlayerIdx naming a session user", "Ignored C->S 314 with an invalid local-player index");
        break;
      }
      session.sendPacket(buildBasketCouponCountsPacket259(session));
      const w260 = new PacketWriter(ServerOpcode.BasketCouponCounts);
      w260.writeU32(0);
      session.sendPacket(w260);
      break;
    }

    case ClientOpcode.RequestUserMarketConnection: {
      // The recovered C->S 318 request is empty. Client-writer evidence (this investigation):
      // the ONLY recovered writer is CShopConnectionMan::sub_529D8E, which emits C->S 318
      // together with C->S 38 whenever its mode == 2 (the Lobby Shop-button caller).
      // A UserMarket association is therefore not writer-supported; the local S->C 262 reply
      // and the 265/320/269 UserMarket sequence below remain reconstruction policy only.
      const payloadBytes = reader.remaining;
      if (
        payloadBytes !== 0 ||
        !hasAuthenticatedGameContext(state, session) ||
        (session.stageId !== StageId.Lobby && session.stageId !== StageId.Shop)
      ) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated selected-channel Lobby/Shop session; empty body", "Ignored malformed or out-of-context C->S 318 UserMarket connection request");
        break;
      }
      // Shop-flow guard: `sub_529D8E` always writes C->S 318 immediately after its mode-2
      // C->S 38, so the first C->S 318 after a local Shop-entry reply is that companion frame.
      // S->C 265 makes the Client echo C->S 320 (`sub_4BB408`), and the C->S 320 policy below
      // would then flip the session to UserMarket mid-entry. Consume the one-shot latch and
      // suppress the fee-info branch for that companion frame only; standalone C->S 318
      // frames keep the full local UserMarket policy. The one-byte S->C 262 body is
      // bounds-safe in the Client (its banner reader over-reads to count 0).
      const shopFlowGuard = session.shopEnterReplyPending;
      if (shopFlowGuard) {
        session.shopEnterReplyPending = false;
      }
      const featureAvailable = state.config.enabledFeatures.has(28) && !shopFlowGuard;
      session.userMarketPermissionGranted = featureAvailable;
      const w262 = new PacketWriter(ServerOpcode.UserMarketPermission);
      w262.writeU8(featureAvailable ? 1 : 0); // local policy mirrors configured Client-stage availability
      session.sendPacket(w262);
      if (featureAvailable) {
        session.sendPacket(buildUserMarketFeeInfoPacket265());
      }
      break;
    }

    case ClientOpcode.UserMarketFeeInfoReply320: {
      // Binary-confirmed Client payload: [u32 feeRate, str notice, u32 minPrice].
      const payloadBytes = reader.remaining;
      const parsedFeeInfo = parseExactPayload(reader, (probe) => {
        if (probe.remaining < 4) return null;
        const feeRate = probe.readU32();
        const noticeStart = probe.offset;
        const notice = readCompleteString(probe);
        if (notice === null) return null;
        const noticeWireBytes = probe.offset - noticeStart;
        if (probe.remaining !== 4) return null;
        const minPrice = probe.readU32();
        return { feeRate, noticeWireBytes, minPrice };
      });
      if (!parsedFeeInfo) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "exactly u32 feeRate, str notice, u32 minPrice", "Ignored malformed or non-exact C->S 320 body");
        break;
      }
      if (
        !state.config.enabledFeatures.has(28) ||
        !session.userMarketPermissionGranted ||
        !hasAuthenticatedGameContext(state, session) ||
        (session.stageId !== StageId.Lobby && session.stageId !== StageId.Shop)
      ) {
        logRejectedUserMarketPacket(
          session,
          opcode,
          payloadBytes,
          "feature-28-enabled selected-channel Lobby/Shop session after local C->S 318 permission",
          "Ignored C->S 320 without the local UserMarket permission/feature gate"
        );
        break;
      }
      session.userMarketPermissionGranted = false;

      // This S->C 269 success is a reconstruction choice based on the Client's
      // confirmed transition parser, not a production-server trace.
      session.stageId = StageId.UserMarket;
      session.userMarketLocalIdx = null;
      const w269 = new PacketWriter(ServerOpcode.UserMarketEnterResult);
      w269.writeU8(1);
      session.sendPacket(w269);
      logger.debug("UserMarket", "Decoded exact C->S 320 fee-info fields", {
        sessionId: session.sessionId,
        stageId: formatStageId(session.stageId),
        feeRate: parsedFeeInfo.feeRate,
        noticeWireBytes: parsedFeeInfo.noticeWireBytes,
        minPrice: parsedFeeInfo.minPrice,
        trailingPayloadBytes: 0,
        enterResultWriteCall: true,
        officialClientTransitionVerified: false,
      });
      break;
    }

    case ClientOpcode.UserMarketStageEntry321: {
      // CUserMarketStage::sub_5723F6 writes two bytes and then separately emits C->S 98.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 2 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly two u8 fields", "Ignored malformed or out-of-context C->S 321 stage-entry body");
        break;
      }
      const fieldA = reader.readU8();
      const localIdx = reader.readU8();
      if (!selectUserMarketUser(session, localIdx)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "second u8 localPlayerIdx naming a session user", "Ignored C->S 321 with an invalid local-player index");
        break;
      }
      logger.debug("UserMarket", "Decoded exact C->S 321 UserMarket stage-entry fields", {
        sessionId: session.sessionId,
        stageId: formatStageId(session.stageId),
        fieldA,
        localIdx,
        trailingPayloadBytes: 0,
        responseSent: false,
      });
      break;
    }

    case ClientOpcode.ContextualClientPacket98: {
      // CUserMarketStage::sub_5723F6 emits u8(0) immediately after its C->S 321 body.
      // Do not apply the room/Shop u8(1) policy here: no Client reply association or official
      // state transition for this UserMarket follow-up has been established.
      const payloadBytes = reader.remaining;
      const fieldValue = parseExactPayload(reader, (probe) =>
        probe.remaining === 1 ? probe.readU8() : null
      );
      if (
        fieldValue !== 0 ||
        !hasUserMarketTransactionContext(state, session) ||
        session.userMarketLocalIdx === null ||
        !session.users[session.userMarketLocalIdx]
      ) {
        logRejectedUserMarketPacket(
          session,
          opcode,
          payloadBytes,
          "exact u8(0), authenticated UserMarket-stage session, and a local-player selection from C->S 321",
          "Ignored malformed or out-of-context C->S 98 UserMarket follow-up"
        );
        break;
      }
      logger.info("PacketAudit", "Observed C->S 98 UserMarket follow-up; no Server response/state association is established", {
        direction: "C->S",
        wireOpcode: opcode,
        opcodeName: formatClientOpcode(opcode),
        sessionId: session.sessionId,
        connectionKind: session.connectionKind,
        stageId: formatStageId(session.stageId),
        payloadBytes,
        payloadSchema: "u8(0), emitted after C->S 321 by CUserMarketStage::sub_5723F6",
        responseAssociation: "UNKNOWN",
        responseSent: false,
        stageChanged: false,
        databaseMutation: false,
      });
      break;
    }

    case ClientOpcode.UserMarketStageSync324: {
      // CUserMarketStage::sub_5722B3 writes exactly one local-player index on the sync path.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 1 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly u8 localPlayerIdx", "Ignored malformed or out-of-context C->S 324 sync request");
        break;
      }
      const localIdx = reader.readU8();
      const marketUser = selectUserMarketUser(session, localIdx);
      if (!marketUser) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "localPlayerIdx naming a session user", "Ignored C->S 324 with an invalid local-player index");
        break;
      }

      // Local server reconstruction of the market-stage snapshot. The Client reader widths
      // are confirmed; values and business meanings are fixture policy, scoped to the selected user.
      const w270 = new PacketWriter(ServerOpcode.UserMarketMaxLucci);
      w270.writeU32(2_000_000); // local fixture cap; not asserted as official production policy
      session.sendPacket(w270);

      const w271 = new PacketWriter(ServerOpcode.UserMarketBalance);
      w271.writeU32(marketUser.marketLucci ?? marketUser.lucci);
      session.sendPacket(w271);

      const stock = state.db.getUserStock(marketUser.id);
      const w280 = new PacketWriter(ServerOpcode.UserMarketTradeableItems);
      w280.writeI32(stock.length);
      for (const item of stock) {
        w280.writeU32(item.itemCode);
      }
      session.sendPacket(w280);
      session.sendPacket(buildMarketListPacket272(state));
      break;
    }

    case ClientOpcode.UserMarketFilterState325: {
      // CMarketSlotWnd::sub_570B4D writes [u8, u8, u16, u8]. Field meanings are unresolved;
      // this local reconstruction returns the list unfiltered for a valid local-player selector.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 5 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly u8, u8, u16, u8", "Ignored malformed or out-of-context C->S 325 filter-state packet");
        break;
      }
      const field0 = reader.readU8();
      const field1 = reader.readU8();
      const field2 = reader.readU16();
      const localIdx = reader.readU8();
      if (!selectUserMarketUser(session, localIdx)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "last u8 localPlayerIdx naming a session user", "Ignored C->S 325 with an invalid local-player index");
        break;
      }
      logger.debug("UserMarket", "Decoded C->S 325 market filter-state fields", {
        sessionId: session.sessionId,
        stageId: formatStageId(session.stageId),
        field0,
        field1,
        field2,
        localIdx,
        responsePolicy: "local listing snapshot",
        officialServerSemanticsVerified: false,
      });
      session.sendPacket(buildMarketListPacket272(state));
      break;
    }

    case ClientOpcode.UserMarketRegisterListing326: {
      // CRegisterItemDlg::sub_5753E3 writes two u32 values. Interpreting them as
      // item-code/price is limited to this reconstruction's local demo-market adapter.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 8 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly two u32 fields", "Ignored malformed or out-of-context C->S 326 listing request");
        break;
      }
      const selectedItemField = reader.readU32();
      const priceField = reader.readU32();
      const selection = getSelectedUserMarketUser(session);
      if (!selection) {
        logRejectedUserMarketPacket(
          session,
          opcode,
          payloadBytes,
          "selected UserMarket local player; C->S 326 itself has no selector byte",
          "Ignored C->S 326 because a two-user session has no unambiguous local-player selection"
        );
        break;
      }
      const listing = state.db.createMarketListing(
        selection.user.id,
        selection.user.username,
        selectedItemField,
        priceField
      );
      if (!listing) {
        logger.info("PacketAudit", "Ignored C->S 326 whose local item-code/price policy did not resolve", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          responseAssociation: "UNKNOWN for an unresolved local market listing",
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      const w273 = new PacketWriter(ServerOpcode.UserMarketRegisterResult);
      w273.writeU16(0); // local fixture result=0; official result meaning is not inferred
      w273.writeU32(selectedItemField);
      session.sendPacket(w273);
      session.sendPacket(buildMarketListPacket272(state));
      session.sendPacket(buildMarketMySalesPacket275(state, session));
      break;
    }

    case ClientOpcode.UserMarketCancelListing: {
      // C->S 327 writes one u32 listing candidate; the local DB-key mapping is policy only.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 4 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly u32 listing candidate", "Ignored malformed or out-of-context C->S 327 listing-cancel request");
        break;
      }
      const listingId = reader.readU32();
      const selection = getSelectedUserMarketUser(session);
      if (!selection) {
        logRejectedUserMarketPacket(
          session,
          opcode,
          payloadBytes,
          "selected UserMarket local player; C->S 327 itself has no selector byte",
          "Ignored C->S 327 because a two-user session has no unambiguous local-player selection"
        );
        break;
      }
      const cancelled = state.db.cancelMarketListing(listingId, selection.user.id);
      if (!cancelled) {
        logger.info("PacketAudit", "Ignored C->S 327 without an active listing owned by the selected local user", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          responseAssociation: "UNKNOWN for an unresolved/non-owned listing candidate",
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      const w274 = new PacketWriter(ServerOpcode.UserMarketCancelResult274);
      w274.writeU16(0); // local fixture result; Client parser expects u16 + u32
      w274.writeU32(cancelled.itemCode);
      session.sendPacket(w274);
      session.sendPacket(buildMarketListPacket272(state));
      session.sendPacket(buildMarketMySalesPacket275(state, session));
      break;
    }

    case ClientOpcode.UserMarketSearchText328: {
      // CMarketSlotWnd::sub_56EF5B writes [str, u16, u8]. Only the first field is
      // used as a search hint by this local demo implementation; the other meanings
      // and production server response remain unverified.
      const payloadBytes = reader.remaining;
      const parsedSearch = parseExactPayload(reader, (probe) => {
        const queryStart = probe.offset;
        const query = readCompleteString(probe);
        if (query === null || probe.remaining !== 3) return null;
        const queryWireBytes = probe.offset - queryStart;
        const fieldU16 = probe.readU16();
        const localIdx = probe.readU8();
        return { query, queryWireBytes, fieldU16, localIdx };
      });
      if (!parsedSearch || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exact str query, u16 field, u8 localPlayerIdx", "Ignored malformed or out-of-context C->S 328 search body");
        break;
      }
      if (!selectUserMarketUser(session, parsedSearch.localIdx)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "last u8 localPlayerIdx naming a session user", "Ignored C->S 328 with an invalid local-player index");
        break;
      }
      logger.debug("UserMarket", "Decoded exact C->S 328 market search-text fields", {
        sessionId: session.sessionId,
        stageId: formatStageId(session.stageId),
        queryWireBytes: parsedSearch.queryWireBytes,
        fieldU16: parsedSearch.fieldU16,
        localIdx: parsedSearch.localIdx,
        trailingPayloadBytes: 0,
        responsePolicy: "local listing snapshot filtered by text",
        officialServerSemanticsVerified: false,
      });
      session.sendPacket(buildMarketListPacket272(state, parsedSearch.query));
      break;
    }

    case ClientOpcode.UserMarketTransferLucci: {
      // C->S 329 writes [u8 localIdx, u32 amount]; amount direction is not encoded.
      // This local demo models the path as Market -> Game and applies it to the selected local user.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 5 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly u8 localPlayerIdx + u32 amount", "Ignored malformed or out-of-context C->S 329 transfer request");
        break;
      }
      const localIdx = reader.readU8();
      const amount = reader.readU32();
      const transferUser = selectUserMarketUser(session, localIdx);
      if (!transferUser) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "localPlayerIdx naming a session user", "Ignored C->S 329 with an invalid local-player index");
        break;
      }
      const updated = state.db.transferMarketLucci(transferUser.id, 0, amount);
      if (!updated) {
        logger.info("PacketAudit", "Ignored C->S 329 whose selected local user did not resolve", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      synchronizeSessionUserSnapshot(state, updated);
      const userLucci = updated.lucci;
      const marketLucci = updated.marketLucci ?? updated.lucci;
      logger.debug("UserMarket", "Handled exact C->S 329 with local reconstruction direction", {
        sessionId: session.sessionId,
        username: updated.username,
        localIdx,
        amount,
        direction: "market-to-game (local policy; not encoded by C->S 329)",
        userLucci,
        marketLucci,
      });

      const w276 = new PacketWriter(ServerOpcode.UserMarketTransferResult);
      w276.writeU16(0); // local success fixture; official result meaning is not inferred
      w276.writeU32(userLucci);
      w276.writeU32(marketLucci);
      session.sendPacket(w276);
      break;
    }

    case ClientOpcode.UserMarketBuyListing: {
      // C->S 330 writes one u32 listing candidate; the local listing-ID mapping is policy only.
      const payloadBytes = reader.remaining;
      if (payloadBytes !== 4 || !hasUserMarketTransactionContext(state, session)) {
        logRejectedUserMarketPacket(session, opcode, payloadBytes, "authenticated UserMarket-stage session; exactly u32 listing candidate", "Ignored malformed or out-of-context C->S 330 purchase request");
        break;
      }
      const listingId = reader.readU32();
      const selection = getSelectedUserMarketUser(session);
      if (!selection) {
        logRejectedUserMarketPacket(
          session,
          opcode,
          payloadBytes,
          "selected UserMarket local player; C->S 330 itself has no selector byte",
          "Ignored C->S 330 because a two-user session has no unambiguous local-player selection"
        );
        break;
      }
      const bought = state.db.buyMarketListing(listingId, selection.user.id);
      if (!bought) {
        logger.info("PacketAudit", "Ignored C->S 330 without an affordable active listing for another user", {
          direction: "C->S",
          wireOpcode: opcode,
          sessionId: session.sessionId,
          stageId: formatStageId(session.stageId),
          payloadBytes,
          responseAssociation: "UNKNOWN for a rejected local market purchase",
          responseSent: false,
          databaseMutation: false,
        });
        break;
      }
      synchronizeSessionUserSnapshot(state, bought.buyer);
      synchronizeSessionUserSnapshot(state, bought.seller);
      const remainMarketLucci = bought.buyer.marketLucci ?? bought.buyer.lucci;

      const w277 = new PacketWriter(ServerOpcode.UserMarketPurchaseResult);
      w277.writeU16(0); // local success fixture; official result meaning is not inferred
      w277.writeU32(bought.listing.itemCode);
      w277.writeU32(remainMarketLucci);
      w277.writeVariantTime();
      session.sendPacket(w277);

      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      session.sendPacket(buildMarketListPacket272(state));
      break;
    }

    case ClientOpcode.RequestFxStockIni: {
      // C->S 276 (`sub_594353`) -> S->C 193 (`sub_4B95B0` -> `sub_593FF6`)
      session.sendPacket(
        buildIniSmartStreamPacket(state, ServerOpcode.FxStockIniStream, "fxstock.ini")
      );
      break;
    }

    case ClientOpcode.RequestStringTableIni: {
      // C->S 278 is emitted empty by sub_59449A on a stringtable checksum mismatch.
      // The client parser is S->C 200; S->C 278/279 are separate UserMarket notifications.
      session.sendPacket(
        buildIniSmartStreamPacket(state, ServerOpcode.StringTableIniStream, "stringtable.ini")
      );
      break;
    }

    case ClientOpcode.RequestPackageMapIni: {
      // C->S 281 (`sub_5943FB`) -> S->C 210 (`sub_4B966A` -> `sub_59426D`)
      session.sendPacket(
        buildIniSmartStreamPacket(state, ServerOpcode.PackageMapIniStream, "packagemap.ini")
      );
      break;
    }

    case ClientOpcode.ContextualClientPacket303: {
      // The Client writers vary by caller (u8 index or empty); response association is not proven.
      // Keep this as a local reconstruction policy using the base S->C 186 parser's two-u32 shape;
      // the fields' meanings and any C->S 303 association are UNKNOWN. This local handler treats a byte
      // as a user selector and copies user.lucci, neither of which is official Client/Server evidence.
      const requestValue = reader.remaining >= 1 ? reader.readU8() : 0;
      const u = session.users[requestValue] ?? session.users[0];
      if (u) {
        const w186 = new PacketWriter(ServerOpcode.UserDynamicInfoFieldSync186);
        w186.writeU32(requestValue);
        w186.writeU32(u.lucci);
        session.sendPacket(w186);
      }
      break;
    }
  }
}
