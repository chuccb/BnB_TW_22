import { describe, expect, test } from "bun:test";
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
