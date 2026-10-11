/// Per-token realized-vol + pair-correlation feed (MONETIZATION #2).
///
/// Daily closes come from Ociswap's TradingView-UDF endpoint
/// (`/udf/history?symbol=<resource>&resolution=1D` — verified live 2026-07-18);
/// everything downstream of the fetch is pure math, so the IL/risk pipeline is
/// unit-testable without the network. Series are cached for an hour — the scan
/// loop re-scores far more often than daily bars move.
///
/// The pair statistic that drives IL is the vol of the PRICE RATIO A/B:
///   σ_rel² = σ_A² + σ_B² − 2ρσ_Aσ_B   (annualized)
/// and the expected annual IL of a 50/50 constant-product position is the
/// small-move expansion  E[IL] ≈ −σ_rel²/8  (negative %, capped at −95).

import { resilientFetch } from './gateway.js';

const OCISWAP_API = 'https://api.ociswap.com';
const DAY_S = 86_400;
const CACHE_TTL_MS = 60 * 60 * 1000;
const SQRT365 = Math.sqrt(365);
/// Fewer aligned return samples than this → no statistic (caller falls back).
const MIN_SAMPLES = 10;

export interface DailySeries {
  t: number[]; // bar-start unix seconds (midnight UTC — comparable across tokens)
  c: number[]; // closes in USD
}

export interface PairRisk {
  /// Daily stdev of log returns, per token.
  dailyVolA: number;
  dailyVolB: number;
  /// Correlation of the tokens' aligned daily returns (−1..1).
  correlation: number;
  /// Annualized vol of the A/B price ratio.
  relAnnualVol: number;
  /// Expected annual IL % (negative), E[IL] ≈ −σ_rel²/8.
  estimatedIlPct: number;
  /// Aligned return samples the stats were computed from.
  samples: number;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const seriesCache = new Map<string, { at: number; series: DailySeries | null }>();

export function _clearPriceCache(): void {
  seriesCache.clear();
}

/// Fetch ~`days` of daily closes for a token. Returns null (cached too) on any
/// API failure — risk consumers fall back to a skeptical default, never throw.
export async function fetchDailyCloses(
  token: string,
  days = 30,
  fetchFn: FetchLike = resilientFetch,
): Promise<DailySeries | null> {
  const cached = seriesCache.get(token);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.series;

  const to = Math.floor(Date.now() / 1000);
  const from = to - days * DAY_S;
  let series: DailySeries | null = null;
  try {
    const resp = await fetchFn(
      `${OCISWAP_API}/udf/history?symbol=${token}&resolution=1D&from=${from}&to=${to}&currencyCode=USD`,
    );
    if (resp.ok) {
      const j = (await resp.json()) as { s?: string; t?: number[]; c?: Array<number | string> };
      if (j.s === 'ok' && Array.isArray(j.t) && Array.isArray(j.c) && j.c.length === j.t.length) {
        series = { t: j.t, c: j.c.map(Number) };
      }
    }
  } catch {
    // series stays null
  }
  seriesCache.set(token, { at: Date.now(), series });
  return series;
}

// ─── pure math ────────────────────────────────────────────────────────────────

export function dailyLogReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

/// Sample standard deviation (n−1). <2 samples → 0.
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/// Pearson correlation of equal-length series. Degenerate input → 0.
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const ma = xa.reduce((s, x) => s + x, 0) / n;
  const mb = xb.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (xa[i] - ma) * (xb[i] - mb);
    va += (xa[i] - ma) ** 2;
    vb += (xb[i] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/// Returns for the timestamp-intersection of two daily series (bars align on
/// midnight UTC, so an inner join on t is exact). ra[i] and rb[i] are the SAME
/// day-pair by construction: a return is emitted only when BOTH series have
/// positive closes at BOTH endpoints of the pair.
///
/// Differencing each series INDEPENDENTLY (dailyLogReturns(ca), dailyLogReturns(cb))
/// is wrong here: a single non-positive/gap close in one series drops two returns
/// from that side but not the other, so ra and rb end up different lengths and
/// correlation()'s slice(-n) silently pairs mismatched calendar days — corrupting
/// correlation → relAnnualVol → estimatedIl. (fetchDailyCloses turns an API-gap
/// null into 0 via Number(null), so this is reachable from real feed gaps.)
export function alignedReturns(sa: DailySeries, sb: DailySeries): { ra: number[]; rb: number[] } {
  const byT = new Map(sb.t.map((t, i) => [t, sb.c[i]]));
  const ca: number[] = [];
  const cb: number[] = [];
  for (let i = 0; i < sa.t.length; i++) {
    const other = byT.get(sa.t[i]);
    if (other !== undefined) {
      ca.push(sa.c[i]);
      cb.push(other);
    }
  }
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < ca.length; i++) {
    if (ca[i - 1] > 0 && ca[i] > 0 && cb[i - 1] > 0 && cb[i] > 0) {
      ra.push(Math.log(ca[i] / ca[i - 1]));
      rb.push(Math.log(cb[i] / cb[i - 1]));
    }
  }
  return { ra, rb };
}

export function annualizeVol(dailyStdev: number): number {
  return dailyStdev * SQRT365;
}

/// σ_rel of the A/B ratio from annualized per-token vols + correlation.
export function relativeAnnualVol(annualVolA: number, annualVolB: number, corr: number): number {
  const v = annualVolA ** 2 + annualVolB ** 2 - 2 * corr * annualVolA * annualVolB;
  return Math.sqrt(Math.max(0, v));
}

/// Expected annual IL %, small-move expansion E[IL] ≈ −σ_rel²/8. Negative;
/// capped at −95 (the exact IL curve is bounded above −100, the expansion isn't).
export function expectedAnnualIlPct(relAnnualVol: number): number {
  return -Math.min(95, ((relAnnualVol * relAnnualVol) / 8) * 100);
}

export function pairRiskFromSeries(sa: DailySeries, sb: DailySeries): PairRisk | null {
  const { ra, rb } = alignedReturns(sa, sb);
  if (ra.length < MIN_SAMPLES) return null;
  const dailyVolA = stdev(ra);
  const dailyVolB = stdev(rb);
  const corr = correlation(ra, rb);
  const relVol = relativeAnnualVol(annualizeVol(dailyVolA), annualizeVol(dailyVolB), corr);
  return {
    dailyVolA,
    dailyVolB,
    correlation: corr,
    relAnnualVol: relVol,
    estimatedIlPct: expectedAnnualIlPct(relVol),
    samples: ra.length,
  };
}

/// Live pair risk for two token resources. Null when either series is missing
/// or too short — callers substitute their skeptical default.
export async function getPairRisk(
  tokenA: string,
  tokenB: string,
  fetchFn: FetchLike = resilientFetch,
): Promise<PairRisk | null> {
  if (!tokenA || !tokenB || tokenA === tokenB) return null;
  const [sa, sb] = await Promise.all([
    fetchDailyCloses(tokenA, 30, fetchFn),
    fetchDailyCloses(tokenB, 30, fetchFn),
  ]);
  if (!sa || !sb) return null;
  return pairRiskFromSeries(sa, sb);
}
