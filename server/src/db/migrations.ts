import type { Database } from "bun:sqlite";

interface SchemaMigration {
  version: number;
  up(database: Database): void;
}

function addColumnIfMissing(
  database: Database,
  table: "users" | "inventory",
  column: string,
  declaration: string
): boolean {
  const columns = database.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();
  if (columns.some((candidate) => candidate.name === column)) return false;
  database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${declaration}`);
  return true;
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
  {
    version: 2,
    up(database: Database): void {
      // Earlier unversioned files may already have these base tables, so CREATE IF NOT EXISTS
      // alone does not add fields introduced after those files were created. Add only known
      // reconstruction columns, preserve existing rows, and seed new market balances from the
      // existing game currency rather than replacing a user's balance with the new-account default.
      const marketLucciAdded = addColumnIfMissing(
        database,
        "users",
        "marketLucci",
        "INTEGER NOT NULL DEFAULT 50000"
      );
      if (marketLucciAdded) {
        database.exec("UPDATE users SET marketLucci = lucci");
      }
      addColumnIfMissing(database, "users", "rankGrade", "INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(database, "users", "ladderPoints", "INTEGER NOT NULL DEFAULT 1000");
      addColumnIfMissing(database, "users", "isGm", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(database, "inventory", "remainUnits", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(database, "inventory", "marketStatus", "INTEGER NOT NULL DEFAULT 0");
    },
  },
] as const satisfies readonly SchemaMigration[];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Applies each missing schema version in its own immediate transaction. The
 * version is read after the write lock is acquired so concurrent server starts
 * cannot both apply the same migration. Version 1 creates missing base tables;
 * version 2 adds known newer columns to pre-existing tables without replacing
 * their rows. Files with unrecognized/missing core columns still fail visibly
 * when the repository's prepared statements are initialized.
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
