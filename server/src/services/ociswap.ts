/// Ociswap pool scanner — fetches pool data from the Ociswap public API.
/// Uses resilientFetch (retry + backoff + timeout) for all external HTTP calls.

import type { GatewayClient, PoolInfo } from './gateway.js';
import { resilientFetch } from './gateway.js';

const OCISWAP_API = 'https://api.ociswap.com';
const XRD_RESOURCE = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

interface OciswapPool {
  address: string;
  name: string;
  apr?: { '24h'?: string; '7d'?: string };
  total_value_locked?: { usd?: { now?: string } };
  x?: { token?: { address?: string } };
  y?: { token?: { address?: string } };
}

interface OciswapPoolsResponse {
  data: OciswapPool[];
  next_cursor?: string | number | null;
}

const PAGE_SIZE = 100;
/// Ociswap listed 1,847 pools on 2026-07-25, but the tail is dust: total TVL
/// across the whole venue is ~$121k and the largest single pool ~$13k. The
/// index is rank-ordered, so the first few pages hold everything that matters;
/// this cap keeps the scan bounded while going far beyond the previous 50.
const MAX_PAGES = 5;

/**
 * Scan Ociswap's pool index.
 *
 * Previously this fetched `?limit=50` and dropped `next_cursor`, so it scored
 * 50 of 1,847 pools. The index IS rank-ordered (each pool carries a `rank`),
 * so page 1 was never an arbitrary sample — but coverage still stopped dead at
 * the 50th-ranked pool.
 *
 * `apr` values are FRACTIONS, so `× 100` yields a percentage: OCI/XRD's
 * `apr['24h'] = 0.004257` is 0.43%/yr, which reconciles with its $57 of daily
 * volume against $12.7k of TVL. Do not "fix" this into a 100× overstatement.
 */
export async function scanOciswap(_gateway: GatewayClient): Promise<PoolInfo[]> {
  const pools: PoolInfo[] = [];
  let cursor: string | number | null | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${OCISWAP_API}/pools?limit=${PAGE_SIZE}` +
      (cursor != null ? `&cursor=${encodeURIComponent(String(cursor))}` : '');
    const resp = await resilientFetch(url);
    // A mid-scan failure keeps the pages already collected rather than losing
    // the whole scan cycle; page 0 failing is a real error worth surfacing.
    if (!resp.ok) {
      if (page === 0) throw new Error(`Ociswap /pools ${resp.status}`);
      break;
    }
    const json = (await resp.json()) as OciswapPoolsResponse;
    const batch = json.data ?? [];
    for (const p of batch) {
      pools.push({
        address: p.address,
        name: p.name,
        tokenA: p.x?.token?.address ?? '',
        tokenB: p.y?.token?.address ?? '',
        tvl: p.total_value_locked?.usd?.now ?? '0',
        apy: parseFloat(p.apr?.['24h'] ?? '0') * 100,
        protocol: 'ociswap',
        audited: true,
        apySource: 'live' as const,
        yieldKind: 'amm-lp' as const,
      });
    }
    cursor = json.next_cursor;
    if (cursor == null || batch.length === 0) break;
  }

  return pools;
}

export async function getXrdUsdPrice(): Promise<number> {
  const resp = await resilientFetch(`${OCISWAP_API}/tokens/${XRD_RESOURCE}`);
  if (!resp.ok) return 0;
  const json = (await resp.json()) as { price?: { usd?: { now?: string } } };
  return parseFloat(json.price?.usd?.now ?? '0');
}
