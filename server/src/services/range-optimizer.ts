/// Concentrated-liquidity range optimizer (MONETIZATION #3) — pure functions.
///
/// Picks the width that maximizes
///     feeAPR(width)·E[time in range] + E[IL(width)] − churn(width)
/// (IL and churn negative). Model: the pair's price ratio follows zero-drift
/// GBM with the enricher's relative annual vol σ, so ln p_t ~ N(−σ²t/2, σ²t)
/// (martingale convention, E[p_t] = 1). The churn term prices what the naive
/// fee×concentration objective misses: a tight range on a volatile pair exits
/// constantly, and every re-range costs a round trip.
///
/// Position value at ratio p for a range [rLo, rHi] with entry price 1
/// (MONETIZATION.md #3, Uniswap-v3-style):
///     V(p) = (2√p − p·√rLo − 1/√rHi) / (2 − √rLo − 1/√rHi),  V(1) = 1
/// Below the range the position is all base token (value linear in p); above,
/// all quote (value frozen) — IL freezes at the boundary AND fees stop, which
/// is why time-in-range weights the fee term.
///
/// The fee side scales with the capital-efficiency factor
///     C = 2 / (2 − √rLo − 1/√rHi)
/// (full range → 1, tight ranges → large): the same capital provides C× the
/// liquidity of a full-range position, so it earns ~C× the full-range fee APR
/// while the price is in range. Widths are symmetric multiples m (range
/// [1/m, m] × entry) — the deposit UI converts to a {loPrice, hiPrice} band.
///
/// Everything is a smooth model, not an oracle: expected-time-in-range ignores
/// path dependence (a range that exits can re-enter) and fee APR assumes the
/// pool's current fee run-rate holds. Good enough to rank widths, which is all
/// it is for.

export interface RangeChoice {
  /// Symmetric width multiple: range = [1/multiple, multiple] × entry price.
  multiple: number;
  /// Capital-efficiency factor C at this width.
  concentration: number;
  /// Expected fraction of the horizon spent in range (0..1).
  timeInRange: number;
  /// baseFeeApr · C · timeInRange (%/yr).
  feeApr: number;
  /// Expected concentrated IL, annualized (%/yr, ≤ 0).
  ilApr: number;
  /// Expected range exits per year (first-passage: σ²/ln(m)², capped at 365).
  exitsPerYear: number;
  /// Churn drag: exitsPerYear · rerangeCostRate (%/yr, ≤ 0).
  rerangeApr: number;
  /// feeApr + ilApr + rerangeApr — the ranking objective (%/yr).
  netApr: number;
}

const DEFAULT_CANDIDATES = [1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];

function assertRange(rLo: number, rHi: number): void {
  if (!(rLo > 0 && rLo < 1 && rHi > 1)) {
    throw new Error(`range must straddle entry: 0 < rLo < 1 < rHi (got ${rLo}, ${rHi})`);
  }
}

/// Position value at price ratio p (entry 1 inside [rLo, rHi]), V(1) = 1.
export function concentratedValue(p: number, rLo: number, rHi: number): number {
  assertRange(rLo, rHi);
  if (!(p > 0)) throw new Error(`price ratio must be positive (got ${p})`);
  const d = 2 - Math.sqrt(rLo) - 1 / Math.sqrt(rHi);
  const inside = (x: number) => (2 * Math.sqrt(x) - x * Math.sqrt(rLo) - 1 / Math.sqrt(rHi)) / d;
  if (p <= rLo) return inside(rLo) * (p / rLo); // all base token — value tracks p
  if (p >= rHi) return inside(rHi); // all quote token — value frozen
  return inside(p);
}

/// Concentrated IL vs holding the entry 50/50 basket: V(p)/H(p) − 1, H = (1+p)/2.
export function concentratedIl(p: number, rLo: number, rHi: number): number {
  return concentratedValue(p, rLo, rHi) / ((1 + p) / 2) - 1;
}

/// Capital-efficiency multiplier vs a full-range position.
export function concentrationFactor(rLo: number, rHi: number): number {
  assertRange(rLo, rHi);
  return 2 / (2 - Math.sqrt(rLo) - 1 / Math.sqrt(rHi));
}

/// Abramowitz–Stegun 7.1.26 erf (|err| < 1.5e-7) — plenty for width ranking.
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return s * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/// P(rLo < p_t < rHi) under ln p_t ~ N(−σ²t/2, σ²t).
export function probInRange(rLo: number, rHi: number, sigma: number, tYears: number): number {
  assertRange(rLo, rHi);
  if (sigma <= 0 || tYears <= 0) return 1;
  const sd = sigma * Math.sqrt(tYears);
  const mu = -(sigma * sigma * tYears) / 2;
  return normCdf((Math.log(rHi) - mu) / sd) - normCdf((Math.log(rLo) - mu) / sd);
}

/// Expected fraction of the horizon in range — average of probInRange over the
/// horizon (ignores path dependence; documented approximation).
export function expectedTimeInRange(
  rLo: number,
  rHi: number,
  sigma: number,
  horizonYears: number,
  steps = 12,
): number {
  if (sigma <= 0 || horizonYears <= 0) return 1;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    sum += probInRange(rLo, rHi, sigma, (horizonYears * (i + 0.5)) / steps);
  }
  return sum / steps;
}

/// E[IL_conc at the horizon] over the lognormal terminal ratio (boundary-frozen
/// V outside the range). Plain quadrature over z ∈ [−4, 4].
export function expectedConcentratedIl(
  rLo: number,
  rHi: number,
  sigma: number,
  horizonYears: number,
  nodes = 41,
): number {
  if (sigma <= 0 || horizonYears <= 0) return 0;
  const sd = sigma * Math.sqrt(horizonYears);
  const mu = -(sd * sd) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < nodes; i++) {
    const z = -4 + (8 * i) / (nodes - 1);
    const w = Math.exp(-(z * z) / 2);
    num += w * concentratedIl(Math.exp(mu + sd * z), rLo, rHi);
    den += w;
  }
  return num / den;
}

/// Expected range exits per year: driftless first-passage from a symmetric
/// log-band ±b takes E[τ] ≈ b²/σ², so exits ≈ σ²/b², b = ln(m). Capped at 365
/// (nobody re-ranges more than daily). This is what stops a 41×-concentration
/// ±5% range from "winning" on a 67%-vol pair — each exit costs a re-range.
export function expectedExitsPerYear(multiple: number, sigma: number): number {
  if (!(multiple > 1)) throw new Error(`width multiple must be > 1 (got ${multiple})`);
  if (sigma <= 0) return 0;
  const b = Math.log(multiple);
  return Math.min(365, (sigma * sigma) / (b * b));
}

export interface OptimizeRangeParams {
  /// Full-range fee APR % the pool pays today (e.g. its gross apyMa7d).
  baseFeeApr: number;
  /// Annualized vol of the pair's price ratio (PoolRisk.relAnnualVol).
  relAnnualVol: number;
  horizonDays?: number;
  /// Round-trip cost of one re-range as a fraction of the position (swap fees +
  /// slippage; flat gas is position-size-dependent and charged by the #5 gate).
  rerangeCostRate?: number;
  /// Symmetric width multiples to search.
  candidates?: number[];
}

/// Rank candidate widths by expected net APR and return the winner.
/// Ties break toward the WIDER range (less rebalance churn for the same net).
export function optimizeRange(params: OptimizeRangeParams): RangeChoice {
  const { baseFeeApr, relAnnualVol } = params;
  const horizonYears = (params.horizonDays ?? 30) / 365;
  const rerangeCostRate = params.rerangeCostRate ?? 0.005;
  const candidates = params.candidates?.length ? params.candidates : DEFAULT_CANDIDATES;

  let best: RangeChoice | null = null;
  for (const m of candidates) {
    if (!(m > 1)) throw new Error(`width multiple must be > 1 (got ${m})`);
    const rLo = 1 / m;
    const rHi = m;
    const concentration = concentrationFactor(rLo, rHi);
    const timeInRange = expectedTimeInRange(rLo, rHi, relAnnualVol, horizonYears);
    const feeApr = Math.max(0, baseFeeApr) * concentration * timeInRange;
    const ilApr =
      (expectedConcentratedIl(rLo, rHi, relAnnualVol, horizonYears) / horizonYears) * 100;
    const exitsPerYear = expectedExitsPerYear(m, relAnnualVol);
    const rerangeApr = -exitsPerYear * rerangeCostRate * 100;
    const netApr = feeApr + ilApr + rerangeApr;
    const choice: RangeChoice = {
      multiple: m,
      concentration: Math.round(concentration * 100) / 100,
      timeInRange: Math.round(timeInRange * 1000) / 1000,
      feeApr: Math.round(feeApr * 100) / 100,
      ilApr: Math.round(ilApr * 100) / 100,
      exitsPerYear: Math.round(exitsPerYear * 10) / 10,
      rerangeApr: Math.round(rerangeApr * 100) / 100,
      netApr: Math.round(netApr * 100) / 100,
    };
    if (!best || choice.netApr > best.netApr || (choice.netApr === best.netApr && m > best.multiple)) {
      best = choice;
    }
  }
  return best!;
}
