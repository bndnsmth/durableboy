import type { ConsoleLifecycle, ConsoleModel } from "../shared/protocol";

export interface MachineRow extends Record<string, SqlStorageValue> {
  console_id: string;
  model: ConsoleModel;
  lifecycle: ConsoleLifecycle;
  owner_hash: string | null;
  cartridge_id: string | null;
  cartridge_hash: string | null;
  cartridge_title: string | null;
  rom_key: string | null;
  battery_key: string | null;
  frame: string;
  ticks: string;
  buttons: number;
  input_seq: number;
  checkpoint_key: string | null;
  checkpoint_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface CheckpointRow extends Record<string, SqlStorageValue> {
  id: number;
  frame: string;
  ticks: string;
  buttons: number;
  input_seq: number;
  object_key: string;
  sha256: string;
  state_hash: string;
  byte_size: number;
}

export interface InputRow extends Record<string, SqlStorageValue> {
  seq: number;
  frame: string;
  buttons: number;
}

export interface TelemetryRow extends Record<string, SqlStorageValue> {
  frames_run: string;
  chunks_run: number;
  observed_wall_ms: number;
  wasm_memory_bytes: number;
  last_state_bytes: number;
}

export function migrateConsoleSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS machine (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      console_id TEXT NOT NULL,
      model TEXT NOT NULL CHECK (model IN ('DMG', 'CGB')),
      lifecycle TEXT NOT NULL,
      owner_hash TEXT,
      cartridge_id TEXT,
      cartridge_hash TEXT,
      cartridge_title TEXT,
      rom_key TEXT,
      battery_key TEXT,
      frame TEXT NOT NULL,
      ticks TEXT NOT NULL,
      buttons INTEGER NOT NULL DEFAULT 0,
      input_seq INTEGER NOT NULL DEFAULT 0,
      checkpoint_key TEXT,
      checkpoint_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      frame TEXT NOT NULL,
      ticks TEXT NOT NULL,
      buttons INTEGER NOT NULL DEFAULT 0,
      input_seq INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inputs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      frame TEXT NOT NULL,
      ticks TEXT NOT NULL,
      player INTEGER NOT NULL,
      buttons INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leases (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telemetry (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      frames_run TEXT NOT NULL,
      chunks_run INTEGER NOT NULL,
      observed_wall_ms REAL NOT NULL,
      wasm_memory_bytes INTEGER NOT NULL,
      last_state_bytes INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS inputs_frame_idx ON inputs(frame, seq);
    CREATE INDEX IF NOT EXISTS checkpoints_frame_idx ON checkpoints(frame);
    INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
      VALUES (1, unixepoch() * 1000);
  `);

  addColumnIfMissing(
    sql,
    "checkpoints",
    "buttons",
    "ALTER TABLE checkpoints ADD COLUMN buttons INTEGER NOT NULL DEFAULT 0",
  );
  sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
    VALUES (2, unixepoch() * 1000)`);

  addColumnIfMissing(
    sql,
    "machine",
    "owner_hash",
    "ALTER TABLE machine ADD COLUMN owner_hash TEXT",
  );
  sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
    VALUES (3, unixepoch() * 1000)`);
}

function addColumnIfMissing(
  sql: SqlStorage,
  table: string,
  column: string,
  statement: string,
): void {
  const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (!columns.some((candidate) => candidate.name === column)) {
    sql.exec(statement);
  }
}
