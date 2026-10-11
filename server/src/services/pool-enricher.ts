/// Post-scan pool enrichment (MONETIZATION #0): the scanners' static registries
/// mislabel pools (3/4 of caviarnine.ts's entries are not even CaviarNine pools)
/// and report tvl:0 where they can't read reserves — so every scanned pool is
/// re-identified against the chain before anything ranks on it:
///   1. protocol / kind / token identity from the runtime blueprint resolver
///      (dex/pool-resolver — the labels IL and risk math key off),
///   2. display name rebuilt from on-ledger token symbols,
///   3. TVL filled from the pool's own vault balances × spot USD prices where
///      the scanner reported none,
///   4. pair risk (vol/correlation/expected-IL) attached from the price feed,
///      with a skeptical default when no usable history exists.
/// Every step is best-effort per pool: an unresolvable pool keeps its scanned
/// labels (kind stays undefined) rather than blocking the scan cycle.

import type { GatewayClient, PoolInfo, PoolRisk } from './gateway.js';
import { resilientFetch } from './gateway.js';
import { resolvePool, type ResolvedPool } from './dex/pool-resolver.js';
import { getPairRisk, type PairRisk } from './price-feed.js';
import { expectedIlPctForKind } from './calculators.js';

const OCISWAP_API = 'https://api.ociswap.com';
const GW_BATCH = 20; // /state/entity/details address cap
const PRICE_TTL_MS = 60 * 60 * 1000;
const SQRT365 = Math.sqrt(365);

/// Skeptical prior when the price feed has no usable history: 100% annualized
/// per-token vol, uncorrelated → σ_rel = 100%, E[IL] = −12.5%/yr.
export const DEFAULT_RISK: PoolRisk = {
  volatility: 1 / SQRT365,
  correlation: 0,
  relAnnualVol: 1,
  estimatedIlPct: -12.5,
  source: 'default',
};

export interface EnrichDeps {
  resolve?: (address: string) => Promise<Pick<ResolvedPool, 'protocol' | 'kind' | 'tokenX' | 'tokenY'>>;
  pairRisk?: (tokenA: string, tokenB: string) => Promise<PairRisk | null>;
  symbols?: (addrs: string[]) => Promise<Map<string, string>>;
  tvls?: (addrs: string[]) => Promise<Map<string, number>>;
}

export async function enrichPools(
  gw: GatewayClient,
  pools: PoolInfo[],
  deps: EnrichDeps = {},
): Promise<PoolInfo[]> {
  const resolve = deps.resolve ?? ((a: string) => resolvePool(gw, a));
  const pairRisk = deps.pairRisk ?? ((a: string, b: string) => getPairRisk(a, b));
  const symbols = deps.symbols ?? ((addrs: string[]) => fetchSymbols(gw, addrs));
  const tvls = deps.tvls ?? ((addrs: string[]) => fetchPoolTvls(gw, addrs));

  // Dedupe by address — with registries mislabeling protocols, two scanners can
  // list the SAME live pool; keep the entry with live APY data when they do.
  const byAddr = new Map<string, PoolInfo>();
  for (const p of pools) {
    const prev = byAddr.get(p.address);
    if (!prev || (prev.apySource !== 'live' && p.apySource === 'live')) {
      byAddr.set(p.address, { ...p });
    }
  }
  // IL-free entries (native XRD staking, single-asset lending) are not AMM
  // pool components, so every step below is wrong for them: the resolver has no
  // blueprint to read, the symbol pass would rewrite "XRD staking" to "XRD-XRD"
  // because both legs are the same resource, and the pair-risk pass would
  // attach a divergence model to an asset that cannot diverge from itself.
  // They bypass enrichment entirely and are appended back unchanged.
  const all = [...byAddr.values()];
  const passthrough = all.filter((p) => p.yieldKind && p.yieldKind !== 'amm-lp');
  const out = all.filter((p) => !p.yieldKind || p.yieldKind === 'amm-lp');

  // 1. Runtime identity. The resolver caches per address, so this costs Gateway
  // calls on first sight of a pool only.
  await Promise.all(
    out.map(async (p) => {
      try {
        const r = await resolve(p.address);
        p.kind = r.kind;
        if (r.kind !== 'unsupported') {
          p.protocol = r.protocol;
          p.tokenA = r.tokenX;
          p.tokenB = r.tokenY;
        }
      } catch {
        // unresolved (Gateway hiccup): keep scanner labels, kind stays undefined
      }
    }),
  );

  // 2. Display names from on-ledger token symbols.
  const tokenAddrs = [...new Set(out.flatMap((p) => [p.tokenA, p.tokenB]))].filter((a) =>
    a.startsWith('resource_'),
  );
  try {
    const sym = await symbols(tokenAddrs);
    for (const p of out) {
      const a = sym.get(p.tokenA);
      const b = sym.get(p.tokenB);
      if (a && b) p.name = `${a}-${b}`;
    }
  } catch {
    // names stay as scanned
  }

  // 3. TVL fill where the scanner reported none. Reads the pool component's own
  // vaults — right for Ociswap/CaviarNine kinds; DefiPlaza pairs keep reserves
  // in child native pools, so a plaza pair that scanned as 0 stays 0 here.
  const needTvl = out
    .filter((p) => !(parseFloat(p.tvl) > 0) && p.kind && p.kind !== 'unsupported')
    .map((p) => p.address);
  if (needTvl.length > 0) {
    try {
      const tvlMap = await tvls(needTvl);
      for (const p of out) {
        const v = tvlMap.get(p.address);
        if (v && v > 0) p.tvl = v.toFixed(2);
      }
    } catch {
      // scanner TVL stands
    }
  }

  // 4. Pair risk — live feed when both tokens have history, default otherwise.
  await Promise.all(
    out.map(async (p) => {
      let risk: PoolRisk | null = null;
      if (p.tokenA.startsWith('resource_') && p.tokenB.startsWith('resource_')) {
        try {
          const pr = await pairRisk(p.tokenA, p.tokenB);
          if (pr) {
            // Blueprint-dispatched expected IL (#4). Pool weights aren't
            // resolved yet, so every kind runs at w=0.5 today — identical to
            // pr.estimatedIlPct — but the dispatch seam (and the DefiPlaza
            // pending-calibration flag) lives here.
            risk = {
              volatility: (pr.dailyVolA + pr.dailyVolB) / 2,
              correlation: pr.correlation,
              relAnnualVol: pr.relAnnualVol,
              estimatedIlPct: expectedIlPctForKind(p.kind, pr.relAnnualVol).ilPct,
              source: 'live',
            };
          }
        } catch {
          // fall through to default
        }
      }
      p.risk = risk ?? DEFAULT_RISK;
    }),
  );

  return [...out, ...passthrough];
}

// ─── default dep implementations ──────────────────────────────────────────────

/// Token symbols are immutable — cache forever.
const symbolCache = new Map<string, string>();

async function fetchSymbols(gw: GatewayClient, addrs: string[]): Promise<Map<string, string>> {
  const missing = addrs.filter((a) => !symbolCache.has(a));
  for (let i = 0; i < missing.length; i += GW_BATCH) {
    const res = await gw.entityDetailsGlobal(missing.slice(i, i + GW_BATCH), {
      explicit_metadata: ['symbol'],
    });
    for (const item of res.items ?? []) {
      const sym = item.metadata?.items?.find((m) => m.key === 'symbol')?.value?.typed?.value;
      if (sym && item.address) symbolCache.set(item.address, sym);
    }
  }
  return symbolCache;
}

const priceCache = new Map<string, { at: number; usd: number }>();

async function tokenUsdPrice(token: string): Promise<number> {
  const cached = priceCache.get(token);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.usd;
  let usd = 0;
  try {
    const resp = await resilientFetch(`${OCISWAP_API}/prices/${token}`);
    if (resp.ok) {
      const j = (await resp.json()) as { price?: { usd?: string } };
      usd = parseFloat(j.price?.usd ?? '0') || 0;
    }
  } catch {
    // usd stays 0 — the token simply contributes nothing to TVL
  }
  priceCache.set(token, { at: Date.now(), usd });
  return usd;
}

/// TVL from a pool component's own vault balances × spot USD prices.
async function fetchPoolTvls(gw: GatewayClient, addrs: string[]): Promise<Map<string, number>> {
  const balances = new Map<string, Map<string, number>>(); // pool → resource → amount
  for (let i = 0; i < addrs.length; i += GW_BATCH) {
    const res = await gw.post<{
      items: Array<{
        address: string;
        fungible_resources?: {
          items: Array<{ resource_address: string; vaults?: { items: Array<{ amount?: string }> } }>;
        };
      }>;
    }>('/state/entity/details', {
      addresses: addrs.slice(i, i + GW_BATCH),
      aggregation_level: 'Vault',
    });
    for (const item of res.items ?? []) {
      const perResource = new Map<string, number>();
      for (const r of item.fungible_resources?.items ?? []) {
        const total = (r.vaults?.items ?? []).reduce((s, v) => s + (parseFloat(v.amount ?? '0') || 0), 0);
        if (total > 0) perResource.set(r.resource_address, total);
      }
      balances.set(item.address, perResource);
    }
  }

  const uniqueTokens = [...new Set([...balances.values()].flatMap((m) => [...m.keys()]))];
  const prices = new Map<string, number>();
  await Promise.all(uniqueTokens.map(async (t) => prices.set(t, await tokenUsdPrice(t))));

  const out = new Map<string, number>();
  for (const [pool, perResource] of balances) {
    let tvl = 0;
    for (const [token, amount] of perResource) tvl += amount * (prices.get(token) ?? 0);
    out.set(pool, tvl);
  }
  return out;
}
