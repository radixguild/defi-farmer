/// OpportunityScorer — ranks pools by composite score on NET-of-IL yield
/// (MONETIZATION #1): a 40%-gross pool bleeding IL must rank below a safe 15%
/// pool, so the APY component uses netApy = grossApy + estimatedIl (IL negative,
/// from the enricher's vol/correlation feed) and an explicit IL-risk component
/// penalizes volatile, uncorrelated pairs.
/// Weights: net APY 45%, TVL stability 15%, IL risk 15%, diversity 15%,
/// APY source 10%. (The former 10% "audit" component was removed — every
/// scanner hardcoded audited:true, so it was a constant masquerading as a
/// verified signal.)
/// IL-free venues (yieldKind 'staking' | 'lending') take estimatedIl = 0 and
/// ilRiskScore = 0: they hold a single exposure, so no pair can diverge.
/// Stateless class — DB access only inside methods.

import { CONFIG } from '../config.js';
import { getDb } from '../db/schema.js';
import type { Position } from '../db/schema.js';
import type { PoolInfo, YieldKind } from './gateway.js';
import {
  FALLBACK_RISK_FREE_RATE_PCT,
  calculateIlRiskScore,
  calculateRiskAdjustedReturn,
} from './calculators.js';
import { DEFAULT_RISK } from './pool-enricher.js';

export interface ScoredPool extends PoolInfo {
  score: number;
  apyMa7d: number;
  /// apyMa7d + estimatedIl — what ranking and allocation run on.
  netApyMa7d: number;
  /// Expected annual IL % (negative) from the pair's vol/correlation.
  estimatedIl: number;
  /// 0 (none) .. 100 (extreme) — calculators.calculateIlRiskScore.
  ilRiskScore: number;
  /// Sharpe-like excess-net-return / risk — the allocator's Kelly confidence input.
  riskAdjustedReturn: number;
  tvlVariance: number;
  classification: 'stable' | 'rotational';
  /// Resolved yield mechanism; 'amm-lp' unless a scanner declared otherwise.
  yieldKind: YieldKind;
}

// Stable pair keywords
const STABLE_KEYWORDS = ['USDC', 'USDT', 'ETH', 'WBTC'];
// Strict stablecoins (for IL risk — ETH/WBTC are blue-chip, not stable)
const STABLECOIN_RE = /USDC|USDT|XUSD|DAI/;

export class OpportunityScorer {
  /** Classify a pool as stable or rotational based on token pair names */
  classifyPool(pool: PoolInfo): 'stable' | 'rotational' {
    const name = pool.name.toUpperCase();
    const tokenA = pool.tokenA.toUpperCase();
    const tokenB = pool.tokenB.toUpperCase();
    for (const kw of STABLE_KEYWORDS) {
      if (name.includes(kw) || tokenA.includes(kw) || tokenB.includes(kw)) {
        return 'stable';
      }
    }
    return 'rotational';
  }

  /**
   * The return available with NO divergence risk, taken from the scanned set
   * itself — the staking row's own APY — rather than from a hardcoded guess.
   * Falls back to the last measured value if staking failed to scan.
   */
  private riskFreeRate(pools: PoolInfo[]): number {
    const staking = pools.find((p) => p.yieldKind === 'staking');
    return staking && staking.apy > 0 ? staking.apy : FALLBACK_RISK_FREE_RATE_PCT;
  }

  /** Score all pools and return sorted by score descending */
  scoreAll(pools: PoolInfo[], positions: Position[]): ScoredPool[] {
    // 'unsupported' = the deposit builder refuses the blueprint — never rank it.
    const supported = pools.filter((p) => p.kind !== 'unsupported');

    // Dust floor. Scanning past Ociswap's first page surfaced pools holding
    // $1–$110 whose APR is a single swap annualised into a huge number; ranked
    // on yield they landed at the TOP of Discover. They are also uninvestable
    // at any size this app suggests. Excluded only when TVL is known and
    // positive — a 0 means unreadable reserves, not dust.
    //
    // A TVL of 0 used to be EXEMPT from the floor, on the reasoning that 0 means
    // "reserves unreadable" rather than "empty". That exemption cannot tell those
    // two apart, and it defaulted to include — so xETH-XRD, a verifiably empty
    // DefiPlaza pool, shipped to Discover carrying a precise-looking "-21.67%
    // net APY" computed entirely from other venues' price feeds, beside a
    // "0.00% fees" that was a hardcoded unknown, not a measurement.
    //
    // Unreadable and empty are now treated the same way, because for a user they
    // ARE the same: a pool we cannot price is a pool we must not rank. Staking
    // and lending carry no pool reserves and are exempt by kind, not by number.
    const dustFloor = parseFloat(CONFIG.MIN_POOL_TVL_USD);
    const unpriced: string[] = [];
    const scorable = supported.filter((p) => {
      // `yieldKind` undefined MEANS amm-lp (see PoolInfo) — the conservative
      // default. Testing `!== 'amm-lp'` would have waived the check for every
      // pool whose scanner omits the field, i.e. most of them.
      if ((p.yieldKind ?? 'amm-lp') !== 'amm-lp') return true;
      const tvl = parseFloat(p.tvl);
      if (!Number.isFinite(tvl) || tvl <= 0) {
        unpriced.push(p.name);
        return false;
      }
      return tvl >= dustFloor;
    });
    const dropped = supported.length - scorable.length;
    if (dropped > 0) {
      // Never truncate coverage silently — the count belongs in the log so a
      // shrinking index is visible rather than looking like full coverage.
      console.log(
        `[scorer] Excluded ${dropped} pool(s) below the $${dustFloor} dust floor ` +
          `(${scorable.length} ranked of ${supported.length} scanned)`,
      );
    }
    if (unpriced.length > 0) {
      console.log(
        `[scorer] Excluded ${unpriced.length} pool(s) with unreadable or zero TVL: ` +
          unpriced.join(', '),
      );
    }

    const riskFree = this.riskFreeRate(scorable);

    const positionsByPool = new Map<string, Position[]>();
    for (const p of positions) {
      const existing = positionsByPool.get(p.pool_address) ?? [];
      existing.push(p);
      positionsByPool.set(p.pool_address, existing);
    }

    // Count pools per protocol for diversity scoring
    const protocolCounts = new Map<string, number>();
    for (const pool of scorable) {
      protocolCounts.set(pool.protocol, (protocolCounts.get(pool.protocol) ?? 0) + 1);
    }
    const totalPools = scorable.length || 1;

    const scored = scorable.map((pool) =>
      this.scorePool(pool, positionsByPool, protocolCounts, totalPools, riskFree),
    );
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private scorePool(
    pool: PoolInfo,
    positionsByPool: Map<string, Position[]>,
    protocolCounts: Map<string, number>,
    totalPools: number,
    riskFreeRate: number,
  ): ScoredPool {
    const classification = this.classifyPool(pool);
    const apyMa7d = this.computeApyMa7d(pool);
    const tvlVariance = this.computeTvlVariance(pool);

    // Net-of-IL yield + risk from the enricher's pair feed (skeptical default
    // when a pool arrives unenriched).
    //
    // IL-free venues short-circuit this entirely. Staking and single-asset
    // lending hold ONE exposure, so there is no pair to diverge and no
    // impermanent loss to subtract — running them through the pair model would
    // charge them a fabricated ~12-20%/yr penalty and bury the only positive
    // net yields on the chain beneath the LP pools they beat.
    const yieldKind = pool.yieldKind ?? 'amm-lp';
    const ilFree = yieldKind !== 'amm-lp';
    const risk = pool.risk ?? DEFAULT_RISK;
    const estimatedIl = ilFree ? 0 : risk.estimatedIlPct;
    const netApyMa7d = apyMa7d + estimatedIl;
    const hasStablecoin = STABLECOIN_RE.test(pool.name.toUpperCase());
    const ilRiskScore = ilFree
      ? 0
      : calculateIlRiskScore({
          volatility: risk.volatility,
          correlation: risk.correlation,
          hasStablecoin,
        });
    // IL-free venues carry no PAIR volatility — there is no second asset to
    // diverge against. Passing the enricher's default (100% annualised, the
    // skeptical prior for an unknown pair) charged native staking a divergence
    // risk it cannot have, which alone dragged its risk-adjusted return to
    // -3.23 despite a positive, riskless 6.06% net yield.
    const riskAdjustedReturn = calculateRiskAdjustedReturn({
      apyPercent: apyMa7d,
      ilPercent: estimatedIl,
      ilRiskScore,
      volatility: ilFree ? 0 : risk.volatility,
      riskFreeRate,
    });

    // Net APY component (45%) — 0-100 scale; a net-negative pool earns nothing
    // here. Note this clamps at 0, so when EVERY pool is net-negative (the
    // situation on Radix today) this term is 0 across the board and the score
    // stops carrying any yield signal at all. That is why `/api/opportunities`
    // ranks on riskAdjustedReturn rather than on `score`.
    const apyScore = Math.min(Math.max(netApyMa7d, 0), 100) * 0.45;

    // TVL stability component (15%) — lower variance is better
    // variance of 0 = perfect score, variance of 1+ = 0 score
    const tvlScore = Math.max(0, 1 - tvlVariance) * 100 * 0.15;

    // IL-risk component (15%) — calmer pairs score higher
    const riskScore = (100 - ilRiskScore) * 0.15;

    // The former "audit component" (10%) is gone. Every scanner hardcodes
    // `audited: true`, so it awarded an identical 10 points to all pools while
    // implying a verification that had never happened. Its weight moved to the
    // net-APY term. Reinstate only from real per-protocol audit data.

    // Diversity component (15%) — fewer pools in protocol = more diversity value
    const protocolShare = (protocolCounts.get(pool.protocol) ?? 1) / totalPools;
    const diversityScore = (1 - protocolShare) * 100 * 0.15;

    // APY source quality component (10%)
    const sourceScoreMap = { live: 100, estimated: 60, unknown: 20 };
    const sourceScore = (sourceScoreMap[pool.apySource] ?? 20) * 0.1;

    const score = Math.min(
      100,
      Math.max(0, apyScore + tvlScore + riskScore + diversityScore + sourceScore),
    );

    return {
      ...pool,
      score: Math.round(score * 100) / 100,
      apyMa7d,
      netApyMa7d: Math.round(netApyMa7d * 100) / 100,
      estimatedIl: Math.round(estimatedIl * 100) / 100,
      ilRiskScore,
      riskAdjustedReturn,
      tvlVariance,
      classification,
      yieldKind,
    };
  }

  /**
   * Compute 7d APY moving average from pool_snapshots; fallback to pool.apy.
   *
   * SKIPPED for venues whose scanner already reports a realized figure measured
   * over a trailing window (LSULP, Weft — both derive yield from a redemption
   * ratio over a fixed 30 days). Averaging those again produced a number that
   * matched neither the label nor the venue: the rows are literally named
   * "(realized, trailing 30d)" while serving a 7-day mean OF those 30d readings.
   * Measured 2026-08-02 — Weft published 4.40% against a true trailing-30d
   * 3.89%, a +13% relative overstatement, and higher than that venue's realized
   * yield over EVERY window from 7d to 365d. A 30-day window is already smooth;
   * the second average only added lag and a false label.
   */
  private computeApyMa7d(pool: PoolInfo): number {
    if (pool.apyWindowDays && pool.apyWindowDays >= 7) return pool.apy;

    const db = getDb();
    const snapshots = db
      .prepare(
        `SELECT apy_bps FROM pool_snapshots
         WHERE pool_address = ? AND scanned_at >= datetime('now', '-7 days')
         ORDER BY scanned_at DESC`,
      )
      .all(pool.address) as Array<{ apy_bps: number }>;

    if (snapshots.length === 0) return pool.apy;

    const avg = snapshots.reduce((sum, s) => sum + s.apy_bps, 0) / snapshots.length;
    return avg / 100; // bps to percentage
  }

  /** Compute TVL variance over 7d snapshots (normalized coefficient of variation) */
  private computeTvlVariance(pool: PoolInfo): number {
    const db = getDb();
    const snapshots = db
      .prepare(
        `SELECT tvl FROM pool_snapshots
         WHERE pool_address = ? AND scanned_at >= datetime('now', '-7 days')
         ORDER BY scanned_at DESC`,
      )
      .all(pool.address) as Array<{ tvl: string }>;

    if (snapshots.length < 2) return 0;

    const values = snapshots.map((s) => parseFloat(s.tvl));
    return computeVariance(values);
  }
}

/** Compute coefficient of variation (stddev / mean). Returns 0 if mean is 0. */
function computeVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
