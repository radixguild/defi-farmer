/// Database schema — SQLite with parameterized queries only.
/// Tracks intent hashes, positions, sessions, and agent actions.

import { Database } from 'bun:sqlite';
import { CONFIG } from '../config.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db: Database | null = null;
let dbOverride: Database | null = null;

export function setTestDb(testDb: Database | null): void {
  dbOverride = testDb;
}

/// Single source of truth for the schema — getDb() and every test fixture
/// apply exactly this, so prod and test schemas cannot drift.
export function applySchema(target: Database): void {
  target.exec('PRAGMA journal_mode = WAL');
  target.exec('PRAGMA foreign_keys = ON');

  target.exec(`
    -- Transaction idempotency tracking
    CREATE TABLE IF NOT EXISTS transactions (
      intent_hash TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_manifest ON transactions(manifest_hash);

    -- Portfolio positions
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      receipt_id TEXT,
      receipt_resource TEXT,
      token_a TEXT NOT NULL,
      token_b TEXT,
      deposited_amount TEXT NOT NULL,
      current_value TEXT,
      apy_bps INTEGER,
      risk_level TEXT DEFAULT 'unknown',
      deposited_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active'
    );

    -- Agent action log
    CREATE TABLE IF NOT EXISTS agent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      intent_hash TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Pool snapshots (for APY history)
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      tvl TEXT NOT NULL,
      apy_bps INTEGER NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pool_snap ON pool_snapshots(pool_address, scanned_at);

    -- Pool opportunity scores
    CREATE TABLE IF NOT EXISTS pool_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      score REAL NOT NULL,
      apy_ma_7d REAL NOT NULL,
      tvl_variance REAL NOT NULL,
      classification TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pool_scores_addr ON pool_scores(pool_address, computed_at);

    -- Rotation history log
    CREATE TABLE IF NOT EXISTS rotation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_pool TEXT NOT NULL,
      to_pool TEXT NOT NULL,
      from_protocol TEXT NOT NULL,
      to_protocol TEXT NOT NULL,
      amount TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
      executed_at TEXT,
      intent_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rotation_log_status ON rotation_log(status, proposed_at);

    -- ROLA sessions. Raw tokens are never stored — only sha256(token).
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_address);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  // Add new columns (SQLite lacks IF NOT EXISTS for columns).
  // user_address: NULL = bot-owned row (the agent's own portfolio) — the
  // agent keeps operating on NULL-owner rows exactly as before; session
  // queries scope WHERE user_address = ? (Phase 3.1 D4).
  const alterColumns = [
    'ALTER TABLE positions ADD COLUMN receipt_resource TEXT',
    "ALTER TABLE positions ADD COLUMN classification TEXT DEFAULT 'rotational'",
    'ALTER TABLE positions ADD COLUMN entry_apy_bps INTEGER',
    'ALTER TABLE positions ADD COLUMN cooldown_until TEXT',
    'ALTER TABLE positions ADD COLUMN last_review_at TEXT',
    'ALTER TABLE positions ADD COLUMN user_address TEXT',
    'ALTER TABLE positions ADD COLUMN intent_hash TEXT',
    'ALTER TABLE positions ADD COLUMN lp_amount TEXT',
    'ALTER TABLE pool_scores ADD COLUMN net_apy_ma_7d REAL',
    'ALTER TABLE pool_scores ADD COLUMN estimated_il REAL',
    'ALTER TABLE pool_scores ADD COLUMN il_risk_score INTEGER',
    'ALTER TABLE pool_scores ADD COLUMN risk_adjusted_return REAL',
    // The enricher's resolved "SYMX-SYMY" name (on-ledger symbols) — so the UI
    // labels tokens instead of showing a bare component address.
    'ALTER TABLE pool_scores ADD COLUMN pool_name TEXT',
    // How the position earns: 'amm-lp' | 'staking' | 'lending'. Decides whether
    // impermanent loss applies at all — staking and lending are IL-free by
    // construction, so they must not be charged the IL model's estimate.
    "ALTER TABLE pool_scores ADD COLUMN yield_kind TEXT DEFAULT 'amm-lp'",
    'ALTER TABLE transactions ADD COLUMN user_address TEXT',
    'ALTER TABLE rotation_log ADD COLUMN user_address TEXT',
    'ALTER TABLE agent_log ADD COLUMN user_address TEXT',
    // Verified close (the exit half of D5) — nothing wrote status='closed'
    // before these existed, so an exited position stayed counted forever.
    'ALTER TABLE positions ADD COLUMN closed_at TEXT',
    'ALTER TABLE positions ADD COLUMN close_intent_hash TEXT',
  ];
  for (const sql of alterColumns) {
    try {
      target.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  // Indexes on ALTER-added columns must come after the ALTERs.
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_address);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_intent ON positions(intent_hash)
      WHERE intent_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rotation_log_user ON rotation_log(user_address);
  `);
}

export function getDb(): Database {
  if (dbOverride) return dbOverride;
  if (db) return db;

  mkdirSync(dirname(CONFIG.DB_PATH), { recursive: true });
  db = new Database(CONFIG.DB_PATH);
  applySchema(db);

  return db;
}

export interface Position {
  id: number;
  protocol: string;
  pool_address: string;
  receipt_id: string | null;
  receipt_resource: string | null;
  token_a: string;
  token_b: string | null;
  deposited_amount: string;
  current_value: string | null;
  apy_bps: number | null;
  risk_level: string;
  deposited_at: string;
  updated_at: string;
  status: string;
  classification: string;
  entry_apy_bps: number | null;
  cooldown_until: string | null;
  last_review_at: string | null;
  user_address: string | null;
  intent_hash: string | null;
  closed_at: string | null;
  close_intent_hash: string | null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
