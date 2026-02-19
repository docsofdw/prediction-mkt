import fs from "node:fs";
import path from "node:path";

export type SqliteDatabase = {
  prepare: (sql: string) => {
    run: (...args: any[]) => any;
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
  };
  exec: (sql: string) => void;
  pragma: (sql: string) => unknown;
  close: () => void;
};

export function openValidationDb(dbPath: string): SqliteDatabase {
  const dir = path.dirname(path.resolve(process.cwd(), dbPath));
  fs.mkdirSync(dir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite3 = require("better-sqlite3");
  const db: SqliteDatabase = new BetterSqlite3(path.resolve(process.cwd(), dbPath));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function migrateValidationDb(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phase1_scan_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      active_btc_markets INTEGER NOT NULL,
      total_violations_this_scan INTEGER NOT NULL,
      avg_spread_cents_all_markets REAL,
      btc_spot REAL,
      btc_1h_return_pct REAL,
      btc_1h_realized_vol REAL,
      hour_of_day_utc INTEGER NOT NULL,
      day_of_week TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phase1_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      violation_key TEXT NOT NULL,
      first_seen_ts TEXT NOT NULL,
      last_seen_ts TEXT NOT NULL,
      type TEXT NOT NULL,
      leg_a_json TEXT NOT NULL,
      leg_b_json TEXT NOT NULL,
      violation_size_cents REAL NOT NULL,
      fillable_notional_usd REAL NOT NULL,
      btc_spot_at_detection REAL,
      btc_1h_return_pct REAL,
      btc_1h_realized_vol REAL,
      resolved_at TEXT,
      duration_seconds INTEGER,
      resolution TEXT,
      UNIQUE(violation_key, first_seen_ts)
    );

    CREATE INDEX IF NOT EXISTS idx_phase1_violations_open
      ON phase1_violations(violation_key, resolved_at);

    CREATE TABLE IF NOT EXISTS phase2_funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL UNIQUE,
      fr_average REAL,
      fr_binance REAL,
      fr_bybit REAL,
      fr_okx REAL,
      fr_percentile_30d REAL
    );

    CREATE TABLE IF NOT EXISTS phase2_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL UNIQUE,
      token_id TEXT,
      question TEXT NOT NULL,
      strike REAL,
      expiry TEXT,
      direction TEXT,
      settlement REAL,
      price_at_listing REAL,
      price_at_48h_before REAL,
      price_at_24h_before REAL
    );

    CREATE TABLE IF NOT EXISTS phase3_weekly_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_expiry TEXT NOT NULL UNIQUE,
      entry_time TEXT,
      floor_contract_id TEXT,
      ceiling_contract_id TEXT,
      floor_entry_price REAL,
      ceiling_entry_price REAL,
      floor_settlement REAL,
      ceiling_settlement REAL,
      combined_pnl REAL,
      btc_weekly_return REAL,
      sth_mvrv REAL,
      fear_greed REAL,
      fr_average REAL
    );

    CREATE TABLE IF NOT EXISTS market_price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      question TEXT NOT NULL,
      best_bid REAL,
      best_ask REAL,
      mid_price REAL,
      bid_depth_usd REAL,
      ask_depth_usd REAL,
      btc_spot REAL,
      UNIQUE(timestamp, token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_token_ts
      ON market_price_snapshots(token_id, timestamp);

    CREATE TABLE IF NOT EXISTS thesis_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thesis TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      window_start TEXT,
      window_end TEXT,
      verdict TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      report_path TEXT
    );

    CREATE TABLE IF NOT EXISTS updown_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      market_type TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      outcome TEXT NOT NULL,
      btc_price_start REAL,
      btc_price_end REAL,
      volume REAL,
      up_token_id TEXT,
      down_token_id TEXT,
      up_price_before REAL,
      down_price_before REAL,
      fr_percentile REAL,
      ingested_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_updown_window
      ON updown_outcomes(window_start);

    CREATE INDEX IF NOT EXISTS idx_updown_type
      ON updown_outcomes(market_type);

    -- Live Up/Down market logger (Priority 1 from analysis)
    -- Captures opening prices to determine actual edge
    CREATE TABLE IF NOT EXISTS updown_live_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      market_type TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,

      -- Opening snapshot (captured at window open)
      snapshot_ts TEXT NOT NULL,
      up_mid_price REAL,
      down_mid_price REAL,
      up_best_bid REAL,
      up_best_ask REAL,
      down_best_bid REAL,
      down_best_ask REAL,
      spread_cents REAL,
      bid_depth_usd REAL,
      ask_depth_usd REAL,

      -- Context at open
      btc_spot REAL,
      fr_percentile REAL,
      hour_utc INTEGER,
      day_of_week TEXT,
      prev_outcome TEXT,
      streak_length INTEGER,

      -- Settlement (filled after resolution)
      outcome TEXT,
      settled_at TEXT,

      UNIQUE(slug)
    );

    CREATE INDEX IF NOT EXISTS idx_live_snapshots_window
      ON updown_live_snapshots(window_start);

    CREATE INDEX IF NOT EXISTS idx_live_snapshots_streak
      ON updown_live_snapshots(streak_length, outcome);
  `);

  const now = new Date().toISOString();
  const getMetaStmt = db.prepare("SELECT value FROM validation_meta WHERE key = ?");
  const insertMeta = db.prepare(
    "INSERT INTO validation_meta(key, value, updated_at) VALUES(?, ?, ?)"
  );

  if (!getMetaStmt.get("validation_started_at")) {
    insertMeta.run("validation_started_at", now, now);
  }
}

export function setMeta(db: SqliteDatabase, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO validation_meta(key, value, updated_at)
     VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

export function getMeta(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM validation_meta WHERE key = ?").get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}
