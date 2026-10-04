import { ClientOpcode, ServerOpcode, StageId } from "../protocol/opcodes.ts";
import { ipv4ToBytes, PacketReader, PacketWriter, unixMsToVariantTime } from "../protocol/primitives.ts";
import { SmartStreamWriter } from "../protocol/stream.ts";
import type { ClientSession, WorldState } from "../state/worldState.ts";

/**
 * Builds S->C 194 (`CUserInventoryMan::sub_595272` -> `sub_594ECF`) full inventory load
 * or S->C 188 (`CUserInventoryMan::sub_5953FE` -> `sub_594ECF`) inventory update:
 *   u8 playerCount
 *   For each local player:
 *     i32 itemCount
 *     For each item (`sub_594ECF` at `0x00594ECF`):
 *       u32 stockId (`itemCode`)
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
      w.writeU32(item.itemCode);
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
    const equipped = user
      ? state.db.getUserStock(user.id).filter((s) => s.equipped > 0)
      : [];
    for (let slot = 0; slot < 8; slot++) {
      const match = equipped[slot];
      w196.writeU32(match ? match.itemCode : 0);
      w196.writeString(match?.customText ?? "");
    }
  }
  return w196;
}

export interface CustomItemDefinition {
  id: number;
  category: number;
  code: string;
  v1: number;
  v2: number;
  v3: number;
  name: string;
  val: number;
  flag1: number;
}

/**
 * Builds S->C 197 / S->C 63 (`CUserItemMan::sub_598BEC` -> `sub_597611` at `0x00597611`):
 *   u16 itemCount (`sub_697510`)
 *   For each item (`sub_597611`, TW region 8 has `sub_5CEA88(28) == 0`):
 *     u32 id (`sub_697580`)
 *     u8 category (`sub_6974B0`)
 *     str code (`sub_698290`)
 *     u32 v1 (`sub_697580`)
 *     u32 v2 (`sub_697580`)
 *     u32 v3 (`sub_697580`)
 *     str name (`sub_698290`)
 *     u16 val (`sub_697510`)
 *     u8 flag1 (`sub_6974B0`)
 */
export function buildUserItemsPacket197(
  _session?: ClientSession,
  items: readonly CustomItemDefinition[] = [],
  opcode: number = ServerOpcode.UserItemsData
): PacketWriter {
  const w197 = new PacketWriter(opcode);
  w197.writeU16(items.length);
  for (const item of items) {
    w197.writeU32(item.id);
    w197.writeU8(item.category);
    w197.writeString(item.code);
    w197.writeU32(item.v1);
    w197.writeU32(item.v2);
    w197.writeU32(item.v3);
    w197.writeString(item.name);
    w197.writeU16(item.val);
    w197.writeU8(item.flag1);
  }
  return w197;
}

/**
 * Builds S->C 203 (`CUserInventoryMan::sub_5954D2` -> `sub_58DFE6` at `0x0058DFE6`):
 *   u8 playerCount (`sub_6974B0`)
 *   For each local player:
 *     u8 giftCount (`sub_6974B0`)
 *     For each gift (`sub_58DFE6` for `giftType == 200`):
 *       u8 giftType (`200` = item gift, `201` = coupon gift)
 *       u32 stockId (`sub_697580`)
 *       u32 amount (`sub_697580`)
 *       u8 flag (`sub_6974B0`)
 *       u16 validDays (`sub_697510`)
 *       str senderName (`sub_698290`)
 *       str message (`sub_698290`)
 */
export function buildGiftListPacket203(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const players = session.users.length > 0 ? session.users : [null];
  const w203 = new PacketWriter(ServerOpcode.ShopGiftList);
  w203.writeU8(players.length);

  for (const user of players) {
    const gifts = user ? state.db.getGiftsByUser(user.id) : [];
    w203.writeU8(Math.min(255, gifts.length));
    for (const g of gifts.slice(0, 255)) {
      w203.writeU8(200); // 200 = item gift (`sub_58DFE6`)
      w203.writeU32(g.itemId);
      w203.writeU32(1); // amount
      w203.writeU8(1); // delivery flag
      w203.writeU16(30); // validDays
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
 * Builds S->C 190 (`CShopDlg::sub_546BE3` at `0x00546BE3`):
 *   u32 lucciBalance (`sub_697580`)
 */
export function buildLucciBalancePacket190(session: ClientSession): PacketWriter {
  const user = session.users[0];
  const w190 = new PacketWriter(ServerOpcode.ShopLucciBalance190);
  w190.writeU32(user?.lucci ?? 0);
  return w190;
}

/**
 * Builds S->C 48 (`CShopConnectionMan::sub_529E8D` at `0x00529E8D`):
 *   u8 ok (`1`)
 *   u8 flag (`0`)
 *   u32 authToken
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

  const w198 = new PacketWriter(ServerOpcode.ShopUserStockList);
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
 * Builds S->C 272 (`CMarketSlotWnd::sub_57282A` at `0x0057282A`):
 *   u16 totalCount
 *   u16 pageCount
 *   For each listing:
 *     u32 listingId
 *     u32 stockId (`itemCode`)
 *     str sellerName
 *     u32 price
 *     u16 remainHours
 */
export function buildMarketListPacket272(
  state: WorldState,
  searchQuery: string = ""
): PacketWriter {
  const listings = state.db.getActiveMarketListings(searchQuery);
  const w272 = new PacketWriter(ServerOpcode.UserMarketList);
  w272.writeU16(listings.length);
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
 * Builds S->C 275 (`CMarketSlotWnd::sub_572AC5` at `0x00572AC5` My Sales List):
 *   u16 count
 *   For each listing:
 *     u32 listingId
 *     u32 stockId (`itemCode`)
 *     str sellerName
 *     u32 price
 *     u16 remainHours
 */
export function buildMarketMySalesPacket275(
  state: WorldState,
  session: ClientSession
): PacketWriter {
  const user = session.users[0];
  const listings = user ? state.db.getMarketListingsBySeller(user.id) : [];
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
      const w261 = new PacketWriter(ServerOpcode.ShopConnectionPermission);
      w261.writeU8(1); // 1 = allowed
      session.sendPacket(w261);

      session.sendPacket(buildShopRedirectPacket48(state, session));
      break;
    }

    case ClientOpcode.AuthenticateShopConnection: {
      session.stageId = StageId.Shop;
      session.sendPacket(buildShopInitPacket16(state, session));

      const w9 = new PacketWriter(ServerOpcode.StageTransition);
      w9.writeU32(StageId.Shop);
      session.sendPacket(w9);

      session.sendPacket(buildUserStockPacket(state, session));
      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryData));
      session.sendPacket(buildEquippedAvatarPacket196(state, session));
      break;
    }

    case ClientOpcode.EnterShopMode: {
      const mode = reader.remaining >= 1 ? reader.readU8() : 2;
      const localIdx = reader.remaining >= 1 ? reader.readU8() : 0;

      const w261 = new PacketWriter(ServerOpcode.ShopConnectionPermission);
      w261.writeU8(1);
      w261.writeU8(mode);
      w261.writeU8(localIdx);
      session.sendPacket(w261);

      if (mode === 2) {
        session.stageId = StageId.Shop;
        session.sendPacket(buildShopInitPacket16(state, session));

        const w9 = new PacketWriter(ServerOpcode.StageTransition);
        w9.writeU32(StageId.Shop);
        session.sendPacket(w9);
      }
      break;
    }

    case ClientOpcode.EnterShopFromLobby: {
      session.stageId = StageId.Shop;
      session.sendPacket(buildShopInitPacket16(state, session));

      const w9 = new PacketWriter(ServerOpcode.StageTransition);
      w9.writeU32(StageId.Shop);
      session.sendPacket(w9);
      break;
    }

    case ClientOpcode.ShopEnter: {
      // C->S 269 (`CShopStageNew::sub_536555` mode=1, `sub_589DB9` mode=0) -> S->C 198 (`sub_53885C`)
      const mode = reader.remaining >= 1 ? reader.readU8() : 1;
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
      // C->S 270 (`sub_58EAEF` -> `sub_58B130`) / C->S 309 (`sub_58B871`) -> S->C 199 (`sub_58EBFE`)
      if (opcode === ClientOpcode.ShopBuyItemPass && reader.remaining >= 2) {
        reader.readString(); // nexonPass
      }
      const packageOrStockId = reader.remaining >= 4 ? reader.readU32() : 1001;
      const _discountCoupon = reader.remaining >= 4 ? reader.readU32() : 0;
      const customText = reader.remaining >= 2 ? reader.readString() : "";

      if (user) {
        const price = 100;
        if (user.lucci >= price) {
          user.lucci -= price;
        } else if (user.cash >= price) {
          user.cash -= price;
        }
        state.db.updateUserCurrency(user.id, user.lucci, user.cash);
        state.db.addStockItem(user.id, packageOrStockId, 1, 1, customText);
      }

      const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
      w199.writeU8(0); // 0 = purchase success (`sub_58EBFE`)
      w199.writeVariantTime();
      session.sendPacket(w199);

      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      session.sendPacket(buildCashBalancePacket198(session));
      session.sendPacket(buildLucciBalancePacket190(session));
      break;
    }

    case ClientOpcode.InventoryDeleteItem: {
      // C->S 271 (`sub_58013E`: `[u32 stockId, u32 slotIdx]`) -> S->C 202 (`sub_547038`)
      const stockId = reader.remaining >= 4 ? reader.readU32() : 0;
      const _slotIdx = reader.remaining >= 4 ? reader.readU32() : 0;
      if (user && stockId > 0) {
        state.db.deleteStockItem(user.id, stockId);
      }
      const w202 = new PacketWriter(ServerOpcode.InventoryDeleteResult);
      w202.writeU8(2); // case 2 = delete success (`sub_547038` -> `sub_583E41`)
      w202.writeU32(stockId);
      w202.writeU32(0); // remainCount
      session.sendPacket(w202);
      break;
    }

    case ClientOpcode.ShopAction: {
      if (!user) {
        return;
      }

      // Check if this is the real client `sub_5816F4` equip-sync format:
      // `[u8 mode (0..4), u8 playerIdx (0..1), u16 count, count * (u8 slot, u32 stockId), (if mode==1||4: u8, u8)]`
      if (reader.remaining >= 4) {
        const saved = reader.offset;
        const mode = reader.readU8();
        const playerIdx = reader.readU8();
        const count = reader.readU16();
        const expectedRem = count * 5 + (mode === 1 || mode === 4 ? 2 : 0);
        if (
          mode <= 4 &&
          playerIdx <= 1 &&
          count <= 64 &&
          (reader.remaining === expectedRem || reader.remaining === count * 5)
        ) {
          for (let i = 0; i < count; i++) {
            const slotCat = reader.readU8();
            const stockId = reader.readU32();
            if (stockId > 0) {
              state.db.setStockEquipped(user.id, stockId, slotCat > 0 ? slotCat : 1);
            }
          }
          session.sendPacket(buildEquippedAvatarPacket196(state, session));
          return;
        }
        reader.offset = saved;
      }

      const subOp = reader.remaining >= 1 ? reader.readU8() : 0;
      if (subOp === 0) {
        session.sendPacket(buildUserStockPacket(state, session));
      } else if (subOp === 1) {
        const itemCode = reader.remaining >= 4 ? reader.readU32() : 101;
        const payType = reader.remaining >= 1 ? reader.readU8() : 0; // 0 = Lucci, 1 = Cash
        const price = reader.remaining >= 4 ? reader.readU32() : 100;

        if (payType === 0 && user.lucci < price) {
          const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
          w199.writeU8(1); // insufficient lucci
          session.sendPacket(w199);
          return;
        }
        if (payType === 1 && user.cash < price) {
          const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
          w199.writeU8(2); // insufficient cash
          session.sendPacket(w199);
          return;
        }

        if (payType === 0) {
          user.lucci -= price;
        } else {
          user.cash -= price;
        }
        state.db.updateUserCurrency(user.id, user.lucci, user.cash);
        const stockId = state.db.addStockItem(user.id, itemCode, 1, 1);

        const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
        w199.writeU8(0); // 0 = purchase success
        w199.writeU32(stockId);
        w199.writeU32(itemCode);
        w199.writeU32(user.lucci);
        w199.writeU32(user.cash);
        session.sendPacket(w199);

        session.sendPacket(buildUserStockPacket(state, session));
      } else if (subOp === 2) {
        const itemCode = reader.remaining >= 4 ? reader.readU32() : 101;
        const receiverName = reader.remaining >= 2 ? reader.readString() : "";
        const receiver = receiverName ? state.db.getUserByUsername(receiverName) : null;
        if (receiver) {
          state.db.addStockItem(receiver.id, itemCode, 1, 0);
        }
        const w201 = new PacketWriter(ServerOpcode.ShopGiftResult);
        w201.writeU8(0); // success
        session.sendPacket(w201);
      } else if (subOp === 3) {
        const itemCode = reader.remaining >= 4 ? reader.readU32() : 101;
        const equipState = reader.remaining >= 1 ? reader.readU8() : 1;
        state.db.setStockEquipped(user.id, itemCode, equipState);

        const w204 = new PacketWriter(ServerOpcode.ShopEquipResult);
        w204.writeU8(0); // success
        w204.writeU32(itemCode);
        w204.writeU8(equipState);
        session.sendPacket(w204);
      }
      break;
    }

    case ClientOpcode.ShopUseOrEquip274: {
      // Real client `sub_541682` / `sub_594F84`: `[u8 playerIdx, u8 slotIdx, u32 stockId, str customText]`
      // Or compact `[u16 stockIdx, u32 itemCode]`
      if (reader.remaining >= 8) {
        const _playerIdx = reader.readU8();
        const slotIdx = reader.readU8();
        const stockId = reader.readU32();
        const customText = reader.readString();
        if (user && stockId > 0) {
          state.db.setStockEquipped(user.id, stockId, slotIdx + 1);
          if (customText) {
            state.db.updateStockCustomText(user.id, stockId, customText);
          }
        }
        session.sendPacket(buildEquippedAvatarPacket196(state, session));
        session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
        break;
      }

      const _stockIdx = reader.remaining >= 2 ? reader.readU16() : 0;
      const itemCode = reader.remaining >= 4 ? reader.readU32() : 101;
      if (user) {
        state.db.setStockEquipped(user.id, itemCode, 1);
      }
      const w202 = new PacketWriter(ServerOpcode.ShopUseOrEquipResult202);
      w202.writeU8(1); // 1 = success (`sub_547052`)
      w202.writeU16(_stockIdx);
      w202.writeU32(itemCode);
      w202.writeU16(1);
      w202.writeU16(0);
      w202.writeU32(0);
      w202.writeU32(0);
      session.sendPacket(w202);
      break;
    }

    case ClientOpcode.ShopInventoryTab275: {
      // Real client `CShopTextDlg::sub_48ED44`: `[u8 playerIdx, u8 count, count * (u32 stockId, str text)]`
      // Or `[u8 tabIdx]`
      if (reader.remaining >= 8) {
        const _playerIdx = reader.readU8();
        const count = reader.readU8();
        for (let i = 0; i < count && reader.remaining >= 6; i++) {
          const stockId = reader.readU32();
          const text = reader.readString();
          if (user) {
            state.db.updateStockCustomText(user.id, stockId, text);
          }
        }
        session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
        session.sendPacket(buildEquippedAvatarPacket196(state, session));
        break;
      }

      session.sendPacket(buildUserStockPacket(state, session));
      break;
    }

    case ClientOpcode.ShopBillingCheck: {
      // C->S 277 (`sub_589D78`) -> S->C 201 (`sub_58C8EA`)
      const w201 = new PacketWriter(ServerOpcode.ShopGiftResult);
      w201.writeU8(1);
      w201.writeU32(user?.cash ?? 0);
      w201.writeU32(user?.lucci ?? 0);
      session.sendPacket(w201);
      break;
    }

    case ClientOpcode.ShopSendGift: {
      // C->S 279 (`sub_52C5A2`: `[u32 packageId, str receiverName, str title, str message, u8 flag]`)
      const packageId = reader.remaining >= 4 ? reader.readU32() : 1001;
      const receiverName = reader.remaining >= 2 ? reader.readString() : "";
      const title = reader.remaining >= 2 ? reader.readString() : "";
      const message = reader.remaining >= 2 ? reader.readString() : "";
      const senderName = user?.username ?? "Sender";

      if (receiverName) {
        const receiver = state.db.getUserByUsername(receiverName);
        if (receiver) {
          state.db.createGift(receiver.id, senderName, packageId, packageId, title, message);
          state.db.addStockItem(receiver.id, packageId, 1, 0);
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

    case ClientOpcode.ShopBuy280: {
      // Real client `CShopCouponDlg::sub_492CD9` / `sub_492E5C`: `[str couponCode, str targetUser]` -> S->C 204 (`sub_53A6F1`)
      // Or compact `[u8 tab, u16 itemCode]` -> S->C 199
      if (reader.remaining >= 4) {
        const saved = reader.offset;
        const codeLen = reader.readU16();
        reader.offset = saved;
        if (codeLen > 0 && codeLen + 2 <= reader.remaining) {
          const _couponCode = reader.readString();
          const targetUsername = reader.remaining >= 2 ? reader.readString() : "";
          const targetUser =
            (targetUsername ? state.db.getUserByUsername(targetUsername) : null) ?? user ?? null;
          const rewardCode = 1002;
          if (targetUser) {
            state.db.addStockItem(targetUser.id, rewardCode, 1, 0);
          }

          const w204 = new PacketWriter(ServerOpcode.ShopCouponResult);
          w204.writeU8(targetUsername ? 15 : 1); // 1 = self coupon redeemed, 15 = gift coupon sent (`sub_53A6F1`)
          w204.writeU32(1); // itemCount = 1
          w204.writeVariantTime();
          w204.writeU32(rewardCode);
          w204.writeU32(1); // count = 1
          w204.writeU32(30); // validDays = 30
          w204.writeU32(0);
          session.sendPacket(w204);

          session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
          break;
        }
      }

      const _tab = reader.remaining >= 1 ? reader.readU8() : 0;
      const itemCode = reader.remaining >= 2 ? reader.readU16() : 101;
      if (user) {
        const stockId = state.db.addStockItem(user.id, itemCode, 1, 1);
        const w199 = new PacketWriter(ServerOpcode.ShopBuyResult);
        w199.writeU8(0);
        w199.writeU32(stockId);
        w199.writeU32(itemCode);
        w199.writeU32(user.lucci);
        w199.writeU32(user.cash);
        session.sendPacket(w199);
      }
      break;
    }

    case ClientOpcode.ShopResellItem: {
      // C->S 283 (`sub_58BFE0`: `[u32 stockId, u32 slotIdx]`) -> S->C 212 (`sub_546D3F`)
      const stockId = reader.remaining >= 4 ? reader.readU32() : 1001;
      const _slotIdx = reader.remaining >= 4 ? reader.readU32() : 0;
      const refundLucci = 500;
      if (user) {
        const updated = state.db.resellStockItem(user.id, stockId, refundLucci);
        if (updated) {
          user.lucci = updated.lucci;
        }
      }
      const w212 = new PacketWriter(ServerOpcode.ShopResellResult);
      w212.writeU8(0); // 0 = resell success (`sub_546D3F`)
      w212.writeString(`Item #${stockId}`);
      w212.writeU32(stockId);
      w212.writeU32(0);
      w212.writeU32(refundLucci);
      session.sendPacket(w212);
      break;
    }

    case ClientOpcode.NexonClubAuth: {
      // C->S 284 (`CNexonClubDlg::sub_4BCB70`: `[u8 playerIdx, str clubId, str clubPass]`) -> S->C 232 (`CStage::sub_4BC337`)
      const playerIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const clubId = reader.remaining >= 2 ? reader.readString() : (user?.username ?? "nx_club");
      const w232 = new PacketWriter(ServerOpcode.NexonClubAuthResult);
      w232.writeU8(1); // 1 = success (`sub_4BC337`)
      w232.writeU8(playerIdx);
      w232.writeString(clubId);
      session.sendPacket(w232);
      break;
    }

    case ClientOpcode.ShopIdentifyQMark: {
      // C->S 285 (`sub_536DB3` / `sub_5B76C2`) -> S->C 214 (`sub_5396F0`)
      const rewardLucci = 500;
      if (user) {
        user.lucci += rewardLucci;
        state.db.updateUserCurrency(user.id, user.lucci, user.cash);
      }
      const w214 = new PacketWriter(ServerOpcode.ShopQMarkResult);
      w214.writeU32(2); // type 2 = Lucci reward (`sub_5396F0`)
      w214.writeU32(rewardLucci);
      w214.writeU32(0);
      session.sendPacket(w214);
      break;
    }

    case ClientOpcode.RedeemCouponCode: {
      // C->S 286 (`CCouponDlg::sub_5B6215`: `[u32 couponTypeOrId]`) -> S->C 204 (`sub_53A6F1`)
      const rewardCode = reader.remaining >= 4 ? reader.readU32() || 1002 : 1002;
      if (user) {
        state.db.addStockItem(user.id, rewardCode, 1, 0);
      }
      const w204 = new PacketWriter(ServerOpcode.ShopCouponResult);
      w204.writeU8(1); // 1 = coupon redeemed (`sub_53A6F1`)
      w204.writeU32(1); // itemCount = 1
      w204.writeVariantTime();
      w204.writeU32(rewardCode);
      w204.writeU32(1); // count = 1
      w204.writeU32(30); // validDays = 30
      w204.writeU32(0);
      session.sendPacket(w204);

      session.sendPacket(buildInventoryPacket(state, session, ServerOpcode.InventoryUpdate));
      break;
    }

    case ClientOpcode.ShopSaveSlotOrder:
    case ClientOpcode.ShopStateSync:
    case ClientOpcode.GachaponClose:
    case ClientOpcode.AckGiftDelivery:
    case ClientOpcode.BasketOpen:
    case ClientOpcode.BasketThrowAway:
    case ClientOpcode.ShopActionNotify: {
      break;
    }

    case ClientOpcode.GachaponRoll: {
      // C->S 307 (`CGachaponDlg::sub_5C3330`: `[u32 couponStockId]`) -> S->C 257 (`sub_5C23DB`) + S->C 255 (`sub_53BBD8`)
      const couponStockId = reader.remaining >= 4 ? reader.readU32() : 1001;
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
      // C->S 313 (`CBasketDlg::sub_5C0C05`) -> S->C 258 (`sub_5C261E`) + S->C 259 (`sub_5C0289`)
      session.sendPacket(buildBasketInfoPacket258());
      session.sendPacket(buildBasketCouponCountsPacket259(session));
      break;
    }

    case ClientOpcode.BasketQueryCoupons: {
      // C->S 314 (`CBasketDlg::sub_5C0C05`: `[u8 playerIdx]`) -> S->C 259 (`sub_5C0289`) + S->C 260
      session.sendPacket(buildBasketCouponCountsPacket259(session));
      const w260 = new PacketWriter(ServerOpcode.BasketCouponCounts);
      w260.writeU32(0);
      session.sendPacket(w260);
      break;
    }

    case ClientOpcode.RequestUserMarketConnection: {
      // CShopConnectionMan::sub_529A69 -> S->C 262 (`sub_52A1D2`) + S->C 265 (`sub_4BB408`) -> StageId.UserMarket (20)
      session.stageId = StageId.UserMarket;
      const w262 = new PacketWriter(ServerOpcode.UserMarketPermission);
      w262.writeU8(1); // 1 = allowed -> transitions to Stage 20
      session.sendPacket(w262);

      session.sendPacket(buildUserMarketFeeInfoPacket265());
      break;
    }

    case ClientOpcode.UserMarketSearch320: {
      // C->S 320:
      // - Empty (`CShopConnectionMan::sub_529A9A` / `CStage::sub_4BB408`): Enter UserMarket (`S->C 269 [u8(1)]`)
      // - With search params: `S->C 270`
      if (reader.remaining === 0) {
        session.stageId = StageId.UserMarket;
        const w269 = new PacketWriter(ServerOpcode.UserMarketEnterResult);
        w269.writeU8(1); // 1 = enter UserMarket (`CStage::sub_4BC642`)
        session.sendPacket(w269);
        break;
      }

      const tab = reader.readU8();
      const w270 = new PacketWriter(ServerOpcode.UserMarketListingPage);
      w270.writeU8(tab);
      w270.writeU8(1); // 1 = success (`sub_56AD64`)
      w270.writeU16(1); // totalPages
      w270.writeU16(0); // curPage
      w270.writeU8(0); // count = 0
      session.sendPacket(w270);
      break;
    }

    case ClientOpcode.UserMarketDetail321: {
      // C->S 321:
      // - Empty (`CUserMarketStage::sub_573B0A`): Leave UserMarket -> `S->C 99 (StageId.Lobby)`
      // - With `u32 listingId`: `S->C 271`
      if (reader.remaining === 0) {
        session.stageId = StageId.Lobby;
        const w99 = new PacketWriter(ServerOpcode.ShopLeaveReturnStage);
        w99.writeU16(StageId.Lobby);
        session.sendPacket(w99);
        break;
      }

      const listingId = reader.readU32();
      const w271 = new PacketWriter(ServerOpcode.UserMarketListingDetail);
      w271.writeU32(listingId);
      w271.writeString(user?.username ?? "Seller");
      w271.writeString("");
      w271.writeU16(1);
      w271.writeU32(0);
      session.sendPacket(w271);
      break;
    }

    case ClientOpcode.UserMarketBuy322: {
      const _tab = reader.remaining >= 1 ? reader.readU8() : 0;
      const listingId = reader.remaining >= 4 ? reader.readU32() : 0;
      const w272 = new PacketWriter(ServerOpcode.UserMarketBuyResult);
      w272.writeU8(1);
      w272.writeU32(listingId);
      session.sendPacket(w272);
      break;
    }

    case ClientOpcode.UserMarketMyListings324: {
      // C->S 324:
      // - With `[u8 playerIdx]` (`CMarketSlotWnd::sub_5707D8`):
      //   Sends `S->C 270` (`maxLucci`), `S->C 271` (`marketLucci`), `S->C 280` (`tradeableItems`), `S->C 272` (`listings`), `S->C 274`
      if (reader.remaining >= 1) {
        reader.readU8(); // playerIdx
        const w270 = new PacketWriter(ServerOpcode.UserMarketMaxLucci);
        w270.writeU32(2_000_000);
        session.sendPacket(w270);

        const w271 = new PacketWriter(ServerOpcode.UserMarketBalance);
        w271.writeU32(user?.marketLucci ?? user?.lucci ?? 50_000);
        session.sendPacket(w271);

        const stock = user ? state.db.getUserStock(user.id) : [];
        const w280 = new PacketWriter(ServerOpcode.UserMarketTradeableItems);
        w280.writeI32(stock.length);
        for (const s of stock) {
          w280.writeU32(s.itemCode);
        }
        session.sendPacket(w280);

        session.sendPacket(buildMarketListPacket272(state));
      }

      const w274 = new PacketWriter(ServerOpcode.UserMarketMyListings);
      w274.writeU8(1);
      w274.writeU8(0);
      session.sendPacket(w274);
      break;
    }

    case ClientOpcode.UserMarketCancel325: {
      // C->S 325:
      // - With `[u8 type, str query]` (`CMarketSlotWnd::sub_570BD3`): search market listings (`S->C 272`)
      // - Also sends `S->C 275`
      if (reader.remaining >= 3) {
        const _searchType = reader.readU8();
        const query = reader.readString();
        session.sendPacket(buildMarketListPacket272(state, query));
        break;
      }

      const w275 = new PacketWriter(ServerOpcode.UserMarketCancelResult);
      w275.writeU8(1);
      session.sendPacket(w275);
      break;
    }

    case ClientOpcode.UserMarketLeave326: {
      // C->S 326:
      // - With `[u32 stockId, u32 price]` (`CRegisterItemDlg::sub_5767AD`): Register item on market -> `S->C 273` (`sub_56EE29`)
      // - Empty: Leave UserMarket -> `S->C 99 (StageId.Lobby)`
      if (reader.remaining >= 8) {
        const stockId = reader.readU32();
        const price = reader.readU32();
        if (user) {
          state.db.createMarketListing(user.id, user.username, stockId, price);
        }
        const w273 = new PacketWriter(ServerOpcode.UserMarketRegisterResult);
        w273.writeU16(0); // 0 = registered (`sub_56EE29`)
        w273.writeU32(stockId);
        session.sendPacket(w273);

        session.sendPacket(buildMarketListPacket272(state));
        session.sendPacket(buildMarketMySalesPacket275(state, session));
        break;
      }

      session.stageId = StageId.Lobby;
      const w99 = new PacketWriter(ServerOpcode.ShopLeaveReturnStage);
      w99.writeU16(StageId.Lobby);
      session.sendPacket(w99);
      break;
    }

    case ClientOpcode.UserMarketCancelListing: {
      // C->S 327 (`CMarketSlotWnd::sub_5716AB`: `[u32 listingId]`) -> S->C 274 (`sub_56F04F`)
      const listingId = reader.remaining >= 4 ? reader.readU32() : 0;
      const cancelled = state.db.cancelMarketListing(listingId, user?.id);
      const w274 = new PacketWriter(ServerOpcode.UserMarketCancelResult274);
      w274.writeU16(0); // 0 = cancelled (`sub_56F04F`)
      w274.writeU32(cancelled?.itemCode ?? 1001);
      session.sendPacket(w274);

      session.sendPacket(buildMarketListPacket272(state));
      session.sendPacket(buildMarketMySalesPacket275(state, session));
      break;
    }

    case ClientOpcode.ShopBalanceQuery328: {
      // C->S 328:
      // - In Stage 20 (`CMarketSlotWnd::sub_570D80`): sends `S->C 275` (`buildMarketMySalesPacket275`)
      // - Also sends `S->C 278` + `S->C 279`
      if (session.stageId === StageId.UserMarket) {
        session.sendPacket(buildMarketMySalesPacket275(state, session));
      }
      const cash = user?.cash ?? 0;
      const lucci = user?.lucci ?? 0;
      const w278 = new PacketWriter(ServerOpcode.ShopCashBalance);
      w278.writeU32(cash);
      session.sendPacket(w278);

      const w279 = new PacketWriter(ServerOpcode.ShopLucciBalance);
      w279.writeU32(lucci);
      session.sendPacket(w279);
      break;
    }

    case ClientOpcode.UserMarketTransferLucci: {
      // C->S 329 (`CChangeLucciDlg::sub_575DF9`: `[u8 direction, u32 amount]`) -> S->C 276 (`sub_56F8C4`)
      const direction = reader.remaining >= 1 ? reader.readU8() : 1;
      const amount = reader.remaining >= 4 ? reader.readU32() : 0;
      let userLucci = user?.lucci ?? 0;
      let marketLucci = user?.marketLucci ?? userLucci;

      if (user) {
        const updated = state.db.transferMarketLucci(user.id, direction, amount);
        if (updated) {
          user.lucci = updated.lucci;
          user.marketLucci = updated.marketLucci;
          userLucci = updated.lucci;
          marketLucci = updated.marketLucci ?? updated.lucci;
        }
      }

      const w276 = new PacketWriter(ServerOpcode.UserMarketTransferResult);
      w276.writeU16(0); // 0 = transfer success (`sub_56F8C4`)
      w276.writeU32(userLucci);
      w276.writeU32(marketLucci);
      session.sendPacket(w276);
      break;
    }

    case ClientOpcode.UserMarketBuyListing: {
      // C->S 330 (`CUserMarketBuyDlg::sub_577E71`: `[u32 listingId]`) -> S->C 277 (`sub_56FB09`)
      const listingId = reader.remaining >= 4 ? reader.readU32() : 0;
      let stockId = 1001;
      let remainMarketLucci = user?.marketLucci ?? user?.lucci ?? 0;

      if (user) {
        const bought = state.db.buyMarketListing(listingId, user.id);
        if (bought) {
          stockId = bought.listing.itemCode;
          remainMarketLucci = bought.buyer.marketLucci ?? bought.buyer.lucci;
          user.marketLucci = remainMarketLucci;
        }
      }

      const w277 = new PacketWriter(ServerOpcode.UserMarketPurchaseResult);
      w277.writeU16(0); // 0 = purchase success (`sub_56FB09`)
      w277.writeU32(stockId);
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

    case ClientOpcode.RequestStringTableOrBalance: {
      // C->S 278: `sub_59449A` requests `stringtable.ini` (`S->C 200` `sub_4B95F7`),
      // and balance queries expect `S->C 278` (cash) + `S->C 279` (lucci)
      const cash = user?.cash ?? 0;
      const lucci = user?.lucci ?? 0;

      const w278 = new PacketWriter(ServerOpcode.ShopCashBalance);
      w278.writeU32(cash);
      session.sendPacket(w278);

      const w279 = new PacketWriter(ServerOpcode.ShopLucciBalance);
      w279.writeU32(lucci);
      session.sendPacket(w279);

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

    case ClientOpcode.QueryAvatarLucciSync: {
      const localIdx = reader.remaining >= 1 ? reader.readU8() : 0;
      const u = session.users[localIdx] ?? session.users[0];
      if (u) {
        const w186 = new PacketWriter(ServerOpcode.LucciSync);
        w186.writeU32(localIdx);
        w186.writeU32(u.lucci);
        session.sendPacket(w186);
      }
      break;
    }
  }
}
