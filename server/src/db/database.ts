import { Database, type Statement } from "bun:sqlite";
import { migrateDatabase } from "./migrations.ts";

export interface UserRecord {
  id: number;
  username: string;
  nickname: string;
  password: string;
  gender: number;
  level: number;
  exp: number;
  wins: number;
  draws: number;
  losses: number;
  lucci: number;
  cash: number;
  marketLucci?: number;
  rankGrade?: number;
  grade: number;
  rankFlag: number;
  ladderPoints?: number;
  isGm?: number;
  equippedChar: number;
  guildName: string;
  guildMark: number;
}

export interface InventoryItemRecord {
  id: number;
  userId: number;
  packageId: number;
  itemId: number;
  quantity: number;
  equippedSlot: number;
  expireTime: number;
  customText: string;
  remainUnits: number;
  marketStatus: number;
}

export interface StockEntry {
  id: number;
  userId: number;
  itemCode: number;
  quantity: number;
  equipped: number;
  expireTs: number;
  customText?: string;
  remainUnits?: number;
  marketStatus?: number;
}

export interface GiftRecord {
  id: number;
  receiverUserId: number;
  senderName: string;
  packageId: number;
  itemId: number;
  title: string;
  message: string;
  claimed: number;
  createdAt: number;
}

export interface SmsRecord {
  id: number;
  receiverUserId: number;
  senderName: string;
  message: string;
  isRead: number;
  createdAt: number;
}

export interface CoupleRecord {
  userId: number;
  partnerUserId: number;
  partnerName: string;
  coupleGrade: number;
  createdAt: number;
}

export interface MarketListingRecord {
  id: number;
  sellerUserId: number;
  sellerName: string;
  stockId: number;
  itemCode: number;
  price: number;
  status: number; // 0 = active, 1 = sold, 2 = cancelled
  createdAt: number;
}

/**
 * Deterministic level curve for CrazyArcade (`CUser::sub_4A49D5`, levels 1..400).
 * Ensures `minExp(level) <= exp < maxExp(level)` for all progress bar calculations
 * in `CLobbyStage::sub_4C6A99`, `CStage::sub_4BBDB4`, and `CGameStage::sub_4F2F8B`.
 */
export function getLevelBounds(expOrLevel: number): {
  level: number;
  minExp: number;
  maxExp: number;
} {
  const safeVal = Math.max(0, expOrLevel);
  let level = 1;
  let minExp = 0;
  let step = 100;
  while (level < 400 && safeVal >= minExp + step) {
    minExp += step;
    level += 1;
    step = 100 + (level - 1) * 50;
  }
  return {
    level,
    minExp,
    maxExp: minExp + step,
  };
}

/**
 * Modern `bun:sqlite` persistence layer utilizing:
 * - `{ create: true, strict: true }` named parameter binding (`$username`, `$userId`, etc.)
 * - SQLite `RETURNING *` clauses for single-roundtrip mutations
 * - Cached prepared statements (`db.query<Row, Params>(...)`)
 * - Atomic `db.transaction(...)` blocks
 * - Explicit Resource Management (`[Symbol.dispose]()` for `using db = new GameDatabase()`)
 */
export class GameDatabase implements Disposable {
  public readonly db: Database;

  private readonly selectUserByUsernameStmt: Statement<UserRecord, [{ username: string }]>;
  private readonly selectUserByIdStmt: Statement<UserRecord, [{ id: number }]>;
  private readonly insertUserStmt: Statement<
    UserRecord,
    [{ username: string; nickname: string; password: string; gender: number }]
  >;
  private readonly updateStatsStmt: Statement<
    UserRecord,
    [
      {
        id: number;
        level: number;
        exp: number;
        lucci: number;
        wins: number;
        losses: number;
        draws: number;
      },
    ]
  >;
  private readonly updateEquippedCharStmt: Statement<
    unknown,
    [{ id: number; equippedChar: number }]
  >;
  private readonly updateCurrencyStmt: Statement<
    UserRecord,
    [{ id: number; lucci: number; cash: number }]
  >;
  private readonly updateMarketLucciStmt: Statement<
    UserRecord,
    [{ id: number; lucci: number; marketLucci: number }]
  >;
  private readonly updateGuildStmt: Statement<
    UserRecord,
    [{ id: number; guildName: string; guildMark: number }]
  >;
  private readonly selectInventoryByUserStmt: Statement<
    InventoryItemRecord,
    [{ userId: number }]
  >;
  private readonly insertInventoryStmt: Statement<
    InventoryItemRecord,
    [
      {
        userId: number;
        packageId: number;
        itemId: number;
        quantity: number;
        equippedSlot: number;
        expireTime: number;
        customText: string;
        remainUnits: number;
        marketStatus: number;
      },
    ]
  >;
  private readonly updateItemEquippedStmt: Statement<
    unknown,
    [{ userId: number; itemId: number; equipped: number }]
  >;
  private readonly updateItemCustomTextStmt: Statement<
    unknown,
    [{ userId: number; itemId: number; customText: string }]
  >;
  private readonly deleteInventoryItemStmt: Statement<
    unknown,
    [{ userId: number; itemId: number }]
  >;
  private readonly clearUserEquippedStmt: Statement<unknown, [{ userId: number }]>;
  private readonly setInventoryRowEquippedStmt: Statement<
    unknown,
    [{ id: number; equippedSlot: number }]
  >;
  private readonly insertGiftStmt: Statement<
    GiftRecord,
    [
      {
        receiverUserId: number;
        senderName: string;
        packageId: number;
        itemId: number;
        title: string;
        message: string;
        createdAt: number;
      },
    ]
  >;
  private readonly selectGiftsByUserStmt: Statement<GiftRecord, [{ receiverUserId: number }]>;
  private readonly insertSmsStmt: Statement<
    SmsRecord,
    [{ receiverUserId: number; senderName: string; message: string; createdAt: number }]
  >;
  private readonly selectSmsByUserStmt: Statement<SmsRecord, [{ receiverUserId: number }]>;
  private readonly hasUnreadSmsStmt: Statement<{ hasUnread: number }, [{ receiverUserId: number }]>;
  private readonly deleteSmsByIdStmt: Statement<
    unknown,
    [{ id: number; receiverUserId: number }]
  >;
  private readonly deleteAllSmsByUserStmt: Statement<unknown, [{ receiverUserId: number }]>;
  private readonly selectCoupleStmt: Statement<CoupleRecord, [{ userId: number }]>;
  private readonly upsertCoupleStmt: Statement<
    CoupleRecord,
    [
      {
        userId: number;
        partnerUserId: number;
        partnerName: string;
        coupleGrade: number;
        createdAt: number;
      },
    ]
  >;
  private readonly deleteCoupleStmt: Statement<unknown, [{ userId: number }]>;
  private readonly insertMarketListingStmt: Statement<
    MarketListingRecord,
    [
      {
        sellerUserId: number;
        sellerName: string;
        stockId: number;
        itemCode: number;
        price: number;
        createdAt: number;
      },
    ]
  >;
  private readonly selectActiveMarketListingsStmt: Statement<MarketListingRecord, []>;
  private readonly selectMarketListingsBySellerStmt: Statement<
    MarketListingRecord,
    [{ sellerUserId: number }]
  >;
  private readonly selectMarketListingByIdStmt: Statement<
    MarketListingRecord,
    [{ id: number }]
  >;
  private readonly updateMarketListingStatusStmt: Statement<
    MarketListingRecord,
    [{ id: number; status: number }]
  >;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.initSchema();

    this.selectUserByUsernameStmt = this.db.query(
      `SELECT * FROM users WHERE username = $username LIMIT 1`
    );
    this.selectUserByIdStmt = this.db.query(`SELECT * FROM users WHERE id = $id LIMIT 1`);
    this.insertUserStmt = this.db.query(
      `INSERT INTO users (
         username, nickname, password, gender, level, exp, wins, draws, losses,
         lucci, cash, marketLucci, rankGrade, grade, rankFlag, ladderPoints, isGm, equippedChar, guildName, guildMark
       )
       VALUES ($username, $nickname, $password, $gender, 1, 0, 0, 0, 0, 50000, 10000, 50000, 1, 0, 0, 1000, 0, 0, '', 0)
       RETURNING *`
    );
    this.updateStatsStmt = this.db.query(
      `UPDATE users
       SET level = $level, exp = $exp, lucci = $lucci, wins = $wins, losses = $losses, draws = $draws
       WHERE id = $id
       RETURNING *`
    );
    this.updateEquippedCharStmt = this.db.query(
      `UPDATE users SET equippedChar = $equippedChar WHERE id = $id`
    );
    this.updateCurrencyStmt = this.db.query(
      `UPDATE users SET lucci = $lucci, cash = $cash WHERE id = $id RETURNING *`
    );
    this.updateMarketLucciStmt = this.db.query(
      `UPDATE users SET lucci = $lucci, marketLucci = $marketLucci WHERE id = $id RETURNING *`
    );
    this.updateGuildStmt = this.db.query(
      `UPDATE users SET guildName = $guildName, guildMark = $guildMark WHERE id = $id RETURNING *`
    );
    this.selectInventoryByUserStmt = this.db.query(
      `SELECT * FROM inventory WHERE userId = $userId ORDER BY id ASC`
    );
    this.insertInventoryStmt = this.db.query(
      `INSERT INTO inventory (
         userId, packageId, itemId, quantity, equippedSlot, expireTime, customText, remainUnits, marketStatus
       )
       VALUES (
         $userId, $packageId, $itemId, $quantity, $equippedSlot, $expireTime, $customText, $remainUnits, $marketStatus
       )
       RETURNING *`
    );
    this.updateItemEquippedStmt = this.db.query(
      `UPDATE inventory SET equippedSlot = $equipped WHERE userId = $userId AND itemId = $itemId`
    );
    this.updateItemCustomTextStmt = this.db.query(
      `UPDATE inventory SET customText = $customText WHERE userId = $userId AND itemId = $itemId`
    );
    this.deleteInventoryItemStmt = this.db.query(
      `DELETE FROM inventory
       WHERE id = (
         SELECT id FROM inventory
         WHERE userId = $userId AND itemId = $itemId
         ORDER BY id ASC
         LIMIT 1
       )`
    );
    this.clearUserEquippedStmt = this.db.query(
      `UPDATE inventory SET equippedSlot = 0 WHERE userId = $userId`
    );
    this.setInventoryRowEquippedStmt = this.db.query(
      `UPDATE inventory SET equippedSlot = $equippedSlot WHERE id = $id`
    );

    this.insertGiftStmt = this.db.query(
      `INSERT INTO user_gifts (receiverUserId, senderName, packageId, itemId, title, message, claimed, createdAt)
       VALUES ($receiverUserId, $senderName, $packageId, $itemId, $title, $message, 0, $createdAt)
       RETURNING *`
    );
    this.selectGiftsByUserStmt = this.db.query(
      `SELECT * FROM user_gifts WHERE receiverUserId = $receiverUserId AND claimed = 0 ORDER BY id DESC`
    );

    this.insertSmsStmt = this.db.query(
      `INSERT INTO user_sms (receiverUserId, senderName, message, isRead, createdAt)
       VALUES ($receiverUserId, $senderName, $message, 0, $createdAt)
       RETURNING *`
    );
    this.selectSmsByUserStmt = this.db.query(
      `SELECT * FROM user_sms WHERE receiverUserId = $receiverUserId ORDER BY id DESC`
    );
    this.hasUnreadSmsStmt = this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM user_sms
         WHERE receiverUserId = $receiverUserId AND isRead = 0
       ) AS hasUnread`
    );
    this.deleteSmsByIdStmt = this.db.query(
      `DELETE FROM user_sms WHERE id = $id AND receiverUserId = $receiverUserId`
    );
    this.deleteAllSmsByUserStmt = this.db.query(
      `DELETE FROM user_sms WHERE receiverUserId = $receiverUserId`
    );

    this.selectCoupleStmt = this.db.query(
      `SELECT * FROM user_couples WHERE userId = $userId LIMIT 1`
    );
    this.upsertCoupleStmt = this.db.query(
      `INSERT INTO user_couples (userId, partnerUserId, partnerName, coupleGrade, createdAt)
       VALUES ($userId, $partnerUserId, $partnerName, $coupleGrade, $createdAt)
       ON CONFLICT(userId) DO UPDATE SET
         partnerUserId = excluded.partnerUserId,
         partnerName = excluded.partnerName,
         coupleGrade = excluded.coupleGrade,
         createdAt = excluded.createdAt
       RETURNING *`
    );
    this.deleteCoupleStmt = this.db.query(`DELETE FROM user_couples WHERE userId = $userId`);

    this.insertMarketListingStmt = this.db.query(
      `INSERT INTO market_listings (sellerUserId, sellerName, stockId, itemCode, price, status, createdAt)
       VALUES ($sellerUserId, $sellerName, $stockId, $itemCode, $price, 0, $createdAt)
       RETURNING *`
    );
    this.selectActiveMarketListingsStmt = this.db.query(
      `SELECT * FROM market_listings WHERE status = 0 ORDER BY id DESC`
    );
    this.selectMarketListingsBySellerStmt = this.db.query(
      `SELECT * FROM market_listings WHERE sellerUserId = $sellerUserId AND status = 0 ORDER BY id DESC`
    );
    this.selectMarketListingByIdStmt = this.db.query(
      `SELECT * FROM market_listings WHERE id = $id LIMIT 1`
    );
    this.updateMarketListingStatusStmt = this.db.query(
      `UPDATE market_listings SET status = $status WHERE id = $id RETURNING *`
    );
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
    `);
    migrateDatabase(this.db);
  }

  public getUserByUsername(username: string): UserRecord | null {
    return this.selectUserByUsernameStmt.get({ username }) ?? null;
  }

  public getUserById(id: number): UserRecord | null {
    return this.selectUserByIdStmt.get({ id }) ?? null;
  }

  public createUser(username: string, password: string, gender: number = 0): UserRecord {
    const existing = this.getUserByUsername(username);
    if (existing) {
      return existing;
    }

    const createTx = this.db.transaction(() => {
      const created = this.insertUserStmt.get({
        username,
        nickname: username,
        password,
        gender,
      })!;
      // Starter decorative item in stock
      this.insertInventoryStmt.get({
        userId: created.id,
        packageId: 1001,
        itemId: 1001,
        quantity: 1,
        equippedSlot: 1,
        expireTime: 0,
        customText: "",
        remainUnits: 30,
        marketStatus: 0,
      });
      return created;
    });

    return createTx();
  }

  /**
   * Local reconstruction adapter used by the current C->S 2 / 11 / 31 login paths.
   * Missing-user auto-creation is demo policy, not confirmed official-server behavior;
   * unresolved C->S 18 is deliberately not routed through this method.
   */
  public authenticateOrCreate(
    username: string,
    password: string,
    autoCreate: boolean = true
  ): { status: "ok" | "wrong_password" | "not_found"; user: UserRecord | null } {
    let user = this.getUserByUsername(username);
    if (!user) {
      if (!autoCreate) {
        return { status: "not_found", user: null };
      }
      user = this.createUser(username, password, 0);
      return { status: "ok", user };
    }
    if (password.length > 0 && user.password.length > 0 && user.password !== password) {
      return { status: "wrong_password", user: null };
    }
    return { status: "ok", user };
  }

  public updateMatchStats(
    userId: number,
    outcome: "win" | "lose" | "draw",
    expGain: number,
    lucciGain: number
  ): {
    user: UserRecord;
    expDiff: number;
    lucciDiff: number;
    newLevel: number;
  } {
    const current = this.getUserById(userId);
    if (!current) {
      throw new Error(`User ${userId} not found`);
    }
    const newExp = Math.max(0, current.exp + expGain);
    const bounds = getLevelBounds(newExp);
    const newLucci = Math.max(0, current.lucci + lucciGain);
    const wins = current.wins + (outcome === "win" ? 1 : 0);
    const losses = current.losses + (outcome === "lose" ? 1 : 0);
    const draws = current.draws + (outcome === "draw" ? 1 : 0);

    const updated = this.updateStatsStmt.get({
      id: userId,
      level: bounds.level,
      exp: newExp,
      lucci: newLucci,
      wins,
      losses,
      draws,
    })!;

    return {
      user: updated,
      expDiff: expGain,
      lucciDiff: lucciGain,
      newLevel: bounds.level,
    };
  }

  public updateUserStats(
    userId: number,
    level: number,
    exp: number,
    lucci: number,
    wins: number,
    losses: number,
    draws: number
  ): UserRecord | null {
    return (
      this.updateStatsStmt.get({
        id: userId,
        level,
        exp,
        lucci,
        wins,
        losses,
        draws,
      }) ?? null
    );
  }

  public updateEquippedChar(userId: number, equippedChar: number): void {
    this.updateEquippedCharStmt.run({ id: userId, equippedChar });
  }

  public updateUserGuild(
    userId: number,
    guildName: string,
    guildMark: number = 0
  ): UserRecord | null {
    return this.updateGuildStmt.get({ id: userId, guildName, guildMark }) ?? null;
  }

  public updateBalances(userId: number, cash: number, lucci: number): UserRecord {
    return this.updateCurrencyStmt.get({
      id: userId,
      lucci: Math.max(0, lucci),
      cash: Math.max(0, cash),
    })!;
  }

  public updateUserCurrency(userId: number, lucci: number, cash: number): UserRecord | null {
    return (
      this.updateCurrencyStmt.get({
        id: userId,
        lucci: Math.max(0, lucci),
        cash: Math.max(0, cash),
      }) ?? null
    );
  }

  public getInventory(userId: number): InventoryItemRecord[] {
    return this.selectInventoryByUserStmt.all({ userId });
  }

  public getUserStock(userId: number): StockEntry[] {
    return Iterator.from(this.getInventory(userId))
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        itemCode: row.itemId,
        quantity: row.quantity,
        equipped: row.equippedSlot,
        expireTs: row.expireTime,
        customText: row.customText,
        remainUnits: row.remainUnits,
        marketStatus: row.marketStatus,
      }))
      .toArray();
  }

  public addInventoryItem(
    userId: number,
    packageId: number,
    itemId: number,
    quantity: number = 1,
    equippedSlot: number = 0,
    expireTime: number = 0,
    customText: string = "",
    remainUnits: number = 30,
    marketStatus: number = 0
  ): InventoryItemRecord {
    return this.insertInventoryStmt.get({
      userId,
      packageId,
      itemId,
      quantity,
      equippedSlot,
      expireTime,
      customText,
      remainUnits,
      marketStatus,
    })!;
  }

  public addStockItem(
    userId: number,
    itemCode: number,
    quantity: number = 1,
    equipped: number = 0,
    customText: string = ""
  ): number {
    return this.addInventoryItem(
      userId,
      itemCode,
      itemCode,
      quantity,
      equipped,
      0,
      customText
    ).id;
  }

  /**
   * Executes one local-demo shop purchase atomically: spend Lucci first, fall back to Cash,
   * and create one inventory row only when the account can pay. The fixture amount is supplied
   * by the caller and is not an official Taiwan shop price.
   */
  public purchaseStockItem(userId: number, itemCode: number, price: number): UserRecord | null {
    const safePrice = Math.max(0, Math.trunc(price));
    const tx = this.db.transaction(() => {
      const user = this.getUserById(userId);
      if (!user) return null;

      let lucci = user.lucci;
      let cash = user.cash;
      if (lucci >= safePrice) {
        lucci -= safePrice;
      } else if (cash >= safePrice) {
        cash -= safePrice;
      } else {
        return null;
      }

      const updatedUser = this.updateCurrencyStmt.get({ id: userId, lucci, cash });
      if (!updatedUser) return null;

      this.addInventoryItem(userId, itemCode, itemCode, 1, 1, 0);
      return updatedUser;
    });
    return tx();
  }

  public setStockEquipped(userId: number, itemCode: number, equipped: number): void {
    if (equipped > 0) {
      this.db
        .query(
          `UPDATE inventory SET equippedSlot = 0 WHERE userId = $userId AND equippedSlot = $equipped`
        )
        .run({ userId, equipped });
    }
    this.updateItemEquippedStmt.run({ userId, itemId: itemCode, equipped });
  }

  public updateStockCustomText(userId: number, itemCode: number, customText: string): void {
    this.updateItemCustomTextStmt.run({ userId, itemId: itemCode, customText });
  }

  public deleteStockItem(userId: number, itemCode: number): number {
    return this.deleteInventoryItemStmt.run({ userId, itemId: itemCode }).changes;
  }

  /**
   * Local reconstruction policy: match the supplied fixture item code to `inventory.itemId`,
   * delete one oldest matching row, and refund only after one row is actually removed. The
   * C->S 283 client-key-to-database mapping is unverified; this is not a claim that the key is
   * the inventory table's primary key.
   */
  public resellStockItem(
    userId: number,
    itemCode: number,
    refundLucci: number
  ): UserRecord | null {
    const tx = this.db.transaction(() => {
      const user = this.getUserById(userId);
      if (!user) return null;

      const deletion = this.deleteInventoryItemStmt.run({ userId, itemId: itemCode });
      if (deletion.changes !== 1) return null;

      return this.updateCurrencyStmt.get({
        id: userId,
        lucci: user.lucci + Math.max(0, refundLucci),
        cash: user.cash,
      }) ?? null;
    });
    return tx();
  }

  public setEquippedItems(userId: number, equippedItemIds: number[]): void {
    const equipSet = new Set(equippedItemIds);
    const tx = this.db.transaction(() => {
      this.clearUserEquippedStmt.run({ userId });
      for (const item of this.getInventory(userId)) {
        if (equipSet.has(item.itemId)) {
          this.setInventoryRowEquippedStmt.run({ id: item.id, equippedSlot: 1 });
        }
      }
    });
    tx();
  }

  public createGift(
    receiverUserId: number,
    senderName: string,
    packageId: number,
    itemId: number,
    title: string = "",
    message: string = ""
  ): GiftRecord {
    return this.insertGiftStmt.get({
      receiverUserId,
      senderName,
      packageId,
      itemId,
      title,
      message,
      createdAt: Date.now(),
    })!;
  }

  public getGiftsByUser(userId: number): GiftRecord[] {
    return this.selectGiftsByUserStmt.all({ receiverUserId: userId });
  }

  public sendSms(receiverUserId: number, senderName: string, message: string): SmsRecord {
    return this.insertSmsStmt.get({
      receiverUserId,
      senderName,
      message,
      createdAt: Date.now(),
    })!;
  }

  public getSmsByUser(userId: number): SmsRecord[] {
    return this.selectSmsByUserStmt.all({ receiverUserId: userId });
  }

  public deleteSms(userId: number, msgId: number): void {
    this.deleteSmsByIdStmt.run({ id: msgId, receiverUserId: userId });
  }

  public deleteAllSms(userId: number): void {
    this.deleteAllSmsByUserStmt.run({ receiverUserId: userId });
  }

  public hasUnreadSms(userId: number): boolean {
    return this.hasUnreadSmsStmt.get({ receiverUserId: userId })?.hasUnread === 1;
  }

  public getCoupleInfo(userId: number): CoupleRecord | null {
    return this.selectCoupleStmt.get({ userId }) ?? null;
  }

  public setCouple(
    userAId: number,
    userAName: string,
    userBId: number,
    userBName: string,
    grade: number = 1
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.upsertCoupleStmt.get({
        userId: userAId,
        partnerUserId: userBId,
        partnerName: userBName,
        coupleGrade: grade,
        createdAt: now,
      });
      this.upsertCoupleStmt.get({
        userId: userBId,
        partnerUserId: userAId,
        partnerName: userAName,
        coupleGrade: grade,
        createdAt: now,
      });
    });
    tx();
  }

  public breakupCouple(userId: number): CoupleRecord | null {
    const existing = this.getCoupleInfo(userId);
    if (!existing) return null;
    const tx = this.db.transaction(() => {
      this.deleteCoupleStmt.run({ userId });
      this.deleteCoupleStmt.run({ userId: existing.partnerUserId });
    });
    tx();
    return existing;
  }

  public createMarketListing(
    sellerUserId: number,
    sellerName: string,
    itemCode: number,
    price: number
  ): MarketListingRecord {
    const inv = this.getInventory(sellerUserId);
    const existing = inv.find((r) => r.itemId === itemCode);
    const stockId = existing ? existing.id : this.addStockItem(sellerUserId, itemCode, 1, 0);
    return this.insertMarketListingStmt.get({
      sellerUserId,
      sellerName,
      stockId,
      itemCode,
      price,
      createdAt: Date.now(),
    })!;
  }

  public getActiveMarketListings(searchQuery: string = ""): MarketListingRecord[] {
    const all = this.selectActiveMarketListingsStmt.all();
    if (!searchQuery) return all;
    const q = searchQuery.toLowerCase();
    return all.filter(
      (r) => r.sellerName.toLowerCase().includes(q) || String(r.itemCode).includes(q)
    );
  }

  public getMarketListingsBySeller(sellerUserId: number): MarketListingRecord[] {
    return this.selectMarketListingsBySellerStmt.all({ sellerUserId });
  }

  public cancelMarketListing(
    listingId: number,
    _sellerUserId?: number
  ): MarketListingRecord | null {
    const listing = this.selectMarketListingByIdStmt.get({ id: listingId });
    if (!listing) return null;
    return this.updateMarketListingStatusStmt.get({ id: listingId, status: 2 }) ?? null;
  }

  public buyMarketListing(
    listingId: number,
    buyerUserId: number
  ): { listing: MarketListingRecord; buyer: UserRecord } | null {
    const listing = this.selectMarketListingByIdStmt.get({ id: listingId });
    const buyer = this.getUserById(buyerUserId);
    if (!listing || !buyer || listing.status !== 0) {
      return null;
    }

    const tx = this.db.transaction(() => {
      const updatedListing = this.updateMarketListingStatusStmt.get({
        id: listingId,
        status: 1,
      })!;
      const curMarketLucci = buyer.marketLucci ?? buyer.lucci;
      const newMarketLucci = Math.max(0, curMarketLucci - listing.price);
      const updatedBuyer = this.updateMarketLucciStmt.get({
        id: buyerUserId,
        lucci: buyer.lucci,
        marketLucci: newMarketLucci,
      })!;

      const seller = this.getUserById(listing.sellerUserId);
      if (seller) {
        const sellerMarket = (seller.marketLucci ?? seller.lucci) + listing.price;
        this.updateMarketLucciStmt.get({
          id: seller.id,
          lucci: seller.lucci,
          marketLucci: sellerMarket,
        });
      }

      this.addStockItem(buyerUserId, listing.itemCode, 1, 0);
      return { listing: updatedListing, buyer: updatedBuyer };
    });

    return tx();
  }

  public transferMarketLucci(
    userId: number,
    direction: number,
    amount: number
  ): UserRecord | null {
    const user = this.getUserById(userId);
    if (!user) return null;
    const curMarket = user.marketLucci ?? user.lucci;
    const safeAmt = Math.max(0, amount);
    let newLucci = user.lucci;
    let newMarket = curMarket;
    if (direction === 1) {
      // User Lucci -> Market Lucci (local DB adapter direction; C->S 329 does not encode direction)
      const delta = Math.min(newLucci, safeAmt);
      newLucci -= delta;
      newMarket += delta;
    } else {
      // Market Lucci -> User Lucci
      const delta = Math.min(newMarket, safeAmt);
      newMarket -= delta;
      newLucci += delta;
    }
    return (
      this.updateMarketLucciStmt.get({
        id: userId,
        lucci: newLucci,
        marketLucci: newMarket,
      }) ?? null
    );
  }

  public close(): void {
    this.db.close();
  }

  public [Symbol.dispose](): void {
    this.close();
  }
}
