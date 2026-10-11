/// Data tracking layer — time-series pool snapshots, volume tracking, and yield history.
/// Reads/writes to SQLite via the shared getDb() singleton.

import { getDb } from '../db/schema.js';
import { MIN_RETENTION_DAYS } from '../config.js';
import type { PoolInfo } from './gateway.js';

// ─── Schema Extension ─────────────────────────────────────────────────────────

/** Initialize tracking tables. Safe to call multiple times (IF NOT EXISTS). */
export function initTrackingTables(): void {
  const db = getDb();
  db.exec(`
    -- Extended pool snapshots with volume and fee data
    CREATE TABLE IF NOT EXISTS pool_snapshots_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      tvl TEXT NOT NULL,
      apy_bps INTEGER NOT NULL,
      token_a_reserve TEXT NOT NULL DEFAULT '0',
      token_b_reserve TEXT NOT NULL DEFAULT '0',
      fee_rate_bps INTEGER NOT NULL DEFAULT 0,
      volume_24h TEXT NOT NULL DEFAULT '0',
      fees_24h TEXT NOT NULL DEFAULT '0',
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapv2_pool_time
      ON pool_snapshots_v2(pool_address, snapshot_at);

    CREATE INDEX IF NOT EXISTS idx_snapv2_protocol_time
      ON pool_snapshots_v2(protocol, snapshot_at);

    -- Volume tracking (aggregated per pool per day)
    CREATE TABLE IF NOT EXISTS pool_volume_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      volume_usd TEXT NOT NULL DEFAULT '0',
      fees_usd TEXT NOT NULL DEFAULT '0',
      tx_count INTEGER NOT NULL DEFAULT 0,
      day TEXT NOT NULL,
      UNIQUE(pool_address, day)
    );

    CREATE INDEX IF NOT EXISTS idx_vol_pool_day
      ON pool_volume_daily(pool_address, day);

    -- Yield history (computed APR/APY per pool per period)
    CREATE TABLE IF NOT EXISTS yield_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      protocol TEXT NOT NULL,
      period TEXT NOT NULL,
      apr_bps INTEGER NOT NULL,
      apy_bps INTEGER NOT NULL,
      il_bps INTEGER NOT NULL DEFAULT 0,
      net_apy_bps INTEGER NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_yield_pool_period
      ON yield_history(pool_address, period, computed_at);
  `);
}

// ─── Snapshot Recording ───────────────────────────────────────────────────────

export interface ExtendedSnapshot {
  poolAddress: string;
  protocol: string;
  tvl: string;
  apyBps: number;
  tokenAReserve: string;
  tokenBReserve: string;
  feeRateBps: number;
  volume24h: string;
  fees24h: string;
}

/** Record a pool state snapshot. */
export function recordSnapshot(snap: ExtendedSnapshot): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO pool_snapshots_v2
     (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snap.poolAddress,
    snap.protocol,
    snap.tvl,
    snap.apyBps,
    snap.tokenAReserve,
    snap.tokenBReserve,
    snap.feeRateBps,
    snap.volume24h,
    snap.fees24h,
  );
}

/** Record snapshots from standard PoolInfo array (backward compatible). */
export function recordPoolSnapshots(pools: PoolInfo[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO pool_snapshots_v2
     (pool_address, protocol, tvl, apy_bps, token_a_reserve, token_b_reserve, fee_rate_bps, volume_24h, fees_24h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of pools) {
    insert.run(p.address, p.protocol, p.tvl, Math.round(p.apy * 100), '0', '0', 0, '0', '0');
  }
}

// ─── Volume Tracking ──────────────────────────────────────────────────────────

/** Upsert daily volume for a pool. Accumulates within the same day. */
export function recordDailyVolume(
  poolAddress: string,
  protocol: string,
  volumeUsd: string,
  feesUsd: string,
  txCount: number,
): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO pool_volume_daily (pool_address, protocol, volume_usd, fees_usd, tx_count, day)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pool_address, day) DO UPDATE SET
       volume_usd = CAST(CAST(volume_usd AS REAL) + CAST(? AS REAL) AS TEXT),
       fees_usd = CAST(CAST(fees_usd AS REAL) + CAST(? AS REAL) AS TEXT),
       tx_count = tx_count + ?`,
  ).run(poolAddress, protocol, volumeUsd, feesUsd, txCount, today, volumeUsd, feesUsd, txCount);
}

// ─── Time-Series Queries ──────────────────────────────────────────────────────

export interface SnapshotRow {
  pool_address: string;
  protocol: string;
  tvl: string;
  apy_bps: number;
  token_a_reserve: string;
  token_b_reserve: string;
  fee_rate_bps: number;
  volume_24h: string;
  fees_24h: string;
  snapshot_at: string;
}

/** Get pool snapshots for a time range. */
export function getPoolSnapshots(
  poolAddress: string,
  hoursBack: number = 168,
): SnapshotRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pool_snapshots_v2
       WHERE pool_address = ? AND snapshot_at >= datetime('now', ? || ' hours')
       ORDER BY snapshot_at ASC`,
    )
    .all(poolAddress, String(-hoursBack)) as SnapshotRow[];
}

/** Get latest snapshot for each tracked pool. */
export function getLatestSnapshots(): SnapshotRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.* FROM pool_snapshots_v2 s
       INNER JOIN (
         SELECT pool_address, MAX(snapshot_at) as max_at
         FROM pool_snapshots_v2
         GROUP BY pool_address
       ) latest ON s.pool_address = latest.pool_address AND s.snapshot_at = latest.max_at
       ORDER BY CAST(s.tvl AS REAL) DESC`,
    )
    .all() as SnapshotRow[];
}

/** Get TVL history for a pool (for charts). */
export function getTvlHistory(
  poolAddress: string,
  hoursBack: number = 168,
): Array<{ tvl: string; snapshot_at: string }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT tvl, snapshot_at FROM pool_snapshots_v2
       WHERE pool_address = ? AND snapshot_at >= datetime('now', ? || ' hours')
       ORDER BY snapshot_at ASC`,
    )
    .all(poolAddress, String(-hoursBack)) as Array<{ tvl: string; snapshot_at: string }>;
}

// ─── Yield History ────────────────────────────────────────────────────────────

/**
 * Compute and store yield metrics for a pool over various periods.
 * Periods: 24h, 7d, 30d.
 * `estimatedIlBps` — the pair's expected annual IL in bps (negative), from the
 * enricher's risk feed (PoolRisk.estimatedIlPct × 100).
 */
export function computeAndStoreYieldHistory(
  poolAddress: string,
  protocol: string,
  estimatedIlBps = 0,
): void {
  const db = getDb();
  const periods = [
    { label: '24h', hours: 24 },
    { label: '7d', hours: 168 },
    { label: '30d', hours: 720 },
  ];

  for (const { label, hours } of periods) {
    const snapshots = db
      .prepare(
        `SELECT apy_bps, tvl, fees_24h FROM pool_snapshots_v2
         WHERE pool_address = ? AND snapshot_at >= datetime('now', ? || ' hours')
         ORDER BY snapshot_at ASC`,
      )
      .all(poolAddress, String(-hours)) as Array<{
      apy_bps: number;
      tvl: string;
      fees_24h: string;
    }>;

    if (snapshots.length === 0) continue;

    // Average APR from snapshots
    const avgApyBps =
      Math.round(snapshots.reduce((sum, s) => sum + s.apy_bps, 0) / snapshots.length);

    // Compute APY from APR (assuming daily compounding)
    const aprDecimal = avgApyBps / 10000;
    const apyDecimal = Math.pow(1 + aprDecimal / 365, 365) - 1;
    const apyBps = Math.round(apyDecimal * 10000);

    // Net APY = gross + estimated IL (IL is negative bps)
    const ilBps = Math.round(estimatedIlBps);
    const netApyBps = apyBps + ilBps;

    db.prepare(
      `INSERT INTO yield_history (pool_address, protocol, period, apr_bps, apy_bps, il_bps, net_apy_bps)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(poolAddress, protocol, label, avgApyBps, apyBps, ilBps, netApyBps);
  }
}

/** Get the latest yield history for a pool. */
export function getLatestYield(
  poolAddress: string,
): Record<string, { apr: number; apy: number; il: number; netApy: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT period, apr_bps, apy_bps, il_bps, net_apy_bps FROM yield_history
       WHERE pool_address = ?
       AND computed_at = (
         SELECT MAX(computed_at) FROM yield_history WHERE pool_address = ? AND period = yield_history.period
       )
       ORDER BY period`,
    )
    .all(poolAddress, poolAddress) as Array<{
    period: string;
    apr_bps: number;
    apy_bps: number;
    il_bps: number;
    net_apy_bps: number;
  }>;

  const result: Record<string, { apr: number; apy: number; il: number; netApy: number }> = {};
  for (const row of rows) {
    result[row.period] = {
      apr: row.apr_bps / 100,
      apy: row.apy_bps / 100,
      il: row.il_bps / 100,
      netApy: row.net_apy_bps / 100,
    };
  }
  return result;
}

/** Get daily volumes for a pool over a date range. */
export function getDailyVolumes(
  poolAddress: string,
  daysBack: number = 30,
): Array<{ day: string; volume_usd: string; fees_usd: string; tx_count: number }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT day, volume_usd, fees_usd, tx_count FROM pool_volume_daily
       WHERE pool_address = ? AND day >= date('now', ? || ' days')
       ORDER BY day ASC`,
    )
    .all(poolAddress, String(-daysBack)) as Array<{
    day: string;
    volume_usd: string;
    fees_usd: string;
    tx_count: number;
  }>;
}

export interface PruneResult {
  snapshots: number;
  scores: number;
  snapshotsV2: number;
  /// True when any table hit PRUNE_MAX_PER_SWEEP, i.e. there is more to delete.
  /// The caller should come back on the next tick rather than the next day.
  capped: boolean;
}

/**
 * Delete time-series rows beyond the retention window.
 *
 * Covers the two tables the agent actually writes every scan — `pool_snapshots`
 * and `pool_scores` — plus `pool_snapshots_v2` where it exists. Until 2026-07-25
 * this function only touched `pool_snapshots_v2`, a table the live deployment
 * had never created, and nothing outside the tests ever called it; the two real
 * tables grew unbounded to 1.37M rows each.
 *
 * Callers MUST pass a window at least as long as the longest read lookback
 * (see MIN_RETENTION_DAYS) — deleting inside it silently starves the scorer.
 * Deletes are batched so a first run against a large backlog cannot build one
 * enormous transaction and WAL.
 */
export function pruneOldData(retentionDays: number = 30): PruneResult {
  // This function deletes. A negative or zero window inverts the cutoff into
  // the FUTURE and would wipe the tables, so validate rather than trust the
  // caller — the doc contract above is worth one comparison.
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw new Error(
      `pruneOldData: retentionDays must be an integer >= ${MIN_RETENTION_DAYS}, got ${retentionDays}`,
    );
  }
  const cutoff = String(-retentionDays);
  const snapshots = deleteOlderThan('pool_snapshots', 'scanned_at', cutoff);
  const scores = deleteOlderThan('pool_scores', 'computed_at', cutoff);
  const snapshotsV2 = deleteOlderThan('pool_snapshots_v2', 'snapshot_at', cutoff);
  return {
    snapshots,
    scores,
    snapshotsV2,
    capped: Math.max(snapshots, scores, snapshotsV2) >= PRUNE_MAX_PER_SWEEP,
  };
}

const PRUNE_BATCH = 20_000;

/// Hard ceiling on rows removed per table per sweep.
///
/// bun:sqlite is synchronous and this process also serves the HTTP API, so a
/// long delete is a dashboard hang. Measured on a copy of the live 756 MB DB:
/// clearing the full ~1.5M-row backlog takes ~19s, which is far too long to
/// block on. Steady state at hourly cadence is ~1.3k rows/table/day, so this
/// ceiling never binds in normal operation — it only makes a large backlog
/// drain across sweeps instead of stalling one tick. The operator clears a
/// real backlog out-of-band (docs/SNAPSHOT-CADENCE-PLAN.md, Phase 5).
const PRUNE_MAX_PER_SWEEP = 50_000;

/// Delete in bounded batches, skipping tables that don't exist on this DB.
function deleteOlderThan(table: string, column: string, cutoff: string): number {
  const db = getDb();
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return 0;

  // `table`/`column` are compile-time literals from pruneOldData, never caller
  // input — SQLite cannot bind identifiers, so they are interpolated.

  // Resolve the time cutoff to a boundary rowid ONCE. Without this each batch
  // re-scans the whole time index to find the next 20k rowids (measured: 74s
  // vs 19s for the same delete). The time predicate stays in the DELETE below,
  // so correctness does not depend on rowid order matching timestamp order —
  // the boundary only bounds how far the scan has to look.
  // No COALESCE: it would collapse "nothing matches" and "the newest match is
  // rowid 0" into the same falsy value, stranding that row forever.
  const boundaryRow = db
    .prepare(
      `SELECT MAX(rowid) AS boundary FROM ${table}
       WHERE ${column} < datetime('now', ? || ' days')`,
    )
    .get(cutoff) as { boundary: number | null };
  if (boundaryRow.boundary === null) return 0;

  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table}
       WHERE rowid <= ? AND ${column} < datetime('now', ? || ' days')
       LIMIT ?
     )`,
  );
  let total = 0;
  while (total < PRUNE_MAX_PER_SWEEP) {
    // Shrink the final batch so the ceiling is exact rather than overshooting
    // by up to PRUNE_BATCH - 1.
    const take = Math.min(PRUNE_BATCH, PRUNE_MAX_PER_SWEEP - total);
    const changes = stmt.run(boundaryRow.boundary, cutoff, take).changes;
    total += changes;
    if (changes < take) break;
  }
  return total;
}
