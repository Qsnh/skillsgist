import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema";

export type Db = Database.Database;

export type Params = unknown[];

export const MEMORY = ":memory:";

const statements = new WeakMap<Db, Map<string, Database.Statement>>();

export function statement(db: Db, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

export function get<T>(db: Db, sql: string, ...params: Params): T | null {
  return (statement(db, sql).get(...params) as T | undefined) ?? null;
}

export function all<T>(db: Db, sql: string, ...params: Params): T[] {
  return statement(db, sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: Params): number {
  return statement(db, sql).run(...params).changes;
}

export function transaction<T>(db: Db, work: () => T): T {
  return db.transaction(work)();
}

export function openDatabase(file: string): Db {
  if (file !== MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): number {
  const from = schemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`The database is at schema version ${from}, newer than this build (${migrations.length}); upgrade skillsgist`);
  }
  if (from === migrations.length) return 0;
  const enforced = db.pragma("foreign_keys", { simple: true }) === 1;
  db.pragma("foreign_keys = OFF");
  try {
    for (let version = from + 1; version <= migrations.length; version++) {
      db.transaction(() => {
        db.exec(migrations[version - 1]);
        const broken = db.pragma("foreign_key_check") as Array<{ table: string; parent: string }>;
        if (broken.length > 0) {
          const first = broken[0];
          throw new Error(`Migration ${version} left ${broken.length} rows in ${first.table} pointing at missing ${first.parent} rows`);
        }
        db.pragma(`user_version = ${version}`);
      })();
    }
  } finally {
    if (enforced) db.pragma("foreign_keys = ON");
  }
  return migrations.length - from;
}
