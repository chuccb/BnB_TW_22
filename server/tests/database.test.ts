import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/db/database.ts";
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from "../src/db/migrations.ts";

describe("GameDatabase inventory transactions", () => {
  test("demo purchase debits and creates stock atomically, and rejects insufficient balance", () => {
    using db = new GameDatabase(":memory:");
    const user = db.createUser("buyer", "test-password");
    const startingStockCount = db.getUserStock(user.id).length;

    const purchased = db.purchaseStockItem(user.id, 3001, 100);
    expect(purchased?.lucci).toBe(user.lucci - 100);
    expect(db.getUserStock(user.id)).toHaveLength(startingStockCount + 1);
    expect(db.getUserStock(user.id).some((item) => item.itemCode === 3001)).toBe(true);

    db.updateUserCurrency(user.id, 0, 0);
    const stockCountBeforeRejectedPurchase = db.getUserStock(user.id).length;
    expect(db.purchaseStockItem(user.id, 3002, 100)).toBeNull();
    expect(db.getUserStock(user.id)).toHaveLength(stockCountBeforeRejectedPurchase);
    expect(db.getUserById(user.id)?.lucci).toBe(0);
    expect(db.getUserById(user.id)?.cash).toBe(0);
  });

  test("resell deletes one matching item and credits only successful sales", () => {
    using db = new GameDatabase(":memory:");
    const user = db.createUser("stock_owner", "test-password");
    db.addStockItem(user.id, 3001);
    db.addStockItem(user.id, 3001);

    const startingLucci = db.getUserById(user.id)!.lucci;
    const firstSale = db.resellStockItem(user.id, 3001, 500);
    expect(firstSale?.lucci).toBe(startingLucci + 500);
    expect(db.getUserStock(user.id).filter((item) => item.itemCode === 3001)).toHaveLength(1);

    const secondSale = db.resellStockItem(user.id, 3001, 500);
    expect(secondSale?.lucci).toBe(startingLucci + 1000);
    expect(db.getUserStock(user.id).filter((item) => item.itemCode === 3001)).toHaveLength(0);

    expect(db.resellStockItem(user.id, 3001, 500)).toBeNull();
    expect(db.deleteStockItem(user.id, 3001)).toBe(0);
    expect(db.getUserById(user.id)?.lucci).toBe(startingLucci + 1000);
  });

  test("UserMarket listing escrow is row-scoped, cancellable, and sold without duplicating stock", () => {
    using db = new GameDatabase(":memory:");
    const seller = db.createUser("market_seller", "test-password");
    const buyer = db.createUser("market_buyer", "test-password");
    const listedStock = db.addInventoryItem(
      seller.id,
      9555,
      4500,
      2,
      0,
      1_700_000_000_000,
      "market text",
      9,
      0
    );
    const duplicateStockId = db.addStockItem(seller.id, 4500);
    const sellerStarting = db.getUserById(seller.id)!;
    const buyerStarting = db.getUserById(buyer.id)!;

    const listing = db.createMarketListing(seller.id, seller.username, 4500, 1250)!;
    expect(listing).toBeDefined();
    expect(listing.stockId).toBe(listedStock.id);
    expect(db.getUserStock(seller.id).find((item) => item.id === listedStock.id)?.marketStatus).toBe(1);
    expect(db.getUserStock(seller.id).find((item) => item.id === duplicateStockId)?.marketStatus).toBe(0);

    // A listing reserves only its referenced inventory.id. Same-code duplicates remain
    // individually addressable by local row ID, while ambiguous itemCode-based resale fails closed.
    expect(db.deleteStockItemById(seller.id, listedStock.id)).toBe(0);
    expect(db.setStockEquippedById(seller.id, listedStock.id, 2)).toBe(false);
    expect(
      db.updateStockCustomTextsByIds(seller.id, [{ stockId: listedStock.id, customText: "blocked" }])
    ).toBe(false);
    expect(db.resellStockItem(seller.id, 4500, 500)).toBeNull();
    expect(db.getUserStock(seller.id).find((item) => item.id === listedStock.id)?.customText).toBe("market text");
    expect(db.getUserStock(seller.id).find((item) => item.id === duplicateStockId)?.equipped).toBe(0);
    expect(db.setStockEquippedById(seller.id, duplicateStockId, 2, "duplicate remains local")).toBe(true);
    expect(db.getUserStock(seller.id).find((item) => item.id === duplicateStockId)).toMatchObject({
      equipped: 2,
      customText: "duplicate remains local",
    });

    const cancelled = db.cancelMarketListing(listing.id, seller.id)!;
    expect(cancelled.status).toBe(2);
    expect(db.getUserStock(seller.id).find((item) => item.id === listedStock.id)?.marketStatus).toBe(0);

    const activeListing = db.createMarketListing(seller.id, seller.username, 4500, 1250)!;
    expect(activeListing.stockId).toBe(listedStock.id);
    db.db.exec(`
      CREATE TRIGGER reject_market_stock_transfer
      BEFORE INSERT ON inventory
      WHEN NEW.userId = ${buyer.id} AND NEW.itemId = 4500
      BEGIN
        SELECT RAISE(ABORT, 'injected market transfer failure');
      END;
    `);

    const sellerStockBeforeFailedSale = db.getUserStock(seller.id);
    const buyerStockBeforeFailedSale = db.getUserStock(buyer.id);
    expect(() => db.buyMarketListing(activeListing.id, buyer.id)).toThrow("injected market transfer failure");
    expect(db.getMarketListingsBySeller(seller.id)).toHaveLength(1);
    expect(db.getMarketListingsBySeller(seller.id)[0]?.id).toBe(activeListing.id);
    expect(db.getUserStock(seller.id)).toEqual(sellerStockBeforeFailedSale);
    expect(db.getUserStock(buyer.id)).toEqual(buyerStockBeforeFailedSale);
    expect(db.getUserById(seller.id)?.marketLucci).toBe(sellerStarting.marketLucci);
    expect(db.getUserById(buyer.id)?.marketLucci).toBe(buyerStarting.marketLucci);

    db.db.exec("DROP TRIGGER reject_market_stock_transfer");
    const purchase = db.buyMarketListing(activeListing.id, buyer.id)!;
    expect(purchase.listing.status).toBe(1);
    expect(purchase.buyer.marketLucci).toBe(buyerStarting.marketLucci! - 1250);
    expect(purchase.seller.marketLucci).toBe(sellerStarting.marketLucci! + 1250);
    expect(purchase.seller.lucci).toBe(sellerStarting.lucci);
    expect(db.getUserStock(seller.id).some((item) => item.id === listedStock.id)).toBe(false);
    expect(db.getUserStock(seller.id).find((item) => item.id === duplicateStockId)).toMatchObject({
      itemCode: 4500,
      equipped: 2,
      customText: "duplicate remains local",
    });
    expect(db.getInventory(buyer.id).filter((item) => item.itemId === 4500)).toHaveLength(1);
    expect(db.getInventory(buyer.id).find((item) => item.itemId === 4500)).toMatchObject({
      packageId: 9555,
      quantity: 2,
      equippedSlot: 0,
      expireTime: 1_700_000_000_000,
      customText: "market text",
      remainUnits: 9,
      marketStatus: 0,
    });
    expect(db.getActiveMarketListings()).toHaveLength(0);

    const sellerStockAfterSale = db.getUserStock(seller.id);
    const buyerStockAfterSale = db.getUserStock(buyer.id);
    expect(db.buyMarketListing(activeListing.id, buyer.id)).toBeNull();
    expect(db.getUserStock(seller.id)).toEqual(sellerStockAfterSale);
    expect(db.getUserStock(buyer.id)).toEqual(buyerStockAfterSale);
    expect(db.getUserById(seller.id)?.marketLucci).toBe(sellerStarting.marketLucci! + 1250);
    expect(db.getUserById(buyer.id)?.marketLucci).toBe(buyerStarting.marketLucci! - 1250);
  });

  test("market purchase fails closed when an active listing no longer owns an un-equipped escrow row", () => {
    using db = new GameDatabase(":memory:");
    const seller = db.createUser("market_invariant_seller", "test-password");
    const buyer = db.createUser("market_invariant_buyer", "test-password");
    const stockId = db.addStockItem(seller.id, 4555);
    const listing = db.createMarketListing(seller.id, seller.username, 4555, 500)!;
    const sellerBefore = db.getUserById(seller.id)!;
    const buyerBefore = db.getUserById(buyer.id)!;
    const buyerStockBefore = db.getUserStock(buyer.id);

    // These direct writes model stale/corrupt local DB state, not a Client request path.
    db.db.query("UPDATE inventory SET marketStatus = 0 WHERE id = ?").run(stockId);
    expect(db.buyMarketListing(listing.id, buyer.id)).toBeNull();
    expect(db.getActiveMarketListings().map((entry) => entry.id)).toContain(listing.id);
    expect(db.getUserStock(seller.id).find((item) => item.id === stockId)?.marketStatus).toBe(0);

    db.db.query("UPDATE inventory SET marketStatus = 1, equippedSlot = 2 WHERE id = ?").run(stockId);
    expect(db.buyMarketListing(listing.id, buyer.id)).toBeNull();
    expect(db.getActiveMarketListings().map((entry) => entry.id)).toContain(listing.id);
    expect(db.getUserStock(seller.id).find((item) => item.id === stockId)).toMatchObject({
      marketStatus: 1,
      equipped: 2,
    });
    expect(db.getUserStock(buyer.id)).toEqual(buyerStockBefore);
    expect(db.getUserById(seller.id)?.marketLucci).toBe(sellerBefore.marketLucci);
    expect(db.getUserById(buyer.id)?.marketLucci).toBe(buyerBefore.marketLucci);
  });

  test("market-currency transfer rejects invalid direction/amount and caps at available balance", () => {
    using db = new GameDatabase(":memory:");
    const user = db.createUser("market_transfer_user", "test-password");
    const before = db.getUserById(user.id)!;

    for (const [direction, amount] of [
      [2, 100],
      [0, -1],
      [0, 1.5],
      [0, Number.NaN],
    ] as const) {
      expect(db.transferMarketLucci(user.id, direction, amount)).toBeNull();
    }
    expect(db.getUserById(user.id)).toEqual(before);

    const transferred = db.transferMarketLucci(user.id, 0, 0xffff_ffff)!;
    expect(transferred.lucci).toBe(before.lucci + (before.marketLucci ?? before.lucci));
    expect(transferred.marketLucci).toBe(0);
  });

  test("shop equip and custom-text batches roll back as one transaction on SQL failure", () => {
    using db = new GameDatabase(":memory:");
    const user = db.createUser("shop_transaction_owner", "test-password");
    const stockIds = new Map<number, number>();
    for (const itemCode of [3001, 3002, 3003, 3004]) {
      stockIds.set(itemCode, db.addStockItem(user.id, itemCode));
    }
    db.setStockEquippedById(user.id, stockIds.get(3001)!, 2, "slot two original");
    db.setStockEquippedById(user.id, stockIds.get(3002)!, 1, "slot one original");

    db.db.exec(`
      CREATE TRIGGER reject_shop_equip_text
      BEFORE UPDATE OF customText ON inventory
      WHEN NEW.itemId = 3002 AND NEW.customText = 'rollback equip'
      BEGIN
        SELECT RAISE(ABORT, 'injected shop equip failure');
      END;
      CREATE TRIGGER reject_shop_batch_text
      BEFORE UPDATE OF customText ON inventory
      WHEN NEW.itemId = 3004 AND NEW.customText = 'rollback batch'
      BEGIN
        SELECT RAISE(ABORT, 'injected shop batch failure');
      END;
      CREATE TRIGGER reject_shop_equip_batch
      BEFORE UPDATE OF equippedSlot ON inventory
      WHEN NEW.itemId = 3004 AND NEW.equippedSlot = 3
      BEGIN
        SELECT RAISE(ABORT, 'injected shop equip-batch failure');
      END;
    `);

    const beforeEquipFailure = db.getUserStock(user.id);
    expect(() => db.setStockEquippedById(user.id, stockIds.get(3002)!, 2, "rollback equip")).toThrow();
    expect(db.getUserStock(user.id)).toEqual(beforeEquipFailure);

    const beforeEquipBatchFailure = db.getUserStock(user.id);
    expect(() =>
      db.setStockEquippedBatchByIds(user.id, [
        { stockId: stockIds.get(3003)!, equipped: 2 },
        { stockId: stockIds.get(3004)!, equipped: 3 },
      ])
    ).toThrow();
    expect(db.getUserStock(user.id)).toEqual(beforeEquipBatchFailure);

    const beforeRejectedOwnershipBatch = db.getUserStock(user.id);
    expect(
      db.setStockEquippedBatchByIds(user.id, [
        { stockId: stockIds.get(3003)!, equipped: 2 },
        { stockId: 0xffff_ffff, equipped: 3 },
      ])
    ).toBe(false);
    expect(db.getUserStock(user.id)).toEqual(beforeRejectedOwnershipBatch);

    const beforeBatchFailure = db.getUserStock(user.id);
    expect(() =>
      db.updateStockCustomTextsByIds(user.id, [
        { stockId: stockIds.get(3003)!, customText: "would partially apply" },
        { stockId: stockIds.get(3004)!, customText: "rollback batch" },
      ])
    ).toThrow();
    expect(db.getUserStock(user.id)).toEqual(beforeBatchFailure);
  });

  test("unread SMS lookup is scoped to the requested recipient", () => {
    using db = new GameDatabase(":memory:");
    const reader = db.createUser("mail_reader", "test-password");
    const otherUser = db.createUser("other_user", "test-password");

    expect(db.hasUnreadSms(reader.id)).toBe(false);
    db.sendSms(otherUser.id, reader.username, "not addressed to reader");
    expect(db.hasUnreadSms(reader.id)).toBe(false);

    db.sendSms(reader.id, otherUser.username, "unread");
    expect(db.hasUnreadSms(reader.id)).toBe(true);

    db.db
      .query("UPDATE user_sms SET isRead = 1 WHERE receiverUserId = $receiverUserId")
      .run({ receiverUserId: reader.id });
    expect(db.hasUnreadSms(reader.id)).toBe(false);
  });
});

describe("SQLite schema migrations", () => {
  test("records the current version and adopts version-zero data in place", () => {
    using db = new GameDatabase(":memory:");
    expect(db.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
      .toBe(CURRENT_SCHEMA_VERSION);
    const user = db.createUser("migration_user", "test-password");

    db.db.exec("PRAGMA user_version = 0");
    migrateDatabase(db.db);

    expect(db.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
      .toBe(CURRENT_SCHEMA_VERSION);
    expect(db.getUserByUsername("migration_user")?.id).toBe(user.id);
    expect(db.getInventory(user.id)).toHaveLength(1);

    migrateDatabase(db.db);
    expect(db.getInventory(user.id)).toHaveLength(1);
  });

  test("adds known v2 columns to an existing unversioned database without losing user or stock data", () => {
    const directory = mkdtempSync(join(tmpdir(), "bnb-legacy-schema-test-"));
    const dbPath = join(directory, "legacy.sqlite");

    try {
      const legacy = new Database(dbPath, { create: true, strict: true });
      legacy.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          nickname TEXT NOT NULL DEFAULT '',
          password TEXT NOT NULL,
          gender INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          exp INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          draws INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          lucci INTEGER NOT NULL DEFAULT 50000,
          cash INTEGER NOT NULL DEFAULT 10000,
          grade INTEGER NOT NULL DEFAULT 0,
          rankFlag INTEGER NOT NULL DEFAULT 0,
          equippedChar INTEGER NOT NULL DEFAULT 0,
          guildName TEXT NOT NULL DEFAULT '',
          guildMark INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE inventory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          packageId INTEGER NOT NULL,
          itemId INTEGER NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          equippedSlot INTEGER NOT NULL DEFAULT 0,
          expireTime INTEGER NOT NULL DEFAULT 0,
          customText TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO users (username, nickname, password, lucci, cash)
        VALUES ('legacy_user', 'Legacy', 'legacy-password', 1234, 5678);
        INSERT INTO inventory (userId, packageId, itemId, quantity)
        VALUES (1, 1001, 4500, 2);
      `);
      legacy.close();

      using db = new GameDatabase(dbPath);
      const migratedUser = db.getUserByUsername("legacy_user");
      expect(migratedUser).toMatchObject({
        id: 1,
        username: "legacy_user",
        lucci: 1234,
        cash: 5678,
        marketLucci: 1234,
        rankGrade: 1,
        ladderPoints: 1000,
        isGm: 0,
      });
      expect(db.getUserStock(1)).toMatchObject([
        { itemCode: 4500, quantity: 2, remainUnits: 0, marketStatus: 0 },
      ]);
      expect(db.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
        .toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists the schema version and user data across database restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bnb-schema-test-"));
    const dbPath = join(directory, "server.sqlite");
    let createdUserId = 0;

    try {
      {
        using db = new GameDatabase(dbPath);
        createdUserId = db.createUser("persistent_user", "test-password").id;
        expect(db.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
          .toBe(CURRENT_SCHEMA_VERSION);
      }

      {
        using db = new GameDatabase(dbPath);
        expect(db.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
          .toBe(CURRENT_SCHEMA_VERSION);
        expect(db.getUserById(createdUserId)?.username).toBe("persistent_user");
        expect(db.getInventory(createdUserId)).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects databases created by a newer schema version", () => {
    using db = new GameDatabase(":memory:");
    const unsupportedVersion = CURRENT_SCHEMA_VERSION + 1;
    db.db.exec(`PRAGMA user_version = ${unsupportedVersion}`);

    expect(() => migrateDatabase(db.db)).toThrow(
      `Database schema version ${unsupportedVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
    );
  });
});
