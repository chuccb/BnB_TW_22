import type { Database } from "bun:sqlite";

interface SchemaMigration {
  version: number;
  up(database: Database): void;
}

const MIGRATIONS = [
  {
    version: 1,
    up(database: Database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS users (
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
          marketLucci INTEGER NOT NULL DEFAULT 50000,
          rankGrade INTEGER NOT NULL DEFAULT 1,
          grade INTEGER NOT NULL DEFAULT 0,
          rankFlag INTEGER NOT NULL DEFAULT 0,
          ladderPoints INTEGER NOT NULL DEFAULT 1000,
          isGm INTEGER NOT NULL DEFAULT 0,
          equippedChar INTEGER NOT NULL DEFAULT 0,
          guildName TEXT NOT NULL DEFAULT '',
          guildMark INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS inventory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          packageId INTEGER NOT NULL,
          itemId INTEGER NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          equippedSlot INTEGER NOT NULL DEFAULT 0,
          expireTime INTEGER NOT NULL DEFAULT 0,
          customText TEXT NOT NULL DEFAULT '',
          remainUnits INTEGER NOT NULL DEFAULT 0,
          marketStatus INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(userId);

        CREATE TABLE IF NOT EXISTS user_gifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receiverUserId INTEGER NOT NULL,
          senderName TEXT NOT NULL,
          packageId INTEGER NOT NULL,
          itemId INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          claimed INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (receiverUserId) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_sms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receiverUserId INTEGER NOT NULL,
          senderName TEXT NOT NULL,
          message TEXT NOT NULL,
          isRead INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (receiverUserId) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_couples (
          userId INTEGER PRIMARY KEY,
          partnerUserId INTEGER NOT NULL,
          partnerName TEXT NOT NULL,
          coupleGrade INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS market_listings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sellerUserId INTEGER NOT NULL,
          sellerName TEXT NOT NULL,
          stockId INTEGER NOT NULL,
          itemCode INTEGER NOT NULL,
          price INTEGER NOT NULL,
          status INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (sellerUserId) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
    },
  },
] as const satisfies readonly SchemaMigration[];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Applies each missing schema version in its own immediate transaction. The
 * version is read after the write lock is acquired so concurrent server starts
 * cannot both apply the same non-idempotent migration. Version 1 uses CREATE
 * IF NOT EXISTS so databases using the previous schema are adopted in place
 * without replacing their existing rows.
 */
export function migrateDatabase(database: Database): void {
  const applyNextMigration = database.transaction((): boolean => {
    const currentVersion =
      database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
      );
    }
    if (currentVersion === CURRENT_SCHEMA_VERSION) {
      return false;
    }

    const nextVersion = currentVersion + 1;
    const migration = MIGRATIONS.find((candidate) => candidate.version === nextVersion);
    if (!migration) {
      throw new Error(`Database schema migration ${nextVersion} is missing`);
    }

    migration.up(database);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    return true;
  });

  while (applyNextMigration.immediate()) {
    // Apply one version at a time so each schema change and version bump commit together.
  }
}
