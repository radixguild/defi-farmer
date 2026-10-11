/// Yield calculators — APR, APY, impermanent loss, and risk-adjusted returns.
/// All functions are pure (no DB, no side effects) for easy testing.
/// Edge cases: zero liquidity, extreme price moves, very new pools.

// ─── APR Calculator ───────────────────────────────────────────────────────────

export interface AprInput {
  /** Total fees earned in the period (USD) */
  feesEarned: number;
  /** Total liquidity provided (USD) */
  liquidityProvided: number;
  /** Period length in days */
  periodDays: number;
}

/**
 * Calculate APR (Annual Percentage Rate) — simple, non-compounded.
 * Formula: (fees / liquidity) * (365 / periodDays) * 100
 *
 * Returns 0 for zero liquidity or zero/negative period.
 */
export function calculateApr(input: AprInput): number {
  const { feesEarned, liquidityProvided, periodDays } = input;
  if (liquidityProvided <= 0 || periodDays <= 0) return 0;
  if (feesEarned < 0) return 0;

  const rate = feesEarned / liquidityProvided;
  const annualized = rate * (365 / periodDays);
  return annualized * 100;
}

// ─── APY Calculator ───────────────────────────────────────────────────────────

export interface ApyInput {
  /** APR as a percentage (e.g., 10 means 10%) */
  aprPercent: number;
  /** Number of compounding periods per year */
  compoundingFrequency: number;
}

/**
 * Calculate APY (Annual Percentage Yield) — accounts for compounding.
 * Formula: ((1 + apr/n)^n - 1) * 100
 *
 * Where n = compounding frequency per year.
 * Common values: 365 (daily), 52 (weekly), 12 (monthly), 1 (annual = same as APR).
 *
 * Returns 0 for non-positive APR or compounding frequency.
 */
export function calculateApy(input: ApyInput): number {
  const { aprPercent, compoundingFrequency } = input;
  if (aprPercent <= 0 || compoundingFrequency <= 0) return 0;

  const apr = aprPercent / 100;
  const n = compoundingFrequency;
  const apy = Math.pow(1 + apr / n, n) - 1;
  return apy * 100;
}

/**
 * Convert APY back to APR given a compounding frequency.
 * Formula: n * ((1 + apy)^(1/n) - 1) * 100
 */
export function apyToApr(apyPercent: number, compoundingFrequency: number): number {
  if (apyPercent <= 0 || compoundingFrequency <= 0) return 0;

  const apy = apyPercent / 100;
  const n = compoundingFrequency;
  const apr = n * (Math.pow(1 + apy, 1 / n) - 1);
  return apr * 100;
}

// ─── Impermanent Loss Calculator ──────────────────────────────────────────────

export interface IlInput {
  /** Price ratio change for token A (e.g., 1.5 means price went up 50%) */
  priceRatioA: number;
  /** Price ratio change for token B (e.g., 0.8 means price dropped 20%) */
  priceRatioB: number;
}

/**
 * Calculate impermanent loss for a 50/50 constant-product AMM pool.
 *
 * Formula: IL = 2 * sqrt(r) / (1 + r) - 1
 * where r = relative price change ratio = priceRatioA / priceRatioB
 *
 * Returns a negative number representing the loss as a percentage.
 * Example: -5.72 means 5.72% impermanent loss.
 *
 * Edge cases:
 * - If either price ratio <= 0, returns 0 (invalid input).
 * - If both ratios are equal (no relative change), returns 0 (no IL).
 * - Maximum IL approaches -100% as price ratio approaches infinity.
 */
export function calculateImpermanentLoss(input: IlInput): number {
  const { priceRatioA, priceRatioB } = input;
  if (priceRatioA <= 0 || priceRatioB <= 0) return 0;

  const r = priceRatioA / priceRatioB;
  if (r === 1) return 0;

  const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
  return il * 100;
}

/**
 * Calculate IL from a simple price change percentage.
 * Assumes token B is a stablecoin (price doesn't change).
 *
 * @param priceChangePercent - e.g., 50 means token A went up 50%, -30 means dropped 30%
 */
export function calculateIlFromPriceChange(priceChangePercent: number): number {
  const priceRatioA = 1 + priceChangePercent / 100;
  if (priceRatioA <= 0) return 0;
  return calculateImpermanentLoss({ priceRatioA, priceRatioB: 1 });
}

export interface WeightedIlInput extends IlInput {
  /** Token A's pool weight (0..1 exclusive); 0.5 = the classic 50/50 curve */
  weightA: number;
}

/**
 * Impermanent loss for a WEIGHTED constant-mean pool (MONETIZATION #4):
 *   IL = r^w / (w·r + (1−w)) − 1,   r = priceRatioA/priceRatioB, w = weightA
 * `calculateImpermanentLoss` is the w = 0.5 special case (2√r/(1+r) − 1).
 * Asymmetric pools bleed less: at r = 2, w=0.8 → −3.3% vs 50/50's −5.7%.
 */
export function calculateWeightedImpermanentLoss(input: WeightedIlInput): number {
  const { priceRatioA, priceRatioB, weightA: w } = input;
  if (priceRatioA <= 0 || priceRatioB <= 0 || !(w > 0 && w < 1)) return 0;
  const r = priceRatioA / priceRatioB;
  if (r === 1) return 0;
  const il = Math.pow(r, w) / (w * r + (1 - w)) - 1;
  return il * 100;
}

/**
 * Blueprint-dispatched EXPECTED annual IL (small-move expansion) from the
 * pair's annualized relative vol: E[IL] ≈ −(w(1−w)/2)·σ_rel²  (w = 0.5 gives
 * the familiar −σ²/8). Capped at −95%.
 *
 * `calibrated: false` marks models pending calibration against real pool
 * mechanics: DefiPlaza's single-sided shortage dance is only approximated by
 * constant-product here (MONETIZATION #4).
 */
export function expectedIlPctForKind(
  kind: string | undefined,
  relAnnualVol: number,
  weightA = 0.5,
): { ilPct: number; calibrated: boolean } {
  const w = weightA > 0 && weightA < 1 ? weightA : 0.5;
  const ilPct = -Math.min(95, ((w * (1 - w)) / 2) * relAnnualVol * relAnnualVol * 100);
  return { ilPct, calibrated: kind !== 'defiplaza_pair' };
}

// ─── IL Risk Score ────────────────────────────────────────────────────────────

export interface IlRiskInput {
  /** Historical price volatility (standard deviation of daily returns, as decimal) */
  volatility: number;
  /** Correlation between the two tokens (-1 to 1) */
  correlation: number;
  /** Is one token a stablecoin? */
  hasStablecoin: boolean;
}

/**
 * Calculate IL risk score from 0 (no risk) to 100 (extreme risk).
 *
 * Factors:
 * - Higher volatility = higher IL risk
 * - Lower correlation between tokens = higher IL risk
 * - Stablecoin pairs have inherently lower IL risk
 *
 * Returns a score 0-100.
 */
export function calculateIlRiskScore(input: IlRiskInput): number {
  const { volatility, correlation, hasStablecoin } = input;

  // Volatility component (0-50 points): annualized vol of 100%+ = max score
  const annualizedVol = volatility * Math.sqrt(365);
  const volScore = Math.min(50, annualizedVol * 50);

  // Correlation component (0-30 points): lower correlation = higher IL risk
  // correlation of 1 = 0 points, correlation of -1 = 30 points
  const corrScore = ((1 - correlation) / 2) * 30;

  // Stablecoin discount: pairs with stablecoins have structurally lower IL
  const stableDiscount = hasStablecoin ? 0.6 : 1.0;

  const raw = (volScore + corrScore) * stableDiscount;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

// ─── Risk-Adjusted Return ─────────────────────────────────────────────────────

export interface RiskAdjustedInput {
  /** Expected APY as percentage */
  apyPercent: number;
  /** Impermanent loss as percentage (negative number, e.g. -5.72) */
  ilPercent: number;
  /** IL risk score (0-100) */
  ilRiskScore: number;
  /** Price volatility (daily returns std dev) */
  volatility: number;
  /**
   * Risk-free rate as a percentage — the return available with no divergence
   * risk, which on Radix is native XRD staking.
   *
   * This defaulted to 8, described in the comment as "native staking ~8%". That
   * was a guess, and it is wrong in a way that mattered: staking actually pays
   * ~6.06% (measured from on-ledger stake and the 300M/yr emission), so an 8%
   * benchmark gave staking a NEGATIVE excess return against itself and ranked
   * it below volatile pools it strictly dominates. Callers should pass the
   * measured rate; the default is a last resort.
   */
  riskFreeRate?: number;
}

/// Fallback risk-free rate when no measured staking yield is available. Derived
/// 2026-07-25: 300M XRD/yr emission over 4.85B staked, less the 2% median
/// validator fee. Prefer passing the live figure.
export const FALLBACK_RISK_FREE_RATE_PCT = 6.06;

/**
 * Calculate risk-adjusted return using a modified Sharpe-like ratio.
 *
 * Formula: (netReturn - riskFreeRate) / riskMeasure
 *
 * Where:
 * - netReturn = APY + IL (IL is negative, so it reduces return)
 * - riskMeasure = weighted combination of volatility and IL risk
 * - riskFreeRate defaults to 8% (Radix native staking yield)
 *
 * Higher values = better risk-adjusted return.
 * Values < 0 mean the investment underperforms the risk-free rate.
 */
export function calculateRiskAdjustedReturn(input: RiskAdjustedInput): number {
  const {
    apyPercent,
    ilPercent,
    ilRiskScore,
    volatility,
    riskFreeRate = FALLBACK_RISK_FREE_RATE_PCT,
  } = input;

  const netReturn = apyPercent + ilPercent; // IL is negative
  const excessReturn = netReturn - riskFreeRate;

  // Risk measure: blend of annualized volatility and IL risk
  const annualizedVol = volatility * Math.sqrt(365);
  // Floor stands in for the risks this model does not measure — smart-contract
  // failure, unstaking delay, withdrawal illiquidity. It was 0.01, effectively
  // zero, which is wrong on both counts: no venue is actually riskless, and a
  // near-zero denominator explodes the ratio. An IL-free venue 1.4 points under
  // the risk-free rate scored -138 purely from dividing by 0.01.
  const riskMeasure = Math.max(0.1, annualizedVol * 0.6 + (ilRiskScore / 100) * 0.4);

  // Sharpe-style ratios invert once excess return goes negative: dividing a
  // negative excess by a SMALLER risk yields a MORE negative score, so a safe
  // underperformer ranks below a reckless one. That is not a subtlety here —
  // on Radix almost everything sits below the ~6% staking benchmark, so the
  // negative branch is the common case. Multiplying keeps the ordering honest:
  // when you are behind the benchmark, extra risk always makes it worse.
  const raw =
    excessReturn >= 0 ? excessReturn / riskMeasure : excessReturn * riskMeasure;

  return Math.round(raw * 100) / 100;
}

// ─── Pool Net Yield ───────────────────────────────────────────────────────────

export interface PoolYieldSummary {
  /** Gross APY before IL */
  grossApy: number;
  /** Estimated IL as percentage (negative) */
  estimatedIl: number;
  /** Net APY after IL */
  netApy: number;
  /** IL risk score 0-100 */
  ilRiskScore: number;
  /** Risk-adjusted return (Sharpe-like) */
  riskAdjustedReturn: number;
  /** Risk tier: low, medium, high */
  riskTier: 'low' | 'medium' | 'high';
}

/**
 * Compute a complete yield summary for a pool.
 * Combines APY, IL estimation, and risk scoring.
 */
export function computePoolYieldSummary(params: {
  aprPercent: number;
  compoundingFrequency: number;
  priceChangeA: number;
  priceChangeB: number;
  volatility: number;
  correlation: number;
  hasStablecoin: boolean;
}): PoolYieldSummary {
  const grossApy = calculateApy({
    aprPercent: params.aprPercent,
    compoundingFrequency: params.compoundingFrequency,
  });

  const estimatedIl = calculateImpermanentLoss({
    priceRatioA: 1 + params.priceChangeA / 100,
    priceRatioB: 1 + params.priceChangeB / 100,
  });

  const ilRisk = calculateIlRiskScore({
    volatility: params.volatility,
    correlation: params.correlation,
    hasStablecoin: params.hasStablecoin,
  });

  const netApy = grossApy + estimatedIl;

  const riskAdjusted = calculateRiskAdjustedReturn({
    apyPercent: grossApy,
    ilPercent: estimatedIl,
    ilRiskScore: ilRisk,
    volatility: params.volatility,
  });

  const riskTier: 'low' | 'medium' | 'high' =
    ilRisk <= 25 ? 'low' : ilRisk <= 60 ? 'medium' : 'high';

  return {
    grossApy: Math.round(grossApy * 100) / 100,
    estimatedIl: Math.round(estimatedIl * 100) / 100,
    netApy: Math.round(netApy * 100) / 100,
    ilRiskScore: ilRisk,
    riskAdjustedReturn: riskAdjusted,
    riskTier,
  };
}
