/// Portfolio Allocator — Kelly-criterion allocation optimizer.
///
/// Replaces the naive "pick best pool" logic with proper portfolio optimization.
/// Uses fractional Kelly criterion to size positions, enforces diversification
/// constraints (max pool %, max protocol %), and generates ranked rotation proposals.
///
/// All functions are pure (no DB, no side effects) for testability.

import type { ScoredPool } from './scorer.js';
import type { Position } from '../db/schema.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AllocationTarget {
  poolAddress: string;
  protocol: string;
  /** Expected NET-of-IL APY (percentage) — what sizing runs on */
  expectedApy: number;
  /** Kelly win-probability (0-1), derived from ScoredPool.riskAdjustedReturn */
  confidence: number;
  /** Kelly fraction: optimal % of portfolio to allocate (0-1) */
  kellyFraction: number;
  /** Actual allocation in XRD */
  allocationXrd: number;
}

export interface RotationInstruction {
  fromPool: string;
  fromProtocol: string;
  toPool: string;
  toProtocol: string;
  amountXrd: number;
  reason: string;
  expectedGainBps: number;
  priority: 'high' | 'medium' | 'low';
}

export interface AllocatorConfig {
  /** Maximum fraction of portfolio in a single pool (default 0.40 = 40%) */
  maxPoolFraction: number;
  /** Maximum fraction of portfolio in a single protocol (default 0.60 = 60%) */
  maxProtocolFraction: number;
  /** Fractional Kelly multiplier (default 0.5 = half Kelly for safety) */
  kellyFraction: number;
  /** Risk-free rate as percentage (default 8% for Radix native staking) */
  riskFreeRate: number;
  /** Minimum allocation to trigger a rotation (XRD, default 10) */
  minRotationAmount: number;
  /** Minimum APY gain in bps to trigger rotation (default 200 = 2%) */
  minRotationGainBps: number;
}

const DEFAULT_CONFIG: AllocatorConfig = {
  maxPoolFraction: 0.40,
  maxProtocolFraction: 0.60,
  kellyFraction: 0.5,
  riskFreeRate: 8,
  minRotationAmount: 10,
  minRotationGainBps: 200,
};

// ─── Kelly Criterion ─────────────────────────────────────────────────────────

/**
 * Compute Kelly fraction for a single opportunity.
 *
 * f* = (p * b - q) / b
 *
 * Where:
 *   p = confidence (probability of delivering advertised APY)
 *   b = odds ratio = (expectedApy - riskFree) / riskFree
 *   q = 1 - p
 *
 * Returns 0-1 fraction. Clamped to [0, 1].
 * Returns 0 for negative expected value (no edge).
 */
export function kellyFraction(confidence: number, expectedApy: number, riskFreeRate: number): number {
  if (confidence <= 0 || expectedApy <= riskFreeRate) return 0;

  const b = (expectedApy - riskFreeRate) / riskFreeRate;
  if (b <= 0) return 0;

  const q = 1 - confidence;
  const f = (confidence * b - q) / b;

  return Math.max(0, Math.min(1, f));
}

/**
 * Map the Sharpe-like riskAdjustedReturn onto Kelly's win probability
 * (MONETIZATION #1 — replaces the score/maxScore proxy, which measured relative
 * rank, not delivery odds). Logistic centered at 0: RAR 0 (net return = risk-free)
 * → coin-flip 0.5; RAR ±4 saturates near 0.88/0.12.
 */
export function rarToConfidence(riskAdjustedReturn: number): number {
  return 1 / (1 + Math.exp(-riskAdjustedReturn / 2));
}

// ─── Allocation Engine ───────────────────────────────────────────────────────

/**
 * Compute optimal allocation targets from scored pools and current positions.
 *
 * Algorithm:
 * 1. Convert scored pools to candidate targets with Kelly fractions
 * 2. Filter out pools with zero or negative edge
 * 3. Sort by expected return (confidence × APY)
 * 4. Apply fractional Kelly multiplier
 * 5. Enforce diversification caps (pool-level and protocol-level)
 * 6. Return final allocations
 */
export function computeAllocation(
  scored: ScoredPool[],
  positions: Position[],
  config: Partial<AllocatorConfig> = {},
): AllocationTarget[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Compute total portfolio value in XRD
  const totalValue = positions.reduce((sum, p) => {
    const val = parseFloat(p.current_value ?? p.deposited_amount);
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  if (totalValue <= 0 || scored.length === 0) return [];

  // Convert scored pools to candidate targets: size on NET-of-IL APY, with
  // Kelly's p from the risk-adjusted return (not relative rank).
  const candidates: AllocationTarget[] = scored.map(s => {
    const confidence = rarToConfidence(s.riskAdjustedReturn);
    const rawKelly = kellyFraction(confidence, s.netApyMa7d, cfg.riskFreeRate);
    const fraction = rawKelly * cfg.kellyFraction;

    return {
      poolAddress: s.address,
      protocol: s.protocol,
      expectedApy: s.netApyMa7d,
      confidence: Math.round(confidence * 1000) / 1000,
      kellyFraction: Math.round(fraction * 10000) / 10000,
      allocationXrd: Math.round(fraction * totalValue * 100) / 100,
    };
  });

  // Filter: must have positive allocation and confidence
  const viable = candidates.filter(c => c.allocationXrd > 0 && c.confidence > 0.1);
  if (viable.length === 0) return [];

  // Sort by expected return (confidence × APY), descending
  viable.sort((a, b) => (b.confidence * b.expectedApy) - (a.confidence * a.expectedApy));

  // Enforce diversification caps
  const poolCaps = new Map<string, number>();
  const protocolCaps = new Map<string, number>();
  let allocatedTotal = 0;

  for (const target of viable) {
    const poolCap = Math.round(totalValue * cfg.maxPoolFraction * 100) / 100;
    const protocolCap = Math.round(totalValue * cfg.maxProtocolFraction * 100) / 100;

    const poolUsed = poolCaps.get(target.poolAddress) ?? 0;
    const protocolUsed = protocolCaps.get(target.protocol) ?? 0;

    const poolRemaining = Math.max(0, poolCap - poolUsed);
    const protocolRemaining = Math.max(0, protocolCap - protocolUsed);

    // Clamp allocation to remaining caps
    const capped = Math.min(target.allocationXrd, poolRemaining, protocolRemaining);
    target.allocationXrd = Math.round(capped * 100) / 100;

    poolCaps.set(target.poolAddress, poolUsed + target.allocationXrd);
    protocolCaps.set(target.protocol, protocolUsed + target.allocationXrd);
    allocatedTotal += target.allocationXrd;
  }

  // Remove zero allocations after capping
  return viable.filter(c => c.allocationXrd > 0);
}

// ─── Rotation Proposal Generator ────────────────────────────────────────────

/**
 * Generate rotation instructions: move from current underperforming positions
 * to optimized allocation targets.
 *
 * Rules:
 * - Never exit a position that's within minRotationGainBps of its target
 * - Respect minRotationAmount threshold
 * - Prioritize largest APY gaps
 */
export function generateRotations(
  current: Position[],
  targets: AllocationTarget[],
  config: Partial<AllocatorConfig> = {},
): RotationInstruction[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const instructions: RotationInstruction[] = [];

  // Build lookup from pool address to target allocation
  const targetMap = new Map<string, AllocationTarget>();
  for (const t of targets) {
    targetMap.set(t.poolAddress, t);
  }

  // Map current positions by pool
  const currentByPool = new Map<string, { amount: number; apyBps: number; protocol: string }>();
  for (const pos of current) {
    if (pos.status !== 'active') continue;
    const amount = parseFloat(pos.current_value ?? pos.deposited_amount);
    if (isNaN(amount) || amount <= 0) continue;
    const existing = currentByPool.get(pos.pool_address);
    if (existing) {
      existing.amount += amount;
    } else {
      currentByPool.set(pos.pool_address, {
        amount,
        apyBps: pos.apy_bps ?? 0,
        protocol: pos.protocol,
      });
    }
  }

  // For each target, check if we need to rotate into it
  for (const target of targets) {
    const targetApyBps = Math.round(target.expectedApy * 100);
    const currentInTarget = currentByPool.get(target.poolAddress);

    // If we already hold this pool, check if we need more
    if (currentInTarget) {
      const deficit = target.allocationXrd - currentInTarget.amount;
      if (deficit <= cfg.minRotationAmount) continue;
      const source = findWorstPosition(currentByPool, target.poolAddress, deficit, cfg);
      if (source) {
        const gainBps = targetApyBps - source.apyBps;
        if (gainBps >= cfg.minRotationGainBps) {
          const rotateAmount = Math.min(deficit, source.amountAvailable);
          instructions.push({
            fromPool: source.poolAddress,
            fromProtocol: source.protocol,
            toPool: target.poolAddress,
            toProtocol: target.protocol,
            amountXrd: rotateAmount,
            reason: `APY gain: +${gainBps}bps (${source.apyBps} → ${targetApyBps}), target alloc: ${target.allocationXrd.toFixed(0)} XRD`,
            expectedGainBps: gainBps,
            priority: gainBps >= 500 ? 'high' : gainBps >= 300 ? 'medium' : 'low',
          });
          deductFromPool(currentByPool, source.poolAddress, rotateAmount);
        }
      }
      continue;
    }

    // New pool — rotate from worst performer until allocation is filled
    let needed = target.allocationXrd;

    while (needed > cfg.minRotationAmount) {
      const source = findWorstPosition(currentByPool, target.poolAddress, needed, cfg);
      if (!source) break;

      const gainBps = targetApyBps - source.apyBps;
      if (gainBps < cfg.minRotationGainBps) break;

      const rotateAmount = Math.min(needed, source.amountAvailable);
      instructions.push({
        fromPool: source.poolAddress,
        fromProtocol: source.protocol,
        toPool: target.poolAddress,
        toProtocol: target.protocol,
        amountXrd: rotateAmount,
        reason: `New allocation: ${target.expectedApy.toFixed(1)}% APY (score: ${target.confidence.toFixed(2)}), target: ${target.allocationXrd.toFixed(0)} XRD`,
        expectedGainBps: gainBps,
        priority: target.confidence >= 0.7 ? 'high' : 'medium',
      });
      deductFromPool(currentByPool, source.poolAddress, rotateAmount);
      needed -= rotateAmount;
    }
  }

  // Sort by priority then expected gain
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  instructions.sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority] || b.expectedGainBps - a.expectedGainBps
  );

  return instructions;
}

// ─── Rebalance gate (MONETIZATION #5) ───────────────────────────────────────

export interface RebalanceCosts {
  /** Flat gas for the exit + enter transactions (XRD) */
  gasXrd: number;
  /** Round-trip pool fee rate on the moved amount (e.g. 0.003) */
  swapFeeRate: number;
  /** Price-impact estimate on the moved amount */
  slippageRate: number;
  /** Pending IL the exit REALIZES, % of the moved amount (≤ 0 or 0 if unknown) */
  realizedIlPct: number;
}

export const DEFAULT_REBALANCE_COSTS: RebalanceCosts = {
  gasXrd: 20, // two manifests at MAX_GAS_XRD's default of 10 XRD each, a flat estimate
  swapFeeRate: 0.003,
  slippageRate: 0.002,
  realizedIlPct: 0,
};

export interface RebalanceDecision {
  act: boolean;
  /** Extra yield captured over the horizon (XRD) */
  gain: number;
  /** Gas + fees + slippage + realized IL (XRD) */
  cost: number;
  /** gain − cost (XRD) */
  benefit: number;
}

/**
 * Net-benefit gate: rotate only if
 *   Δ(netAPY)·horizon·amount − gas − swap/slippage − realizedIL > 0.
 * A +200bps hop on 300 XRD earns ~1.5 XRD/quarter — less than the gas to move
 * it. APY-threshold rules can't see that; this gate is value-aware.
 */
export function rebalanceNetBenefit(params: {
  gainBps: number;
  amountXrd: number;
  horizonDays?: number;
  costs?: Partial<RebalanceCosts>;
}): RebalanceDecision {
  const { gainBps, amountXrd } = params;
  const horizonDays = params.horizonDays ?? 30;
  const c = { ...DEFAULT_REBALANCE_COSTS, ...params.costs };
  const gain = Math.max(0, gainBps / 10_000) * amountXrd * (horizonDays / 365);
  const cost =
    c.gasXrd + amountXrd * (c.swapFeeRate + c.slippageRate) + amountXrd * (Math.abs(c.realizedIlPct) / 100);
  const benefit = gain - cost;
  return {
    act: benefit > 0,
    gain: Math.round(gain * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    benefit: Math.round(benefit * 100) / 100,
  };
}

/** Deduct an amount from a pool in the currentByPool map. Removes entry if fully consumed. */
function deductFromPool(
  map: Map<string, { amount: number; apyBps: number; protocol: string }>,
  poolAddress: string,
  amount: number,
): void {
  const entry = map.get(poolAddress);
  if (!entry) return;
  entry.amount -= amount;
  if (entry.amount <= 0) map.delete(poolAddress);
}

/** Find the worst-performing position to exit, excluding the target pool itself. */
function findWorstPosition(
  currentByPool: Map<string, { amount: number; apyBps: number; protocol: string }>,
  excludePool: string,
  minAmount: number,
  cfg: AllocatorConfig,
): { poolAddress: string; protocol: string; amountAvailable: number; apyBps: number } | null {
  let worst: { poolAddress: string; protocol: string; amountAvailable: number; apyBps: number } | null = null;

  for (const [addr, pos] of currentByPool) {
    if (addr === excludePool) continue;
    if (pos.amount < cfg.minRotationAmount) continue;

    if (!worst || pos.apyBps < worst.apyBps) {
      worst = {
        poolAddress: addr,
        protocol: pos.protocol,
        amountAvailable: pos.amount,
        apyBps: pos.apyBps,
      };
    }
  }

  return worst;
}

// ─── Portfolio health summary ───────────────────────────────────────────────

export interface PortfolioSummary {
  totalValueXrd: number;
  poolCount: number;
  protocolCount: number;
  avgApy: number;
  /** Pool with highest concentration */
  maxPoolConcentration: { address: string; fraction: number };
  /** Protocol with highest concentration */
  maxProtocolConcentration: { protocol: string; fraction: number };
  /** Number of pools exceeding maxPoolFraction */
  overConcentratedPools: number;
  /** Number of protocols exceeding maxProtocolFraction */
  overConcentratedProtocols: number;
  diversificationScore: number; // 0-100, higher = better
}

export function summarizePortfolio(
  positions: Position[],
  config: Partial<AllocatorConfig> = {},
): PortfolioSummary {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const active = positions.filter(p => p.status === 'active');
  if (active.length === 0) {
    return {
      totalValueXrd: 0, poolCount: 0, protocolCount: 0, avgApy: 0,
      maxPoolConcentration: { address: '', fraction: 0 },
      maxProtocolConcentration: { protocol: '', fraction: 0 },
      overConcentratedPools: 0, overConcentratedProtocols: 0,
      diversificationScore: 100,
    };
  }

  // Total value
  const totalValue = active.reduce((sum, p) => {
    const val = parseFloat(p.current_value ?? p.deposited_amount);
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  // Average APY
  const avgApy = active.reduce((sum, p) => sum + (p.apy_bps ?? 0), 0) / active.length;

  // Pool concentrations
  const poolAmounts = new Map<string, number>();
  const protocolAmounts = new Map<string, number>();
  for (const pos of active) {
    const val = parseFloat(pos.current_value ?? pos.deposited_amount);
    if (isNaN(val)) continue;
    poolAmounts.set(pos.pool_address, (poolAmounts.get(pos.pool_address) ?? 0) + val);
    protocolAmounts.set(pos.protocol, (protocolAmounts.get(pos.protocol) ?? 0) + val);
  }

  // Max concentrations
  let maxPoolAddr = '', maxPoolFrac = 0;
  let maxProtoName = '', maxProtoFrac = 0;
  let overPool = 0, overProto = 0;

  for (const [addr, amt] of poolAmounts) {
    const frac = totalValue > 0 ? amt / totalValue : 0;
    if (frac > maxPoolFrac) { maxPoolFrac = frac; maxPoolAddr = addr; }
    if (frac > cfg.maxPoolFraction) overPool++;
  }

  for (const [proto, amt] of protocolAmounts) {
    const frac = totalValue > 0 ? amt / totalValue : 0;
    if (frac > maxProtoFrac) { maxProtoFrac = frac; maxProtoName = proto; }
    if (frac > cfg.maxProtocolFraction) overProto++;
  }

  // Diversification score: 100 = perfectly diversified, 0 = all in one
  // Based on Herfindahl-Hirschman Index (HHI)
  let hhi = 0;
  for (const amt of poolAmounts.values()) {
    const s = totalValue > 0 ? amt / totalValue : 0;
    hhi += s * s * 10000; // HHI scale 0-10000
  }
  // Convert HHI to diversification score (0-100)
  // HHI of 10000 (single pool) = score 0
  // HHI of 0 (infinite pools) = score 100
  const diversificationScore = Math.round(Math.max(0, 100 - (hhi / 100)));

  return {
    totalValueXrd: Math.round(totalValue * 100) / 100,
    poolCount: poolAmounts.size,
    protocolCount: protocolAmounts.size,
    avgApy: Math.round(avgApy / 100 * 100) / 100,
    maxPoolConcentration: { address: maxPoolAddr, fraction: Math.round(maxPoolFrac * 10000) / 10000 },
    maxProtocolConcentration: { protocol: maxProtoName, fraction: Math.round(maxProtoFrac * 10000) / 10000 },
    overConcentratedPools: overPool,
    overConcentratedProtocols: overProto,
    diversificationScore,
  };
}
