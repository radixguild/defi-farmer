/// Agent loop — the autonomous ADVISOR (non-custodial).
/// Scans pools, enriches + scores them net-of-IL, checks exit guards, and
/// surfaces rebalance opportunities + rotation proposals for the user to act on.
/// It NEVER signs or submits — money moves only when the user signs a manifest
/// the frontend builds (dex/build-service) in their own wallet.
///
/// Hardened: tick overlap guard prevents stacked ticks if Gateway is slow.
/// Circuit breaker trips on N failures in M minutes (configurable).

import { CONFIG } from '../config.js';
import { GatewayClient } from '../services/gateway.js';
import type { PoolInfo } from '../services/gateway.js';
import { OpportunityScorer } from '../services/scorer.js';
import type { ScoredPool } from '../services/scorer.js';
import { RotationManager } from '../services/rotation.js';
import { scanOciswap, getXrdUsdPrice } from '../services/ociswap.js';
import { scanCaviarNine } from '../services/caviarnine.js';
import { scanDefiPlaza } from '../services/defiplaza.js';
import { scanStaking } from '../services/staking.js';
import { scanLsuPool } from '../services/lsu-pool.js';
import { scanWeftLending } from '../services/weft.js';
import { enrichPools } from '../services/pool-enricher.js';
import { getDb } from '../db/schema.js';
import { pruneOldData } from '../services/data-tracker.js';
import type { Position } from '../db/schema.js';

/// SQLite's datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone
/// marker, which `new Date(...)` would read as LOCAL time — a silent offset
/// (10h for the operator's timezone) that would make the throttle think the
/// last write was hours ago or in the future. Parse it as UTC explicitly.
/// Returns 0 for anything unparseable so the caller falls back to "write now".
export function parseSqliteUtc(value: string): number {
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

/// Inverse of parseSqliteUtc: render a Date in SQLite's datetime('now') shape
/// ("YYYY-MM-DD HH:MM:SS", UTC) so a batch can share one explicit timestamp
/// instead of each row taking its own column default.
export function formatSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface PoolOpportunity {
  address: string;
  protocol: string;
  apy: number;
  tvl: string;
  audited: boolean;
}

interface CircuitBreakerState {
  errorTimestamps: number[];
  tripped: boolean;
  trippedAt: number | null;
}

interface AgentState {
  running: boolean;
  halted: boolean;
  lastScan: number;
  lastRotationReview: number;
  /// Epoch ms of the last pool_snapshots/pool_scores write. Seeded from the DB
  /// once at start() so a restart (or a crashloop) can't bypass the throttle.
  lastPersist: number;
  /// Epoch ms of the last retention sweep. In-memory only — a prune missed
  /// across a restart just happens on the next daily boundary.
  lastPrune: number;
  errors: string[];
  circuitBreaker: CircuitBreakerState;
}

export class AgentLoop {
  private gateway: GatewayClient;
  private scorer: OpportunityScorer;
  private rotation: RotationManager;
  private state: AgentState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;   // prevents overlapping ticks
  private tickConsecutiveSkips = 0; // counts skips for logging

  constructor() {
    this.gateway = new GatewayClient();
    this.scorer = new OpportunityScorer();
    this.rotation = new RotationManager(this.scorer);
    this.state = {
      running: false,
      halted: false,
      lastScan: 0,
      lastRotationReview: 0,
      lastPersist: 0,
      lastPrune: 0,
      errors: [],
      circuitBreaker: {
        errorTimestamps: [],
        tripped: false,
        trippedAt: null,
      },
    };
  }

  /// Start the agent loop
  start(): void {
    if (this.state.running) return;
    this.state.halted = false;
    this.state.circuitBreaker.tripped = false;
    this.state.circuitBreaker.trippedAt = null;
    this.state.circuitBreaker.errorTimestamps = [];
    this.state.errors = [];
    this.tickInProgress = false;
    this.tickConsecutiveSkips = 0;
    this.state.running = true;

    console.log(`[agent] Starting advisor with ${CONFIG.SCAN_INTERVAL_MS}ms interval (no signing)`);
    this.state.lastPersist = this.readLastPersistAt();
    console.log(
      `[agent] Persisting snapshots/scores every ${CONFIG.SNAPSHOT_INTERVAL_MS}ms; retention ${CONFIG.SNAPSHOT_RETENTION_DAYS}d`,
    );

    // Run immediately, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), CONFIG.SCAN_INTERVAL_MS);
  }

  /// Stop the agent loop
  stop(): void {
    this.state.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[agent] Stopped');
  }

  /// Halt the agent via kill switch (requires manual restart via API)
  halt(): void {
    this.state.halted = true;
    this.stop();
    console.log('[agent] HALTED via kill switch — manual restart required');
  }

  /// Check if agent is halted
  isHalted(): boolean {
    return this.state.halted;
  }

  /// Single tick of the agent loop
  private async tick(): Promise<void> {
    if (this.state.halted) return;

    // ── Tick overlap guard ──────────────────────────────────────────────
    if (this.tickInProgress) {
      this.tickConsecutiveSkips++;
      if (this.tickConsecutiveSkips <= 3 || this.tickConsecutiveSkips % 10 === 0) {
        console.warn(`[agent] Tick skipped — previous tick still in progress (skip #${this.tickConsecutiveSkips})`);
      }
      return;
    }
    this.tickInProgress = true;
    this.tickConsecutiveSkips = 0;

    try {
      await this.tickInner();
    } catch (err) {
      console.error(`[agent] Uncaught tick error: ${(err as Error).message}`);
      this.recordTickError(`Uncaught: ${(err as Error).message}`);
    } finally {
      this.tickInProgress = false;
    }
  }

  /// Inner tick logic (runs under overlap guard)
  private async tickInner(): Promise<void> {
    let criticalError = false;

    // 1. Scan pools (critical — feeds all downstream phases)
    const scanned = await this.tickScanPools();
    if (!scanned) {
      this.recordTickError('Pool scan failed completely');
      return;
    }

    // 1b. Enrich: runtime-resolved identity + TVL fill + pair risk (#0/#2).
    // Scoring on raw scanner labels mislabels pools — fall back only if the
    // whole enrichment pass dies, and say so.
    let rawPools = scanned;
    try {
      rawPools = await enrichPools(this.gateway, scanned);
    } catch (err) {
      console.error(`[agent] Enrichment failed (scoring on raw scan labels): ${(err as Error).message}`);
    }

    const pools = rawPools.map((p) => ({
      address: p.address,
      protocol: p.protocol,
      apy: p.apy,
      tvl: p.tvl,
      audited: p.audited,
    }));

    // 2. Score and log (non-critical). Scoring runs EVERY tick — `scored` feeds
    // the exit guards and rotation below. Only the writes are throttled: every
    // reader of these tables works in hours, so a row a minute was ~60x more
    // than anything consumed.
    let scored: ScoredPool[] = [];
    try {
      const persist = Date.now() - this.state.lastPersist >= CONFIG.SNAPSHOT_INTERVAL_MS;
      if (persist) {
        this.logSnapshots(pools);
        // Stamp as soon as the snapshot lands, NOT after scoring: if scoreAll
        // throws below, the next tick must not re-write snapshots — a scorer
        // failing every tick is exactly the per-minute growth this throttle
        // exists to stop. Losing one score batch is harmless; only the newest
        // batch is ever read.
        this.state.lastPersist = Date.now();
      }
      const positions = this.getPositions();
      scored = this.scorer.scoreAll(rawPools, positions);
      if (persist) this.logScores(scored);
    } catch (err) {
      console.error(`[agent] Score/log error: ${(err as Error).message}`);
    }

    // 2b. Retention sweep (non-critical) — bounded growth for the two tables
    // above. Daily; nothing reads rows older than SNAPSHOT_RETENTION_DAYS.
    try {
      this.tickPrune();
    } catch (err) {
      console.error(`[agent] Prune error: ${(err as Error).message}`);
    }

    // 3. Check exit guards (non-critical) — surfaces exit signals for the user
    try {
      this.tickCheckExitGuards();
    } catch (err) {
      console.error(`[agent] Exit guard error: ${(err as Error).message}`);
    }

    // 4. Surface rebalance opportunities + weekly rotation proposals (advisory —
    // written to the DB for the UI; the user signs any move in their wallet).
    try {
      await this.tickAdvise(scored);
    } catch (err) {
      console.error(`[agent] Advise phase error: ${(err as Error).message}`);
      criticalError = true;
    }

    if (criticalError) {
      this.recordTickError('Critical phase failed');
    } else {
      // Clear errors and circuit breaker timestamps on successful tick
      this.state.errors = [];
      this.state.circuitBreaker.errorTimestamps = [];
    }
  }

  /// Phase 1: Scan all DEX pools. Returns null only if every scanner fails.
  private async tickScanPools(): Promise<PoolInfo[] | null> {
    try {
      // The XRD spot price is needed to express staking TVL in USD alongside
      // the DEX pools. A failed price lookup yields 0, which the staking
      // scanner reports as $0 TVL rather than inventing a figure.
      const xrdUsd = await getXrdUsdPrice().catch(() => 0);
      const scanResults = await Promise.allSettled([
        scanOciswap(this.gateway),
        scanCaviarNine(this.gateway),
        scanDefiPlaza(this.gateway),
        // IL-free venues. Without these the index contains only volatile LP
        // pairs — the one category that is structurally unprofitable on Radix
        // right now — so "best opportunities" could never be true. These are
        // also the three largest yield venues on the chain by TVL.
        scanStaking(this.gateway, xrdUsd),
        scanLsuPool(this.gateway, xrdUsd),
        scanWeftLending(this.gateway, xrdUsd),
      ]);
      const scanLabels = [
        'Ociswap',
        'CaviarNine',
        'DefiPlaza',
        'XRD staking',
        'CaviarNine LSU Pool',
        'Weft V2 lending',
      ];
      const rawPools: PoolInfo[] = [];
      for (let i = 0; i < scanResults.length; i++) {
        const r = scanResults[i];
        if (r.status === 'fulfilled') rawPools.push(...r.value);
        else console.error(`[pools] ${scanLabels[i]} failed: ${r.reason}`);
      }
      this.state.lastScan = Date.now();
      return rawPools;
    } catch (err) {
      console.error(`[agent] Scan error: ${(err as Error).message}`);
      return null;
    }
  }

  /// Phase 3: Check exit guards on active positions
  private tickCheckExitGuards(): void {
    const positions = this.getPositions();
    const exitSignals = this.rotation.checkExitGuards(positions);
    for (const signal of exitSignals) {
      console.log(`[agent] EXIT SIGNAL: ${signal.reason} (${signal.urgency})`);
      this.logAction('exit_signal', true, '', {
        positionId: signal.positionId,
        poolAddress: signal.poolAddress,
        reason: signal.reason,
        urgency: signal.urgency,
      });
    }
  }

  /// Phase 4: surface rebalance opportunities + weekly rotation proposals.
  /// Advisory only — checkRebalance logs opportunities and weeklyReview writes
  /// proposals to rotation_log; the user acts on them from the UI.
  private async tickAdvise(scored: ScoredPool[]): Promise<void> {
    this.checkRebalance(scored);

    if (this.shouldReviewThisWeek()) {
      const positions = this.getPositions();
      const proposals = this.rotation.weeklyReview(positions, scored);
      for (const p of proposals) {
        console.log(`[agent] Rotation proposed: ${p.fromProtocol} -> ${p.toProtocol} (+${p.estimatedGainBps}bps)`);
      }
      this.state.lastRotationReview = Date.now();
    }
  }

  /// Record a tick error and check circuit breaker
  private recordTickError(msg: string): void {
    console.error(`[agent] Tick error: ${msg}`);
    this.state.errors.push(msg);

    const now = Date.now();
    const window = CONFIG.CIRCUIT_BREAKER_WINDOW_MS;
    this.state.circuitBreaker.errorTimestamps.push(now);
    this.state.circuitBreaker.errorTimestamps =
      this.state.circuitBreaker.errorTimestamps.filter(t => now - t < window);

    if (this.state.circuitBreaker.errorTimestamps.length >= CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      console.error(
        `[agent] Circuit breaker tripped: ${CONFIG.CIRCUIT_BREAKER_THRESHOLD} failures within ${window / 1000}s — halting`
      );
      this.state.circuitBreaker.tripped = true;
      this.state.circuitBreaker.trippedAt = now;
      this.halt();
    }
  }

  /// Run the retention sweep — daily once caught up, every tick while behind.
  private tickPrune(): void {
    const DAY_MS = 86_400_000;
    if (Date.now() - this.state.lastPrune < DAY_MS) return;
    this.state.lastPrune = Date.now();
    const removed = pruneOldData(CONFIG.SNAPSHOT_RETENTION_DAYS);
    const total = removed.snapshots + removed.scores;
    if (total > 0) {
      console.log(
        `[agent] Pruned ${total} rows older than ${CONFIG.SNAPSHOT_RETENTION_DAYS}d ` +
          `(${removed.snapshots} snapshots, ${removed.scores} scores)` +
          (removed.capped ? ' — more remaining, resuming next tick' : ''),
      );
    }
    // A saturated sweep means there is still a backlog. Pinning the drain to
    // wall-clock days would take ~28 days to clear the current one, and would
    // never catch up at all if rows arrive faster than the daily ceiling
    // (reachable with SNAPSHOT_INTERVAL_MS lowered). Come back next tick.
    if (removed.capped) this.state.lastPrune = 0;
  }

  /// Newest snapshot write as epoch ms, or 0 when the table is empty.
  ///
  /// Ordered by `id`, not `scanned_at`: the rowid index makes this O(1), while
  /// MAX(scanned_at) measured 0.17s on 1.4M rows because no index leads with
  /// the time column. `id` is AUTOINCREMENT and `scanned_at` defaults to the
  /// insert time, so newest id == newest timestamp.
  private readLastPersistAt(): number {
    try {
      const row = getDb()
        .prepare('SELECT scanned_at FROM pool_snapshots ORDER BY id DESC LIMIT 1')
        .get() as { scanned_at: string } | undefined;
      return row ? parseSqliteUtc(row.scanned_at) : 0;
    } catch (err) {
      // A read failure must not stop the agent booting — worst case we write
      // one extra row this tick.
      console.error(`[agent] Could not read last snapshot time: ${(err as Error).message}`);
      return 0;
    }
  }

  /// Log pool data to database for history
  private logSnapshots(pools: PoolOpportunity[]): void {
    const db = getDb();
    // One bound timestamp per batch, same reasoning as logScores: readers
    // treat a batch as a single point in time. Transactional so a crash
    // mid-batch cannot leave half a scan on disk.
    const scannedAt = formatSqliteUtc(new Date());
    const insert = db.prepare(
      'INSERT INTO pool_snapshots (pool_address, protocol, tvl, apy_bps, scanned_at) VALUES (?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const pool of pools) {
        insert.run(pool.address, pool.protocol, pool.tvl, Math.round(pool.apy * 100), scannedAt);
      }
    })();
  }

  /// Log per-tick rebalance opportunities for operator visibility. Advisory
  /// only — the ranked, deduplicated proposals the UI acts on come from
  /// weeklyReview; this is a lightweight console signal, so it does NOT write to
  /// agent_log (a standing opportunity would append an identical row every tick,
  /// and nothing reads those rows — unbounded growth with no consumer).
  /// Compares NET-of-IL yield on both sides. It previously ranked candidates by
  /// gross `p.apy` against the position's stored gross `apy_bps`, so on a chain
  /// where every LP pool is net-negative it would happily advise rotating into
  /// a pool that loses MORE money, purely because its fee APY looked bigger.
  /// It also filtered on `p.audited`, which every scanner hardcodes to true.
  private checkRebalance(scored: ScoredPool[]): void {
    const db = getDb();
    const positions = db.prepare(
      "SELECT * FROM positions WHERE status = 'active'"
    ).all() as { pool_address: string; apy_bps: number | null; deposited_amount: string; protocol: string }[];

    // Dust floor. MIN_TVL_THRESHOLD defaults to $1,000,000, which no venue on
    // Radix can satisfy — the largest pool on the chain is ~$13k and the whole
    // chain is ~$1.29M — so this gate silently disabled the entire check. Read
    // it as an OPTIONAL override and fall back to a floor that actually
    // discriminates: enough to exclude the $39 and $99 dust pools without
    // excluding every real one.
    const configuredFloor = parseFloat(CONFIG.MIN_TVL_THRESHOLD);
    const tvlFloor =
      Number.isFinite(configuredFloor) && configuredFloor < 100_000
        ? configuredFloor
        : 1_000;

    const byAddress = new Map(scored.map((s) => [s.address, s]));

    for (const pos of positions) {
      // The position's CURRENT net yield, read from this tick's scoring rather
      // than from the stored gross apy_bps, so both sides are like-for-like.
      const current = byAddress.get(pos.pool_address);
      if (!current) continue;

      const better = scored.find(
        (p) =>
          p.address !== pos.pool_address &&
          parseFloat(p.tvl) >= tvlFloor &&
          p.netApyMa7d * 100 > current.netApyMa7d * 100 + CONFIG.MIN_REBALANCE_DIFF_BPS,
      );
      if (better) {
        console.log(
          `[agent] Rebalance opportunity: ${pos.protocol} (${current.netApyMa7d.toFixed(2)}% net) ` +
            `-> ${better.protocol} ${better.name} (${better.netApyMa7d.toFixed(2)}% net)`,
        );
      }
    }
  }

  /// Log an agent action
  private logAction(
    action: string,
    success: boolean,
    intentHash: string,
    details?: Record<string, unknown>,
  ): void {
    const db = getDb();
    db.prepare(
      'INSERT INTO agent_log (action, success, intent_hash, details) VALUES (?, ?, ?, ?)'
    ).run(action, success ? 1 : 0, intentHash, details ? JSON.stringify(details) : null);
  }

  /// Check if rotation review interval has elapsed
  private shouldReviewThisWeek(): boolean {
    return Date.now() - this.state.lastRotationReview >= CONFIG.ROTATION_REVIEW_INTERVAL_MS;
  }

  /// Persist scored pools to pool_scores table
  private logScores(scored: ScoredPool[]): void {
    const db = getDb();
    // computed_at is BOUND once for the whole batch, not left to the column
    // default. /api/opportunities pins its result set to the single newest
    // computed_at, so if the loop straddles a second boundary the endpoint
    // serves only the fragment that landed in the later second — and because
    // scoreAll sorts score-descending, that fragment is the LOWEST-ranked
    // tail. 10,562 such split batches exist in the live DB. At the old
    // per-minute cadence the next batch repaired it within 60s; at hourly it
    // would misreport the main screen for an hour.
    const computedAt = formatSqliteUtc(new Date());
    const insert = db.prepare(
      `INSERT INTO pool_scores
         (pool_address, protocol, score, apy_ma_7d, net_apy_ma_7d, estimated_il,
          il_risk_score, risk_adjusted_return, tvl_variance, classification, pool_name,
          yield_kind, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Transaction so a crash mid-batch leaves no partial ranking behind.
    db.transaction(() => {
      for (const s of scored) {
        insert.run(
          s.address, s.protocol, s.score, s.apyMa7d, s.netApyMa7d, s.estimatedIl,
          s.ilRiskScore, s.riskAdjustedReturn, s.tvlVariance, s.classification, s.name ?? null,
          s.yieldKind, computedAt,
        );
      }
    })();
  }

  /// Get active positions from DB
  getPositions(): Position[] {
    const db = getDb();
    return db.prepare(
      "SELECT * FROM positions WHERE status = 'active'",
    ).all() as Position[];
  }

  /// Get current agent state (for dashboard API)
  getState(): AgentState & { pendingTx: number } {
    const db = getDb();
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'"
    ).get() as { count: number };

    return {
      ...this.state,
      circuitBreaker: { ...this.state.circuitBreaker },
      pendingTx: pending.count,
    };
  }
}
