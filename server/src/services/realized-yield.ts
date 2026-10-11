/// Realized-yield measurement over a fixed historical window.
///
/// Neither CaviarNine's LSU Pool nor Weft's lending pools publish an APY. Both
/// instead expose a monotonically moving REDEMPTION RATIO on-ledger, so the
/// yield is the realized drift of that ratio across a trailing window, read via
/// the Gateway's `at_ledger_state.timestamp` time travel.
///
/// Why not the instantaneous rate: Weft stores a spot borrow rate, and using it
/// as a supply yield overstates badly — measured 2026-07-25 it implies 7.85%
/// for XRD where the realized 30-day figure is 4.67%, and 186.6% for hUSDC
/// against a realized 37.8%. A spot rate is a rate, not a yield.
///
/// The window length is FIXED and identical across venues, and is rendered into
/// the opportunity name, because the number genuinely depends on it: Weft's XRD
/// pool reads 4.67% at 30 days and 2.73% at 90. A bare "4.67% APY" with a
/// floating window is how a true number becomes a misleading one.

/// Trailing window used for every realized-yield venue. Changing this changes
/// published numbers — update the UI label with it.
export const REALIZED_WINDOW_DAYS = 30;

/// Both venues' ratios move in discrete jumps when the pool is interacted with,
/// so short windows annualize noise: measured 2026-07-25, LSULP reads ~8% over
/// 7 days and ~7% over 1 day against a ~6% truth. If the Gateway snaps the
/// historical read closer than this, refuse rather than publish the noise.
export const MIN_WINDOW_DAYS = 28;

export interface LedgerSnapshot {
  stateVersion: number;
  timestampMs: number;
}

/// ISO-8601 instant one window back from `nowMs`, for `at_ledger_state`.
export function windowStartIso(nowMs: number): string {
  return new Date(nowMs - REALIZED_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

export function parseLedgerState(json: unknown): LedgerSnapshot | null {
  const ls = (json as { ledger_state?: { state_version?: number; proposer_round_timestamp?: string } })
    ?.ledger_state;
  if (!ls) return null;
  const stateVersion = Number(ls.state_version);
  const timestampMs = Date.parse(ls.proposer_round_timestamp ?? '');
  if (!Number.isFinite(stateVersion) || Number.isNaN(timestampMs)) return null;
  return { stateVersion, timestampMs };
}

/**
 * Annualize a ratio's growth across the measured window, or return null.
 *
 * `ratioNow` / `ratioPast` must both be redemption values that only RISE. A
 * caller whose on-ledger field falls as value accrues (Weft's `unit_ratio` is
 * units-per-underlying) must invert before calling — passing it raw yields a
 * negative result, which the monotonicity gate below rejects rather than
 * silently publishing an inverted number.
 *
 * Every rejection path returns null. A missing opportunity is correct; a wrong
 * APY in front of someone allocating real money is not.
 */
export function annualizedYieldPct(
  ratioNow: number,
  ratioPast: number,
  now: LedgerSnapshot,
  past: LedgerSnapshot,
): number | null {
  // The historical read silently degraded to "now" — the two snapshots would
  // otherwise divide out to exactly 0%.
  if (past.stateVersion >= now.stateVersion) return null;

  // Measure dt from what the Gateway ACTUALLY returned, never from the instant
  // we asked for: it snaps to a nearby round and the two can differ.
  const dtDays = (now.timestampMs - past.timestampMs) / 86_400_000;
  if (!Number.isFinite(dtDays) || dtDays < MIN_WINDOW_DAYS) return null;

  if (
    !Number.isFinite(ratioNow) ||
    !Number.isFinite(ratioPast) ||
    ratioNow <= 0 ||
    ratioPast <= 0
  ) {
    return null;
  }

  // Monotonic by construction at both venues, so a non-increase means a bad
  // snapshot or an inverted formula.
  if (ratioNow <= ratioPast) return null;

  const apy = (Math.pow(ratioNow / ratioPast, 365 / dtDays) - 1) * 100;
  return Number.isFinite(apy) ? apy : null;
}

/**
 * Hard sanity band. Fails CLOSED — outside the band we publish nothing.
 *
 * These venues have a known economic anchor (native XRD staking, ~6%), so a
 * derivation returning 30% or 0.2% has broken rather than discovered something:
 * a stale snapshot, a truncated decimal, or a failed historical query. A
 * plausible-looking wrong number is the single worst output this app can emit.
 */
export function withinBand(apyPct: number, minPct: number, maxPct: number): boolean {
  return Number.isFinite(apyPct) && apyPct >= minPct && apyPct <= maxPct;
}

/// Field lookup by NAME. Radix programmatic-JSON field order is not contractual,
/// so index-based access silently reads the wrong value after any blueprint change.
export function fieldByName(
  fields: unknown,
  name: string,
): { value?: string; fields?: unknown } | null {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (f && typeof f === 'object' && (f as { field_name?: string }).field_name === name) {
      return f as { value?: string; fields?: unknown };
    }
  }
  return null;
}

/// Parse a Radix Decimal/PreciseDecimal string. Parses the WHOLE string the
/// Gateway returned — these carry up to 36 fractional digits and float64 is
/// accurate enough, but truncating the string beforehand is not.
export function parseDecimal(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  return parseFloat(value);
}
