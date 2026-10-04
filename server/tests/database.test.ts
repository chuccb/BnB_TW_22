import { describe, expect, test } from "bun:test";
import { GameDatabase } from "../src/db/database.ts";

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
});
