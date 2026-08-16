import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { migrations } from "./migrations.js";

export type DB = Database.Database;

let instance: DB | null = null;

/**
 * Opens (and migrates) the SQLite database. WAL mode and a busy timeout keep
 * the risk-cycle writer from blocking API reads. `:memory:` is honoured so
 * tests get an isolated database per suite.
 */
export function openDatabase(databasePath: string = config.databasePath): DB {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  migrate(db);
  return db;
}

export function getDatabase(): DB {
  if (!instance) instance = openDatabase();
  return instance;
}

export function setDatabase(db: DB): void {
  instance = db;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/** Applies any migration whose version exceeds `user_version`. */
export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
    })();
    logger.info({ version: migration.version, name: migration.name }, "migration applied");
  }
}
