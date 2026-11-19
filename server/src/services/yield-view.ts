/// Radix-wide yield view: "where is the yield on Radix, in XRD, and can I get out".
/// Design: docs/design/radix-yield-view.md. Analytics only — nothing here feeds
/// the scorer, rotation or the deposit builder, and nothing signs or moves funds.
///
/// Three price rules (the whole "price engine"):
///   1. Token price = Astrolescent `tokenPriceXRD`, cross-checked against
///      Ociswap's `price.xrd.now`; > 5% apart → `price_disagree`, both shown,
///      never averaged.
///   2. Liquidity floor: Astrolescent `aggregateTVL` < $1,000 or 7d volume 0 →
///      `below_floor`, no rows.
///   3. Everything in XRD; USD only once, from DefiLlama's XRD price.
/// Returns are kept in three sections by type (staking APY / fee APR / ALR) and
/// never ranked in one column. Each section sorts by exit depth.

import watchlistJson from '../config/yield-watchlist.json';
import { resilientFetch } from './gateway.js';
import { getDb } from '../db/schema.js';
import { getDefiPlazaRows, type DefiPlazaSideRow } from './defiplaza.js';
import { SourceError, recordSourceOutcome } from './source-health.js';

// ─── config ───────────────────────────────────────────────────────────────────

export type AssetTag = 'meme' | 'stable' | 'bridge';

export interface WatchAsset {
  resource: string;
  symbol: string;
  aka?: string[];
  tags: AssetTag[];
  bridgeRoute?: string;
}

export interface Kicker {
  venue: string;
  paidIn: string;
  advertised: string;
  source: string;
  checked: string;
  status: 'unverified';
}

export interface Watchlist {
  assets: WatchAsset[];
  kickers: Kicker[];
  chainNote: { text: string; source: string };
}

export const WATCHLIST = watchlistJson as unknown as Watchlist;

export const XRD_RESOURCE = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
export const ASTROLESCENT_PRICES_URL = 'https://api.astrolescent.com/prices';
export const OCISWAP_POOLS_URL = 'https://api.ociswap.com/pools?limit=100';
export const DEFILLAMA_XRD_URL = 'https://coins.llama.fi/prices/current/coingecko:radix';
export const DEFILLAMA_CHAINS_URL = 'https://api.llama.fi/v2/chains';

/// Rule 2: Astrolescent aggregateTVL (USD) below this, or zero 7d volume.
export const TOKEN_FLOOR_TVL_USD = 1000;
/// Rule 1: cross-check tolerance, percent.
export const PRICE_DISAGREE_PCT = 5;
/// A `stable` asset more than this far from $1 is off peg.
export const OFF_PEG_PCT = 5;

// ─── raw source shapes (only the fields read) ─────────────────────────────────

export interface AstrolescentToken {
  symbol?: string;
  tokenPriceXRD?: number | null;
  aggregateTVL?: number | null;
  aggregateVolume7D?: number | null;
}
export type AstrolescentPrices = Record<string, AstrolescentToken>;

interface OciWindowed { now?: string; '7d'?: string }
export interface OciswapPool {
  address: string;
  name?: string;
  pool_type?: string;
  fee_rate?: string;
  apr?: { '7d'?: string };
  total_value_locked?: { xrd?: OciWindowed };
  volume?: { xrd?: OciWindowed };
  fee?: { xrd?: OciWindowed };
  x?: { token?: { address?: string }; price?: { xrd?: OciWindowed } };
  y?: { token?: { address?: string }; price?: { xrd?: OciWindowed } };
}

// ─── view shapes ──────────────────────────────────────────────────────────────

export type AssetFlag = 'meme' | 'bridge' | 'off_peg' | 'price_disagree' | 'below_floor' | 'no_price';
export type ReturnType = 'staking_apy' | 'fee_apr' | 'alr';

export interface AssetRow {
  resource: string;
  symbol: string;
  /// Rule 1 price (Astrolescent). null = unavailable, never 0.
  priceXrd: number | null;
  /// Cross-check (Ociswap, deepest XRD pool). null when no such pool.
  priceXrdOciswap: number | null;
  divergencePct: number | null;
  /// priceXrd × XRD/USD (DefiLlama). Shown once, for the off-peg check.
  priceUsd: number | null;
  aggregateTvlUsd: number | null;
  volume7dXrd: number | null;
  bridgeRoute: string | null;
  flags: AssetFlag[];
  /// Percent change of priceXrd vs the daily snapshot 7 days earlier.
  priceChange7dPct: number | null;
}

export interface YieldRow {
  key: string;
  venue: 'Radix staking' | 'Ociswap' | 'DefiPlaza';
  pool: string;
  label: string;
  returnType: ReturnType;
  returnPct: number;
  returnNote: string;
  /// Exit depth in XRD. null = unavailable (never 0).
  depthXrd: number | null;
  /// null = not reported by the venue.
  volume7dXrd: number | null;
  fees7dXrd: number | null;
  flags: Array<AssetFlag | 'outlier'>;
  /// Percentage-point change of returnPct vs 7 days earlier.
  returnChange7dPp: number | null;
  depthChange7dPct: number | null;
}

export interface YieldView {
  generatedAt: number | null;
  banner: {
    xrdUsd: number | null;
    chainTvlUsd: number | null;
    chainTvlXrd: number | null;
    note: string;
    noteSource: string;
  };
  rules: string[];
  assets: AssetRow[];
  sections: { staking: YieldRow[]; feeApr: YieldRow[]; alr: YieldRow[] };
  kickers: Kicker[];
  excluded: {
    belowFloorAssets: string[];
    /// Rows dropped because their KNOWN exit depth is under the pool floor.
    rowsBelowDepthFloor: number;
    /// Rows shown with depth unavailable (no TVL reported, or no price).
    rowsDepthUnknown: number;
    /// The pool floor in XRD (MIN_POOL_TVL_USD / XRD-USD); null when XRD/USD is unknown.
    depthFloorXrd: number | null;
  };
}

const RULES = [
  'Price = Astrolescent tokenPriceXRD, cross-checked against Ociswap; more than 5% apart is flagged and both are shown, never averaged.',
  'Liquidity floor: a token with Astrolescent aggregate TVL (USD) under $1,000 or zero 7-day volume gets no rows. If Astrolescent is down, the floor is not applied and prices show as unavailable.',
  'Pool floor: a row whose exit depth is known and under $1,000 (converted to XRD at the DefiLlama price) is left out and counted. Unknown depth is shown as unavailable, not dropped.',
  'Everything is in XRD. USD prices come only from DefiLlama’s XRD price; the one source USD figure used is Astrolescent’s aggregate TVL, for the liquidity floor.',
  'Returns are split by type (staking APY, fee APR without IL, ALR with IL) and never ranked together. Each list is sorted by exit depth.',
];

const RETURN_NOTES: Record<ReturnType, string> = {
  staking_apy: 'Network staking APY from the Gateway, net of the median validator fee. Exit: the unstake delay.',
  fee_apr: 'Ociswap 7-day fee APR in XRD. Fee income only: impermanent loss is NOT included.',
  alr: 'DefiPlaza ALR: return versus holding this side’s token, including impermanent loss. Can be negative. Window not stated by the API.',
};

// ─── pure builder ─────────────────────────────────────────────────────────────

export interface YieldInputs {
  astrolescent: AstrolescentPrices | null;
  ociswapPools: OciswapPool[] | null;
  defiplaza: DefiPlazaSideRow[];
  stakingApyPct: number | null;
  xrdUsd: number | null;
  chainTvlUsd: number | null;
  /// Value of `kind`/`key` from the snapshot 7 days before `now`, or null.
  history?: (kind: SnapshotKind, key: string) => number | null;
  /// Pool floor in USD (converted to XRD when XRD/USD is known).
  minDepthUsd: number;
  now: number;
}

function n(v: unknown): number | null {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(x) ? x : null;
}

function pos(v: unknown): number | null {
  const x = n(v);
  return x !== null && x > 0 ? x : null;
}

function byDepth(a: YieldRow, b: YieldRow): number {
  return (b.depthXrd ?? -1) - (a.depthXrd ?? -1) || a.key.localeCompare(b.key);
}

export function buildYieldView(inp: YieldInputs, wl: Watchlist = WATCHLIST): YieldView {
  const hist = inp.history ?? (() => null);
  const xrdUsd = pos(inp.xrdUsd);
  const pools = inp.ociswapPools ?? [];

  // Rule 1 cross-check source: the deepest Ociswap pool pairing the token with XRD.
  const ociPrice = new Map<string, { price: number; depth: number }>();
  for (const p of pools) {
    const xa = p.x?.token?.address;
    const ya = p.y?.token?.address;
    const depth = n(p.total_value_locked?.xrd?.now) ?? 0;
    const side = ya === XRD_RESOURCE ? p.x : xa === XRD_RESOURCE ? p.y : null;
    const token = ya === XRD_RESOURCE ? xa : xa === XRD_RESOURCE ? ya : undefined;
    const price = pos(side?.price?.xrd?.now);
    if (!token || price === null) continue;
    const prev = ociPrice.get(token);
    if (!prev || depth > prev.depth) ociPrice.set(token, { price, depth });
  }

  const assets: AssetRow[] = wl.assets.map((a) => {
    const isXrd = a.resource === XRD_RESOURCE;
    const ast = inp.astrolescent?.[a.resource];
    const priceXrd = isXrd ? 1 : pos(ast?.tokenPriceXRD);
    const priceXrdOciswap = isXrd ? 1 : ociPrice.get(a.resource)?.price ?? null;
    const divergencePct =
      !isXrd && priceXrd !== null && priceXrdOciswap !== null
        ? ((priceXrdOciswap - priceXrd) / priceXrd) * 100
        : null;
    const priceUsd = priceXrd !== null && xrdUsd !== null ? priceXrd * xrdUsd : null;
    const aggTvl = n(ast?.aggregateTVL);
    const vol7d = n(ast?.aggregateVolume7D);
    const flags: AssetFlag[] = [];
    if (a.tags.includes('meme')) flags.push('meme');
    if (a.tags.includes('bridge')) flags.push('bridge');
    if (a.tags.includes('stable') && priceUsd !== null && Math.abs(priceUsd - 1) * 100 > OFF_PEG_PCT) {
      flags.push('off_peg');
    }
    if (divergencePct !== null && Math.abs(divergencePct) > PRICE_DISAGREE_PCT) flags.push('price_disagree');
    if (!isXrd && inp.astrolescent) {
      if (ast === undefined) flags.push('no_price');
      // Rule 2. Applied only when Astrolescent answered; without it the floor
      // is unknown, and rows still show (each with its own depth).
      if (aggTvl === null || aggTvl < TOKEN_FLOOR_TVL_USD || !(vol7d !== null && vol7d > 0)) {
        flags.push('below_floor');
      }
    }
    const old = hist('price_xrd', a.resource);
    return {
      resource: a.resource,
      symbol: a.symbol,
      priceXrd,
      priceXrdOciswap,
      divergencePct,
      priceUsd,
      aggregateTvlUsd: aggTvl,
      volume7dXrd: vol7d,
      bridgeRoute: a.bridgeRoute ?? null,
      flags,
      priceChange7dPct: priceXrd !== null && old !== null && old > 0 ? (priceXrd / old - 1) * 100 : null,
    };
  });

  const byRes = new Map(assets.map((a) => [a.resource, a]));
  const usable = (r: string | undefined) => {
    const a = r ? byRes.get(r) : undefined;
    return a !== undefined && !a.flags.includes('below_floor');
  };
  const rowFlags = (...res: string[]) => {
    const out = new Set<AssetFlag | 'outlier'>();
    for (const r of res) {
      for (const f of byRes.get(r)?.flags ?? []) {
        if (f === 'meme' || f === 'bridge' || f === 'off_peg' || f === 'price_disagree') out.add(f);
      }
    }
    return [...out];
  };
  const sym = (r: string) => byRes.get(r)?.symbol ?? r.slice(-8);
  const minDepthXrd = xrdUsd !== null ? inp.minDepthUsd / xrdUsd : 0;
  let belowDepth = 0;
  let noDepth = 0;

  const withChange = (row: Omit<YieldRow, 'returnChange7dPp' | 'depthChange7dPct'>): YieldRow => {
    const oldRet = hist('return_pct', row.key);
    const oldDepth = hist('depth_xrd', row.key);
    return {
      ...row,
      returnChange7dPp: oldRet !== null ? row.returnPct - oldRet : null,
      depthChange7dPct:
        row.depthXrd !== null && oldDepth !== null && oldDepth > 0 ? (row.depthXrd / oldDepth - 1) * 100 : null,
    };
  };

  const staking: YieldRow[] = [];
  if (inp.stakingApyPct !== null && Number.isFinite(inp.stakingApyPct)) {
    staking.push(
      withChange({
        key: 'radix:native_xrd_staking',
        venue: 'Radix staking',
        pool: 'native_xrd_staking',
        label: 'XRD native staking',
        returnType: 'staking_apy',
        returnPct: inp.stakingApyPct,
        returnNote: RETURN_NOTES.staking_apy,
        depthXrd: null,
        volume7dXrd: null,
        fees7dXrd: null,
        flags: [],
      }),
    );
  }

  const feeApr: YieldRow[] = [];
  for (const p of pools) {
    const xa = p.x?.token?.address;
    const ya = p.y?.token?.address;
    if (!xa || !ya || !usable(xa) || !usable(ya)) continue;
    const apr = n(p.apr?.['7d']);
    if (apr === null) continue;
    // Unknown depth is shown (as unavailable, sorted last), never treated as 0;
    // only a KNOWN depth under the floor drops the row.
    const depth = pos(p.total_value_locked?.xrd?.now);
    if (depth === null) noDepth++;
    else if (depth < minDepthXrd) {
      belowDepth++;
      continue;
    }
    const feePct = n(p.fee_rate);
    feeApr.push(
      withChange({
        key: `ociswap:${p.address}`,
        venue: 'Ociswap',
        pool: p.address,
        label:
          `${sym(xa)}/${sym(ya)}` +
          (p.pool_type ? ` · ${p.pool_type}` : '') +
          (feePct !== null ? ` ${+(feePct * 100).toFixed(2)}%` : ''),
        returnType: 'fee_apr',
        returnPct: apr * 100,
        returnNote: RETURN_NOTES.fee_apr,
        depthXrd: depth,
        volume7dXrd: n(p.volume?.xrd?.['7d']),
        fees7dXrd: n(p.fee?.xrd?.['7d']),
        flags: rowFlags(xa, ya),
      }),
    );
  }

  const alr: YieldRow[] = [];
  for (const s of inp.defiplaza) {
    if (s.alrPct === null || !usable(s.token) || !usable(s.pairedToken)) continue;
    const price = byRes.get(s.token)?.priceXrd ?? null;
    const depth = s.sideReserve !== null && price !== null ? s.sideReserve * price : null;
    if (depth === null) noDepth++;
    else if (depth < minDepthXrd) {
      belowDepth++;
      continue;
    }
    const flags = rowFlags(s.token, s.pairedToken);
    if (s.outlier) flags.push('outlier');
    alr.push(
      withChange({
        key: `defiplaza:${s.poolAddress}`,
        venue: 'DefiPlaza',
        pool: s.poolAddress,
        label: `${sym(s.token)} side of ${s.side === 'base' ? `${sym(s.token)}/${sym(s.pairedToken)}` : `${sym(s.pairedToken)}/${sym(s.token)}`}`,
        returnType: 'alr',
        returnPct: s.alrPct,
        returnNote: RETURN_NOTES.alr,
        depthXrd: depth,
        volume7dXrd: null,
        fees7dXrd: null,
        flags,
      }),
    );
  }

  feeApr.sort(byDepth);
  alr.sort(byDepth);
  const chainTvlUsd = pos(inp.chainTvlUsd);

  return {
    generatedAt: inp.now,
    banner: {
      xrdUsd,
      chainTvlUsd,
      chainTvlXrd: chainTvlUsd !== null && xrdUsd !== null ? chainTvlUsd / xrdUsd : null,
      note: wl.chainNote.text,
      noteSource: wl.chainNote.source,
    },
    rules: RULES,
    assets,
    sections: { staking, feeApr, alr },
    kickers: wl.kickers,
    excluded: {
      belowFloorAssets: assets.filter((a) => a.flags.includes('below_floor')).map((a) => a.symbol),
      rowsBelowDepthFloor: belowDepth,
      rowsDepthUnknown: noDepth,
      depthFloorXrd: xrdUsd !== null ? minDepthXrd : null,
    },
  };
}

// ─── fetchers ─────────────────────────────────────────────────────────────────

export type FetchFn = (url: string) => Promise<Response>;

async function getJson(fetchFn: FetchFn, url: string, label: string): Promise<unknown> {
  const resp = await fetchFn(url);
  if (!resp.ok) throw new SourceError('http_status', `${label} returned ${resp.status}`);
  try {
    return await resp.json();
  } catch {
    throw new SourceError('bad_response', `${label}: body is not JSON`);
  }
}

export async function fetchAstrolescentPrices(fetchFn: FetchFn = resilientFetch): Promise<AstrolescentPrices> {
  const body = await getJson(fetchFn, ASTROLESCENT_PRICES_URL, 'Astrolescent /prices');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SourceError('bad_response', 'Astrolescent /prices: not an object keyed by resource');
  }
  if (Object.keys(body).length === 0) throw new SourceError('empty', 'Astrolescent /prices returned no tokens');
  return body as AstrolescentPrices;
}

export async function fetchOciswapPools(fetchFn: FetchFn = resilientFetch): Promise<OciswapPool[]> {
  const body = (await getJson(fetchFn, OCISWAP_POOLS_URL, 'Ociswap /pools')) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new SourceError('bad_response', 'Ociswap /pools: no data[]');
  if (body.data.length === 0) throw new SourceError('empty', 'Ociswap /pools returned no pools');
  return body.data as OciswapPool[];
}

export async function fetchXrdUsd(fetchFn: FetchFn = resilientFetch): Promise<number> {
  const body = (await getJson(fetchFn, DEFILLAMA_XRD_URL, 'DefiLlama coins')) as {
    coins?: Record<string, { price?: unknown }>;
  };
  const price = pos(body?.coins?.['coingecko:radix']?.price);
  if (price === null) throw new SourceError('price_unavailable', 'DefiLlama coins: no XRD price');
  return price;
}

export async function fetchChainTvlUsd(fetchFn: FetchFn = resilientFetch): Promise<number> {
  const body = await getJson(fetchFn, DEFILLAMA_CHAINS_URL, 'DefiLlama chains');
  const radix = Array.isArray(body) ? (body as Array<{ name?: string; tvl?: unknown }>).find((c) => c.name === 'Radix') : undefined;
  const tvl = pos(radix?.tvl);
  if (tvl === null) throw new SourceError('empty', 'DefiLlama chains: no Radix TVL');
  return tvl;
}

// ─── daily snapshot ───────────────────────────────────────────────────────────

export type SnapshotKind = 'price_xrd' | 'return_pct' | 'depth_xrd';
const SNAPSHOT_KEEP_DAYS = 60;

export function utcDay(ms: number, offsetDays = 0): string {
  return new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/// Value on or before the day 7 days before `now`, within a 3-day window (so a
/// missed day still compares roughly a week back, but a month-old row does not).
export function readHistory(now: number): (kind: SnapshotKind, key: string) => number | null {
  const stmt = getDb().prepare(
    'SELECT value FROM yield_snapshots WHERE kind = ? AND key = ? AND day <= ? AND day >= ? ORDER BY day DESC LIMIT 1',
  );
  const to = utcDay(now, -7);
  const from = utcDay(now, -10);
  return (kind, key) => {
    const row = stmt.get(kind, key, to, from) as { value: number } | undefined;
    return row ? row.value : null;
  };
}

/// One row per UTC day per value (first write of the day wins).
export function writeDailySnapshot(view: YieldView, now: number): void {
  const db = getDb();
  const day = utcDay(now);
  const insert = db.prepare('INSERT OR IGNORE INTO yield_snapshots (day, kind, key, value) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const a of view.assets) if (a.priceXrd !== null) insert.run(day, 'price_xrd', a.resource, a.priceXrd);
    for (const r of [...view.sections.staking, ...view.sections.feeApr, ...view.sections.alr]) {
      insert.run(day, 'return_pct', r.key, r.returnPct);
      if (r.depthXrd !== null) insert.run(day, 'depth_xrd', r.key, r.depthXrd);
    }
    db.prepare('DELETE FROM yield_snapshots WHERE day < ?').run(utcDay(now, -SNAPSHOT_KEEP_DAYS));
  })();
}

// ─── refresh (agent loop) + serve ─────────────────────────────────────────────

const REFRESH_MS = 15 * 60_000;
let latest: YieldView | null = null;
let lastAttemptAt: number | null = null;

export interface RefreshYieldDeps {
  stakingApyPct: number | null;
  minDepthUsd: number;
  fetch?: FetchFn;
  now?: number;
  force?: boolean;
}

async function sourced<T>(name: string, p: Promise<T>, rows: (v: T) => number, now: number): Promise<T | null> {
  try {
    const v = await p;
    recordSourceOutcome(name, { rows: rows(v) }, now);
    return v;
  } catch (err) {
    recordSourceOutcome(name, { error: err }, now);
    return null;
  }
}

export async function refreshYieldView(deps: RefreshYieldDeps): Promise<void> {
  const now = deps.now ?? Date.now();
  if (!deps.force && lastAttemptAt !== null && now - lastAttemptAt < REFRESH_MS) return;
  lastAttemptAt = now;
  const f = deps.fetch ?? resilientFetch;
  const [astrolescent, ociswapPools, xrdUsd, chainTvlUsd] = await Promise.all([
    sourced('astrolescent', fetchAstrolescentPrices(f), (v) => Object.keys(v).length, now),
    sourced('ociswap-pools', fetchOciswapPools(f), (v) => v.length, now),
    sourced('defillama-xrd', fetchXrdUsd(f), () => 1, now),
    sourced('defillama-chains', fetchChainTvlUsd(f), () => 1, now),
  ]);
  let history: YieldInputs['history'];
  try {
    history = readHistory(now);
  } catch (err) {
    console.error(`[yields] history read failed: ${(err as Error).message}`);
  }
  const view = buildYieldView({
    astrolescent,
    ociswapPools,
    defiplaza: getDefiPlazaRows(),
    stakingApyPct: deps.stakingApyPct,
    xrdUsd,
    chainTvlUsd,
    history,
    minDepthUsd: deps.minDepthUsd,
    now,
  });
  latest = view;
  try {
    writeDailySnapshot(view, now);
  } catch (err) {
    console.error(`[yields] snapshot write failed: ${(err as Error).message}`);
  }
}

export function getYieldView(): YieldView {
  return (
    latest ?? {
      generatedAt: null,
      banner: {
        xrdUsd: null,
        chainTvlUsd: null,
        chainTvlXrd: null,
        note: WATCHLIST.chainNote.text,
        noteSource: WATCHLIST.chainNote.source,
      },
      rules: RULES,
      assets: [],
      sections: { staking: [], feeApr: [], alr: [] },
      kickers: WATCHLIST.kickers,
      excluded: { belowFloorAssets: [], rowsBelowDepthFloor: 0, rowsDepthUnknown: 0, depthFloorXrd: null },
    }
  );
}

/// Tests only.
export function resetYieldViewForTests(): void {
  latest = null;
  lastAttemptAt = null;
}
