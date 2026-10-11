/// Runtime DEX pool resolver.
///
/// Given ANY pool component address, classify its real blueprint against mainnet
/// and extract the tokens / LP resource / params needed to build a liquidity
/// manifest. Deliberately Gateway-only (no protocol API dependency) so it works
/// for any current or future pool — the scanner's static labels are NOT trusted
/// (caviarnine.ts mislabels 3/4 of its pools). Verified paths: docs/DEX-INTEGRATION.md.
///
/// Unknown blueprint → kind 'unsupported'; callers must build no manifest.
/// A known blueprint NAME on an unpinned package is also 'unsupported' (DF-1):
/// anyone can publish a package with a blueprint called "PrecisionPool", so the
/// name alone is not an identity — the (blueprint, package) pair is.

import { CONFIG, DEX_PACKAGE_ENV, type PinnedPoolKind } from '../../config.js';
import type { GatewayClient, GwEntityItem, GwStateField } from '../gateway.js';

/// DefiPlaza PlazaDex router — the audited front-end path. Pairs are PlazaPair
/// components; deposits/withdrawals route through this single router.
export const DEFIPLAZA_ROUTER =
  'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68';

export type PoolKind =
  | 'ociswap_basic'
  | 'ociswap_precision'
  | 'caviarnine_weighted'
  | 'caviarnine_quantaswap'
  | 'defiplaza_pair'
  | 'unsupported';

const BLUEPRINT_KIND: Record<string, PoolKind> = {
  BasicPool: 'ociswap_basic',
  PrecisionPool: 'ociswap_precision',
  WeightedPool: 'caviarnine_weighted',
  QuantaSwap: 'caviarnine_quantaswap',
  PlazaPair: 'defiplaza_pair',
};

/// Packages VERIFIED on mainnet and recorded in docs/DEX-INTEGRATION.md
/// ("Concentrated math — VERIFIED", 2026-07-18). Only these two are recorded in
/// the repo; the other kinds have no verified package on record, so until the
/// operator pins one via its DEX_PACKAGES_* env var (config.ts DEX_PACKAGE_ENV)
/// every pool of that kind resolves as 'unsupported' — fail closed, not
/// "trust the name". Never add an address here that is not verified in the doc.
export const VERIFIED_POOL_PACKAGES: Readonly<Record<PinnedPoolKind, readonly string[]>> = {
  ociswap_basic: [],
  ociswap_precision: ['package_rdx1pkrgvskdkglfd2ar4jkpw5r2tsptk85gap4hzr9h3qxw6ca40ts8dt'],
  caviarnine_weighted: [],
  caviarnine_quantaswap: ['package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3'],
  defiplaza_pair: [],
};

/// Is `packageAddress` a pinned package for `kind`? Recorded defaults plus the
/// operator's DEX_PACKAGES_* additions. An empty/missing package never matches.
export function isPinnedPackage(kind: PinnedPoolKind, packageAddress: string): boolean {
  if (!packageAddress) return false;
  return (
    VERIFIED_POOL_PACKAGES[kind].includes(packageAddress) ||
    CONFIG.DEX_PACKAGE_PINS[kind].includes(packageAddress)
  );
}

/// Why a pool resolved as 'unsupported' — distinct names so a log or a test can
/// tell "never heard of this blueprint" from "right name, unverified package".
export type UnsupportedReason = 'unknown_blueprint' | 'unpinned_package';

/// How a position is represented on-chain — drives the withdraw manifest and
/// position tracking (fungible pool-unit vs NFT receipt vs DefiPlaza's two LPs).
export type LpModel =
  | { kind: 'fungible'; resource: string }
  | { kind: 'nft'; resource: string }
  | { kind: 'defiplaza'; baseLp: string; quoteLp: string };

export interface ResolvedPool {
  address: string;
  protocol: 'ociswap' | 'caviarnine' | 'defiplaza' | 'unknown';
  kind: PoolKind;
  blueprintName: string;
  packageAddress: string;
  /// True for tick/bin pools that need a price range on deposit.
  concentrated: boolean;
  tokenX: string;
  tokenY: string;
  lp: LpModel;
  /// Ociswap PrecisionPool: tick granularity + current tick. `priceSqrt` is the
  /// authoritative current price (√, token_y per token_x) — prefer it over
  /// `activeTick` for centering a range (activeTick goes stale on dead pools).
  tickSpacing?: number;
  activeTick?: number;
  priceSqrt?: string;
  /// CaviarNine QuantaSwap: bin granularity + current bin + the active bin's price
  /// boundaries (lowerLimit = price(activeBin), upperLimit = price(activeBin+binSpan)).
  binSpan?: number;
  activeBin?: number;
  lowerLimit?: string;
  upperLimit?: string;
  /// DefiPlaza: which side is in shortage (co-liquidity required to add there).
  shortage?: 'BaseShortage' | 'QuoteShortage' | 'Equilibrium' | 'unknown';
  /// DefiPlaza: the router to call (pairs are deposited via the router).
  router?: string;
  /// Set only when kind === 'unsupported'.
  unsupportedReason?: UnsupportedReason;
}

// ─── state-field / metadata helpers ───────────────────────────────────────────

function meta(item: GwEntityItem, key: string): string | undefined {
  return item.metadata?.items?.find((m) => m.key === key)?.value?.typed?.value;
}

function field(fields: GwStateField[] | undefined, name: string): GwStateField | undefined {
  return fields?.find((f) => f.field_name === name);
}

/// A Reference field's value IS the referenced address.
function ref(fields: GwStateField[] | undefined, name: string): string | undefined {
  return field(fields, name)?.value;
}

function intField(fields: GwStateField[] | undefined, name: string): number | undefined {
  const v = field(fields, name)?.value;
  return v === undefined ? undefined : Number(v);
}

/// Enum wrapping a single scalar, e.g. active_tick = Enum{ I32 } → the inner value.
function enumInner(f: GwStateField | undefined): string | undefined {
  return f?.fields?.[0]?.value;
}

/// QuantaSwap active bin: tick_index → current (Enum Some) → Tuple(Tick) → U32.
/// (A naive intField(tick_index.fields,'current') reads the Enum as a scalar → NaN.)
function quantaCurrentBin(fields: GwStateField[] | undefined): number | undefined {
  const current = field(field(fields, 'tick_index')?.fields, 'current'); // Enum<Option>
  if (current?.variant_name !== 'Some') return undefined;
  const v = current.fields?.[0]?.fields?.[0]?.value; // Tuple(Tick) → U32
  return v === undefined ? undefined : Number(v);
}

class ResolveError extends Error {}

// ─── resolver ─────────────────────────────────────────────────────────────────

/// pools never change blueprint/tokens, so cache the resolution. Params that DO
/// move (activeTick/activeBin/shortage) are refreshed by refreshDynamic().
/// BOUNDED (DF-7): the key is caller-supplied on public routes
/// (/api/dex/pool-info, /api/dex/build), so an unbounded map grows the heap
/// with every distinct address anyone asks about. Map iteration is insertion
/// order, so the first key is the oldest; a hit is re-inserted (LRU).
export const RESOLVER_CACHE_MAX = 512;
const cache = new Map<string, ResolvedPool>();

function cacheGet(address: string): ResolvedPool | undefined {
  const hit = cache.get(address);
  if (hit) {
    cache.delete(address);
    cache.set(address, hit);
  }
  return hit;
}

function cachePut(address: string, pool: ResolvedPool): void {
  cache.delete(address);
  cache.set(address, pool);
  while (cache.size > RESOLVER_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function _clearResolverCache(): void {
  cache.clear();
}

export function _resolverCacheSize(): number {
  return cache.size;
}

function unsupportedPool(
  address: string, blueprintName: string, packageAddress: string, reason: UnsupportedReason,
): ResolvedPool {
  return {
    address, protocol: 'unknown', kind: 'unsupported', blueprintName, packageAddress,
    concentrated: false, tokenX: '', tokenY: '', lp: { kind: 'fungible', resource: '' },
    unsupportedReason: reason,
  };
}

export async function resolvePool(gw: GatewayClient, address: string): Promise<ResolvedPool> {
  const cached = cacheGet(address);
  if (cached) return cached;

  const res = await gw.entityDetailsGlobal([address], {
    explicit_metadata: ['name', 'x_address', 'y_address', 'lp_address', 'tick_spacing', 'token_x', 'token_y'],
  });
  const item = res.items?.[0];
  const det = item?.details;
  const blueprintName = det?.blueprint_name ?? '';
  const packageAddress = det?.package_address ?? '';
  const kind = BLUEPRINT_KIND[blueprintName] ?? 'unsupported';

  if (kind === 'unsupported') {
    const pool = unsupportedPool(address, blueprintName, packageAddress, 'unknown_blueprint');
    cachePut(address, pool);
    return pool;
  }
  if (!isPinnedPackage(kind, packageAddress)) {
    // Right blueprint name, unverified package: a lookalike until proven
    // otherwise. Server-side hint only — the public error names no env var.
    console.warn(
      `[pool-resolver] ${address}: ${blueprintName} on unpinned package ${packageAddress || '(none)'} ` +
        `→ unsupported (pin it via ${DEX_PACKAGE_ENV[kind]} once verified on mainnet)`,
    );
    const pool = unsupportedPool(address, blueprintName, packageAddress, 'unpinned_package');
    cachePut(address, pool);
    return pool;
  }

  const fields = det?.state?.fields;
  let pool: ResolvedPool;
  switch (kind) {
    case 'ociswap_basic':
      pool = await resolveBasic(gw, address, blueprintName, packageAddress, item!, fields);
      break;
    case 'ociswap_precision':
      pool = resolvePrecision(address, blueprintName, packageAddress, item!, fields);
      break;
    case 'caviarnine_weighted':
      pool = await resolveWeighted(gw, address, blueprintName, packageAddress, fields);
      break;
    case 'caviarnine_quantaswap':
      pool = await resolveQuantaSwap(gw, address, blueprintName, packageAddress, item!, fields);
      break;
    case 'defiplaza_pair':
      pool = await resolvePlazaPair(gw, address, blueprintName, packageAddress, fields);
      break;
    default:
      throw new ResolveError(`unreachable kind ${kind}`);
  }
  cachePut(address, pool);
  return pool;
}

/// Ociswap BasicPool: x/y in state (+ metadata); LP = native liquidity_pool's pool unit.
async function resolveBasic(
  gw: GatewayClient, address: string, blueprintName: string, packageAddress: string,
  item: GwEntityItem, fields?: GwStateField[],
): Promise<ResolvedPool> {
  const tokenX = ref(fields, 'x_address') ?? meta(item, 'x_address') ?? '';
  const tokenY = ref(fields, 'y_address') ?? meta(item, 'y_address') ?? '';
  const nativePool = ref(fields, 'liquidity_pool');
  if (!tokenX || !tokenY || !nativePool) throw new ResolveError(`BasicPool ${address}: missing x/y/liquidity_pool`);
  const lpResource = await nativePoolUnit(gw, nativePool);
  return {
    address, protocol: 'ociswap', kind: 'ociswap_basic', blueprintName, packageAddress,
    concentrated: false, tokenX, tokenY, lp: { kind: 'fungible', resource: lpResource },
  };
}

/// Ociswap PrecisionPool: everything from metadata + state (no follow-up).
function resolvePrecision(
  address: string, blueprintName: string, packageAddress: string,
  item: GwEntityItem, fields?: GwStateField[],
): ResolvedPool {
  const tokenX = meta(item, 'x_address') ?? '';
  const tokenY = meta(item, 'y_address') ?? '';
  const lpResource = meta(item, 'lp_address') ?? '';
  const tickSpacing = Number(meta(item, 'tick_spacing') ?? intField(fields, 'tick_spacing'));
  const activeTick = Number(enumInner(field(fields, 'active_tick')));
  const priceSqrt = field(fields, 'price_sqrt')?.value;
  if (!tokenX || !tokenY || !lpResource || !Number.isFinite(tickSpacing)) {
    throw new ResolveError(`PrecisionPool ${address}: missing x/y/lp/tick_spacing`);
  }
  return {
    address, protocol: 'ociswap', kind: 'ociswap_precision', blueprintName, packageAddress,
    concentrated: true, tokenX, tokenY, lp: { kind: 'nft', resource: lpResource },
    tickSpacing, activeTick: Number.isFinite(activeTick) ? activeTick : undefined, priceSqrt,
  };
}

/// CaviarNine WeightedPool: LP + tokens from the native resource_pool. Bucket
/// ORDER for add_liquidity(x,y) is resolved at build time via preview-retry
/// (the pool's x/y order is not exposed as plain x/y), so tokenX/tokenY here are
/// the native pool's vault order and may be swapped by the builder.
async function resolveWeighted(
  gw: GatewayClient, address: string, blueprintName: string, packageAddress: string,
  fields?: GwStateField[],
): Promise<ResolvedPool> {
  const nativePool = ref(fields, 'resource_pool');
  if (!nativePool) throw new ResolveError(`WeightedPool ${address}: missing resource_pool`);
  const { poolUnit, tokens } = await nativePoolDetails(gw, nativePool);
  if (tokens.length < 2) throw new ResolveError(`WeightedPool ${address}: native pool has <2 tokens`);
  return {
    address, protocol: 'caviarnine', kind: 'caviarnine_weighted', blueprintName, packageAddress,
    concentrated: false, tokenX: tokens[0], tokenY: tokens[1], lp: { kind: 'fungible', resource: poolUnit },
  };
}

/// CaviarNine QuantaSwap (bins, NFT receipt): tokens from component metadata
/// token_x/token_y (canonical order, matches add_liquidity(x,y,…)); LP NFT from
/// liquidity_receipt_manager; bin_span + active bin from state. Falls back to the
/// component's vault→resource map if metadata is absent (internal-vault state can
/// come back empty).
async function resolveQuantaSwap(
  gw: GatewayClient, address: string, blueprintName: string, packageAddress: string,
  item: GwEntityItem, fields?: GwStateField[],
): Promise<ResolvedPool> {
  const lpResource = ref(fields, 'liquidity_receipt_manager') ?? '';
  const binSpan = intField(fields, 'bin_span');
  if (!lpResource || binSpan === undefined) {
    throw new ResolveError(`QuantaSwap ${address}: missing lp/bin_span`);
  }
  let tokenX = meta(item, 'token_x');
  let tokenY = meta(item, 'token_y');
  if (!tokenX || !tokenY) {
    const map = await componentVaultResourceMap(gw, address);
    tokenX = tokenX ?? map.get(field(fields, 'tokens_x')?.value ?? '');
    tokenY = tokenY ?? map.get(field(fields, 'tokens_y')?.value ?? '');
  }
  if (!tokenX || !tokenY) throw new ResolveError(`QuantaSwap ${address}: could not resolve tokens`);
  const activeBin = quantaCurrentBin(fields);
  const lowerLimit = field(fields, 'lower_limit')?.value;
  const upperLimit = field(fields, 'upper_limit')?.value;
  return {
    address, protocol: 'caviarnine', kind: 'caviarnine_quantaswap', blueprintName, packageAddress,
    concentrated: true, tokenX, tokenY, lp: { kind: 'nft', resource: lpResource },
    binSpan, activeBin, lowerLimit, upperLimit,
  };
}

/// DefiPlaza PlazaPair: tokens in state; two fungible LPs from base_pool/quote_pool;
/// shortage side drives the co-liquidity rule. Deposits route via the router.
async function resolvePlazaPair(
  gw: GatewayClient, address: string, blueprintName: string, packageAddress: string,
  fields?: GwStateField[],
): Promise<ResolvedPool> {
  const tokenX = ref(fields, 'base_address') ?? '';
  const tokenY = ref(fields, 'quote_address') ?? '';
  const basePool = ref(fields, 'base_pool');
  const quotePool = ref(fields, 'quote_pool');
  if (!tokenX || !tokenY || !basePool || !quotePool) {
    throw new ResolveError(`PlazaPair ${address}: missing base/quote token or pool`);
  }
  const [baseLp, quoteLp] = await Promise.all([
    nativePoolUnit(gw, basePool),
    nativePoolUnit(gw, quotePool),
  ]);
  const shortageVariant = field(field(fields, 'state')?.fields, 'shortage')?.variant_name;
  const shortage =
    shortageVariant === 'BaseShortage' || shortageVariant === 'QuoteShortage' || shortageVariant === 'Equilibrium'
      ? shortageVariant
      : 'unknown';
  return {
    address, protocol: 'defiplaza', kind: 'defiplaza_pair', blueprintName, packageAddress,
    concentrated: false, tokenX, tokenY, lp: { kind: 'defiplaza', baseLp, quoteLp },
    shortage, router: DEFIPLAZA_ROUTER,
  };
}

// ─── native-pool / internal-vault follow-ups ──────────────────────────────────

async function nativePoolDetails(
  gw: GatewayClient, poolAddress: string,
): Promise<{ poolUnit: string; tokens: string[] }> {
  const res = await gw.entityDetailsGlobal([poolAddress], { native_resource_details: true });
  const st = res.items?.[0]?.details?.state;
  const poolUnit = st?.pool_unit_resource_address ?? '';
  const tokens = (st?.vaults ?? []).map((v) => v.resource_address ?? '').filter(Boolean);
  if (!poolUnit) throw new ResolveError(`native pool ${poolAddress}: no pool_unit_resource_address`);
  return { poolUnit, tokens };
}

async function nativePoolUnit(gw: GatewayClient, poolAddress: string): Promise<string> {
  return (await nativePoolDetails(gw, poolAddress)).poolUnit;
}

/// Map every internal vault the component holds → its resource, via Vault
/// aggregation (works even when an internal vault's own state comes back empty).
async function componentVaultResourceMap(
  gw: GatewayClient, address: string,
): Promise<Map<string, string>> {
  const res = await gw.post<{
    items: Array<{
      fungible_resources?: {
        items: Array<{ resource_address: string; vaults?: { items: Array<{ vault_address: string }> } }>;
      };
    }>;
  }>('/state/entity/details', { addresses: [address], aggregation_level: 'Vault' });
  const map = new Map<string, string>();
  for (const fr of res.items?.[0]?.fungible_resources?.items ?? []) {
    for (const v of fr.vaults?.items ?? []) map.set(v.vault_address, fr.resource_address);
  }
  return map;
}

/// Refresh only the moving params (tick/bin/shortage) for a cached pool.
export async function refreshDynamic(gw: GatewayClient, pool: ResolvedPool): Promise<ResolvedPool> {
  if (!pool.concentrated && pool.kind !== 'defiplaza_pair') return pool;
  const res = await gw.entityDetailsGlobal([pool.address], {});
  const fields = res.items?.[0]?.details?.state?.fields;
  if (pool.kind === 'ociswap_precision') {
    const t = Number(enumInner(field(fields, 'active_tick')));
    if (Number.isFinite(t)) pool.activeTick = t;
    const ps = field(fields, 'price_sqrt')?.value;
    if (ps) pool.priceSqrt = ps;
  } else if (pool.kind === 'caviarnine_quantaswap') {
    const b = quantaCurrentBin(fields);
    if (b !== undefined) pool.activeBin = b;
    const lo = field(fields, 'lower_limit')?.value;
    const up = field(fields, 'upper_limit')?.value;
    if (lo) pool.lowerLimit = lo;
    if (up) pool.upperLimit = up;
  } else if (pool.kind === 'defiplaza_pair') {
    const v = field(field(fields, 'state')?.fields, 'shortage')?.variant_name;
    if (v) pool.shortage = v as ResolvedPool['shortage'];
  }
  return pool;
}
