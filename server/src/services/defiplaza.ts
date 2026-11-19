/// DefiPlaza pair data: read-only analytics, one row per pair SIDE.
///
/// Source: https://radix.defiplaza.net/api/pairs (checked 2026-11-19: HTTP 200,
/// `{ message, data: [...] }`, 153 pairs). The old sources were both dead:
///   - `stats.defiplaza.net/api/pairs` returns 404;
///   - the Gateway path read the PlazaDex router's state for pair addresses, but
///     the router keeps its pairs in KeyValueStores (`address_to_pair`,
///     `pair_to_lps`), which a component-state read does not list. It found no
///     pairs and returned [] WITHOUT throwing, so the fallback never ran and the
///     agent reported 0 errors while the whole venue was missing.
///
/// What the API gives, and how it is read here:
///   - `baseAPY` / `quoteAPY` are DefiPlaza's Annualized Liquidity Return (ALR)
///     per side, as FRACTIONS. ALR is the return versus simply holding that
///     side's token, INCLUDING impermanent loss, and it can be negative
///     (https://docs.defiplaza.net/defiplaza/radix/faq). The API does not say
///     which window the figure covers. It is NOT a fee APR and must never be
///     ranked in one column with one: this module labels every figure `ALR`.
///   - Each pair splits into two single-sided pools (`basePool` / `quotePool`),
///     each with its own ALR, so each pair becomes TWO rows.
///   - `baseTVL` / `quoteTVL` are the side reserves in units of that side's token.
///   - `tvlUSD` is the whole pair in USD, as DefiPlaza reports it; both side rows
///     carry it unchanged (it is not split, because no per-side USD is given).
///   - `volume` is always 0 in this API and is deliberately not read.
///
/// Why these rows do NOT feed the scorer: the scorer treats a pool's figure as a
/// fee APY and subtracts a modelled IL from it. ALR already includes IL, so
/// scoring it would count IL twice. They are served on their own endpoint
/// (GET /api/defiplaza), labelled, and never mixed into /api/opportunities.
/// Nothing here builds, signs or routes a transaction.

import { resilientFetch } from './gateway.js';
import { SourceError, recordSourceOk, recordSourceOutcome } from './source-health.js';

export const DEFIPLAZA_PAIRS_URL = 'https://radix.defiplaza.net/api/pairs';
export const DEFIPLAZA_SOURCE = 'defiplaza';

/// The agent ticks every minute; the pairs list does not need to.
const REFRESH_MS = 5 * 60_000;

/// |ALR| at or beyond this (percent a year) is flagged, not hidden: per-side ALR
/// swings hard with pool imbalance, so read both sides before trusting it.
const OUTLIER_ALR_PCT = 100;

export interface DefiPlazaSideRow {
  /// The PlazaPair component.
  pairAddress: string;
  side: 'base' | 'quote';
  /// This side's single-sided pool (basePool / quotePool).
  poolAddress: string;
  /// The token you would deposit on this side.
  token: string;
  /// The other token in the pair.
  pairedToken: string;
  tokenSymbol: string | null;
  pairedSymbol: string | null;
  /// Annualized Liquidity Return for this side, in percent. IL-inclusive.
  /// null when DefiPlaza reports none.
  alrPct: number | null;
  /// This side's reserve, in units of `token`.
  sideReserve: number | null;
  /// Whole-pair TVL in USD as DefiPlaza reports it (same on both side rows).
  pairTvlUsd: number | null;
  /// |alrPct| >= OUTLIER_ALR_PCT.
  outlier: boolean;
}

interface RawPair {
  address?: unknown;
  baseToken?: unknown;
  quoteToken?: unknown;
  basePool?: unknown;
  quotePool?: unknown;
  baseAPY?: unknown;
  quoteAPY?: unknown;
  baseTVL?: unknown;
  quoteTVL?: unknown;
  tvlUSD?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/// Map the API body to side rows. Throws SourceError('bad_response') when the
/// body is not the documented shape; skips individual pairs missing an address.
export function mapDefiPlazaPairs(body: unknown): DefiPlazaSideRow[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new SourceError('bad_response', 'DefiPlaza pairs API: no data[] array in the body');
  }
  const rows: DefiPlazaSideRow[] = [];
  for (const p of data as RawPair[]) {
    const pair = str(p?.address);
    const base = str(p?.baseToken);
    const quote = str(p?.quoteToken);
    const basePool = str(p?.basePool);
    const quotePool = str(p?.quotePool);
    if (!pair || !base || !quote) continue;
    const tvlUsd = num(p.tvlUSD);
    const sides: Array<[DefiPlazaSideRow['side'], string | null, string, string, unknown, unknown]> = [
      ['base', basePool, base, quote, p.baseAPY, p.baseTVL],
      ['quote', quotePool, quote, base, p.quoteAPY, p.quoteTVL],
    ];
    for (const [side, pool, token, paired, apy, reserve] of sides) {
      if (!pool) continue;
      const frac = num(apy);
      const alrPct = frac === null ? null : frac * 100;
      rows.push({
        pairAddress: pair,
        side,
        poolAddress: pool,
        token,
        pairedToken: paired,
        tokenSymbol: null,
        pairedSymbol: null,
        alrPct,
        sideReserve: num(reserve),
        pairTvlUsd: tvlUsd,
        outlier: alrPct !== null && Math.abs(alrPct) >= OUTLIER_ALR_PCT,
      });
    }
  }
  return rows;
}

export type FetchFn = (url: string) => Promise<Response>;

/// Fetch and map. Throws a SourceError naming the failure kind; zero rows is a
/// failure too (`empty`), never a silent success.
export async function fetchDefiPlazaPairs(fetchFn: FetchFn = resilientFetch): Promise<DefiPlazaSideRow[]> {
  const resp = await fetchFn(DEFIPLAZA_PAIRS_URL);
  if (!resp.ok) throw new SourceError('http_status', `DefiPlaza pairs API returned ${resp.status}`);
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new SourceError('bad_response', 'DefiPlaza pairs API: body is not JSON');
  }
  const rows = mapDefiPlazaPairs(body);
  if (rows.length === 0) throw new SourceError('empty', 'DefiPlaza pairs API returned 0 usable pairs');
  return rows;
}

// ─── latest snapshot (refreshed by the agent loop) ────────────────────────────

let latest: { fetchedAt: number; rows: DefiPlazaSideRow[] } | null = null;
let lastAttemptAt: number | null = null;

export interface RefreshDeps {
  fetch?: FetchFn;
  /// Token symbol lookup (best effort; rows keep null symbols on failure).
  symbols?: (addrs: string[]) => Promise<Map<string, string>>;
  now?: number;
  /// Skip the REFRESH_MS throttle.
  force?: boolean;
}

/// Refresh the DefiPlaza snapshot and record source health. On failure the
/// previous rows are kept: the view carries `fetchedAt`, so they read as stale,
/// and /api/status shows the failure.
export async function refreshDefiPlaza(deps: RefreshDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  if (!deps.force && lastAttemptAt !== null && now - lastAttemptAt < REFRESH_MS) return;
  lastAttemptAt = now;
  let rows: DefiPlazaSideRow[];
  try {
    rows = await fetchDefiPlazaPairs(deps.fetch);
  } catch (err) {
    console.error(`[defiplaza] pairs fetch failed: ${(err as Error).message}`);
    recordSourceOutcome(DEFIPLAZA_SOURCE, { error: err }, now);
    return;
  }
  if (deps.symbols) {
    try {
      const tokens = [...new Set(rows.flatMap((r) => [r.token, r.pairedToken]))];
      const sym = await deps.symbols(tokens);
      for (const r of rows) {
        r.tokenSymbol = sym.get(r.token) ?? null;
        r.pairedSymbol = sym.get(r.pairedToken) ?? null;
      }
    } catch {
      // symbols stay null — the addresses are still correct
    }
  }
  latest = { fetchedAt: now, rows };
  recordSourceOk(DEFIPLAZA_SOURCE, rows.length, now);
}

/// All side rows from the last good refresh, unfiltered (the yield view applies
/// its own floors). Copies, so callers cannot mutate the snapshot.
export function getDefiPlazaRows(): DefiPlazaSideRow[] {
  return (latest?.rows ?? []).map((r) => ({ ...r }));
}

export interface DefiPlazaView {
  source: string;
  returnType: 'ALR';
  returnNote: string;
  fetchedAt: number | null;
  /// Pairs whose reported TVL is below this (USD) are left out.
  floorUsd: number;
  excludedBelowFloor: number;
  excludedNoReturn: number;
  /// Sorted by pair TVL (exit depth), largest first — not by return.
  rows: DefiPlazaSideRow[];
}

export const ALR_NOTE =
  'ALR = DefiPlaza Annualized Liquidity Return per side: the return versus holding that ' +
  "side's token, including impermanent loss. It can be negative. This is the figure DefiPlaza's " +
  'own UI labels "ALR" (baseAPY/quoteAPY); its 7-day ALR is not in this API, and the API does not ' +
  'state the measurement window. It is not a fee APR; do not compare it with fee APR figures. ' +
  'Source definition: https://docs.defiplaza.net/defiplaza/radix/faq';

export function getDefiPlazaView(floorUsd: number): DefiPlazaView {
  const all = latest?.rows ?? [];
  let belowFloor = 0;
  let noReturn = 0;
  const rows = all.filter((r) => {
    if (r.alrPct === null) {
      noReturn++;
      return false;
    }
    if (r.pairTvlUsd === null || r.pairTvlUsd < floorUsd) {
      belowFloor++;
      return false;
    }
    return true;
  });
  rows.sort(
    (a, b) =>
      (b.pairTvlUsd ?? 0) - (a.pairTvlUsd ?? 0) ||
      a.pairAddress.localeCompare(b.pairAddress) ||
      (a.side === 'base' ? -1 : 1),
  );
  return {
    source: DEFIPLAZA_PAIRS_URL,
    returnType: 'ALR',
    returnNote: ALR_NOTE,
    fetchedAt: latest?.fetchedAt ?? null,
    floorUsd,
    excludedBelowFloor: belowFloor,
    excludedNoReturn: noReturn,
    rows,
  };
}

/// Tests only.
export function resetDefiPlazaForTests(): void {
  latest = null;
  lastAttemptAt = null;
}
