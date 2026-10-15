import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type XrayDb = Database.Database;

/** Stored in PRAGMA user_version. Bump when schema.sql changes incompatibly. */
export const SCHEMA_VERSION = 1;

const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Opens (creating if needed) an X-Ray index and ensures the schema is current. */
export function openDatabase(file: string): XrayDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Index at ${file} uses schema v${version} but this version of xray expects v${SCHEMA_VERSION}. ` +
        'Delete the .xray directory and run `xray index` again.',
    );
  }

  db.exec(schemaSql);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function setMeta(db: XrayDb, entries: Record<string, string>): void {
  const stmt = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(entries)) stmt.run(key, value);
}

export function getMeta(db: XrayDb, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
