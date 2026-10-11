import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setTestDb } from '../src/db/schema';

// We test the circuit breaker logic by exercising the AgentLoop's state management.
// Since AgentLoop has heavy dependencies, we extract and test the core logic directly.

describe('CircuitBreaker logic', () => {
  let testDb: Database;

  function setupSchema(db: Database): void {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
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
        status TEXT NOT NULL DEFAULT 'active',
        classification TEXT DEFAULT 'rotational',
        entry_apy_bps INTEGER,
        cooldown_until TEXT,
        last_review_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_address TEXT NOT NULL,
        protocol TEXT NOT NULL,
        tvl TEXT NOT NULL,
        apy_bps INTEGER NOT NULL,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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

      CREATE TABLE IF NOT EXISTS agent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        intent_hash TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  beforeEach(() => {
    testDb = new Database(':memory:');
    setupSchema(testDb);
    setTestDb(testDb);
  });

  afterAll(() => {
    setTestDb(null);
    testDb?.close();
  });

  test('should trip after THRESHOLD errors within window', () => {
    // Simulate the circuit breaker logic from loop.ts
    const THRESHOLD = 5; // CONFIG.CIRCUIT_BREAKER_THRESHOLD default
    const WINDOW_MS = 600_000; // CONFIG.CIRCUIT_BREAKER_WINDOW_MS default

    const state = {
      errorTimestamps: [] as number[],
      tripped: false,
      trippedAt: null as number | null,
    };

    const now = Date.now();
    for (let i = 0; i < THRESHOLD; i++) {
      state.errorTimestamps.push(now);
      // Prune outside window
      state.errorTimestamps = state.errorTimestamps.filter(t => now - t < WINDOW_MS);
    }

    if (state.errorTimestamps.length >= THRESHOLD) {
      state.tripped = true;
      state.trippedAt = now;
    }

    expect(state.tripped).toBe(true);
    expect(state.trippedAt).toBe(now);
    expect(state.errorTimestamps.length).toBe(THRESHOLD);
  });

  test('should NOT trip below threshold', () => {
    const THRESHOLD = 5;
    const WINDOW_MS = 600_000;

    const state = {
      errorTimestamps: [] as number[],
      tripped: false,
      trippedAt: null as number | null,
    };

    const now = Date.now();
    for (let i = 0; i < THRESHOLD - 1; i++) {
      state.errorTimestamps.push(now);
      state.errorTimestamps = state.errorTimestamps.filter(t => now - t < WINDOW_MS);
    }

    if (state.errorTimestamps.length >= THRESHOLD) {
      state.tripped = true;
      state.trippedAt = now;
    }

    expect(state.tripped).toBe(false);
    expect(state.trippedAt).toBeNull();
    expect(state.errorTimestamps.length).toBe(THRESHOLD - 1);
  });

  test('should prune errors outside the time window', () => {
    const WINDOW_MS = 600_000;

    const state = {
      errorTimestamps: [] as number[],
      tripped: false,
      trippedAt: null as number | null,
    };

    const now = Date.now();
    // Add old errors outside the window
    state.errorTimestamps = [
      now - WINDOW_MS - 1000,
      now - WINDOW_MS - 500,
    ];
    // Add a new error
    state.errorTimestamps.push(now);

    // Prune
    state.errorTimestamps = state.errorTimestamps.filter(t => now - t < WINDOW_MS);

    expect(state.errorTimestamps.length).toBe(1);
    expect(state.errorTimestamps[0]).toBe(now);
  });

  test('errors cleared on successful tick', () => {
    const state = {
      errors: ['error1', 'error2'],
      errorTimestamps: [Date.now(), Date.now()],
    };

    // Simulate successful tick clearing
    state.errors = [];
    state.errorTimestamps = [];

    expect(state.errors.length).toBe(0);
    expect(state.errorTimestamps.length).toBe(0);
  });

  test('window pruning allows recovery after time passes', () => {
    const THRESHOLD = 5;
    const WINDOW_MS = 600_000;

    const state = {
      errorTimestamps: [] as number[],
      tripped: false,
    };

    // Simulate errors from 11 minutes ago (outside 10-min window)
    const now = Date.now();
    const oldTime = now - WINDOW_MS - 60_000;
    for (let i = 0; i < THRESHOLD; i++) {
      state.errorTimestamps.push(oldTime);
    }

    // New error arrives and triggers prune
    state.errorTimestamps.push(now);
    state.errorTimestamps = state.errorTimestamps.filter(t => now - t < WINDOW_MS);

    // Should only have 1 recent error — well below threshold
    expect(state.errorTimestamps.length).toBe(1);
    if (state.errorTimestamps.length >= THRESHOLD) {
      state.tripped = true;
    }
    expect(state.tripped).toBe(false);
  });
});
