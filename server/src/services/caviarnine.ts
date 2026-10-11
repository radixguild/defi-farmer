/// CaviarNine pool scanner — reads static pool registry via Gateway API.
/// CaviarNine has no public pool-listing API, so addresses are static.
/// Pools store liquidity in a child `resource_pool` (native TwoResourcePool);
/// we read that via Gateway and convert XRD -> USD using Ociswap's price endpoint.

import type { GatewayClient, PoolInfo } from './gateway.js';
import { getXrdUsdPrice } from './ociswap.js';
import { getDb } from '../db/schema.js';

const XRD_RESOURCE = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// Known CaviarNine mainnet pools (static list, verified against Gateway reads).
const CAVIARNINE_POOLS: Array<{
  address: string;
  name: string;
  tokenA: string;
  tokenB: string;
}> = [
  {
    address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
    name: 'XRD-xUSDC',
    tokenA: 'XRD',
    tokenB: 'xUSDC',
  },
  {
    address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
    name: 'XRD-xUSDT',
    tokenA: 'XRD',
    tokenB: 'xUSDT',
  },
  {
    address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
    name: 'XRD-xWBTC',
    tokenA: 'XRD',
    tokenB: 'xWBTC',
  },
  {
    address: 'component_rdx1crwdzvlv7djtkug9gmvp9ejun0gm0w6cvkpfqycw8fcp4gg82eftjc',
    name: 'XRD-xETH',
    tokenA: 'XRD',
    tokenB: 'xETH',
  },
];

export async function scanCaviarNine(gateway: GatewayClient): Promise<PoolInfo[]> {
  // Step 1: read each pool component and extract its resource_pool reference.
  const poolDetails = await gateway.post<{
    items: Array<{
      address: string;
      details?: {
        state?: {
          fields?: Array<{ field_name?: string; value?: string }>;
        };
      };
    }>;
  }>('/state/entity/details', {
    addresses: CAVIARNINE_POOLS.map((p) => p.address),
    aggregation_level: 'Vault',
  });

  const resourcePoolByComponent = new Map<string, string>();
  for (const item of poolDetails.items ?? []) {
    const rp = item.details?.state?.fields?.find((f) => f.field_name === 'resource_pool')?.value;
    if (rp) resourcePoolByComponent.set(item.address, rp);
  }

  // Step 2: batch-read the resource_pools — that's where the actual vaults live.
  const rpAddresses = Array.from(resourcePoolByComponent.values());
  if (rpAddresses.length === 0) return [];

  const rpDetails = await gateway.post<{
    items: Array<{
      address: string;
      fungible_resources?: {
        items: Array<{
          resource_address: string;
          vaults?: { items: Array<{ amount: string }> };
        }>;
      };
    }>;
  }>('/state/entity/details', {
    addresses: rpAddresses,
    aggregation_level: 'Vault',
  });

  const balancesByRp = new Map<string, Map<string, number>>();
  for (const item of rpDetails.items ?? []) {
    const balances = new Map<string, number>();
    for (const r of item.fungible_resources?.items ?? []) {
      const total = (r.vaults?.items ?? []).reduce(
        (s, v) => s + parseFloat(v.amount ?? '0'),
        0,
      );
      if (total > 0) balances.set(r.resource_address, total);
    }
    balancesByRp.set(item.address, balances);
  }

  // Step 3: derive USD TVL. Assume pool balanced -> total = 2 x XRD-side x xrd_usd.
  const xrdUsd = await getXrdUsdPrice();
  // Estimate APY from pool_snapshots 7d history
  const db = getDb();
  const results: PoolInfo[] = [];
  for (const pool of CAVIARNINE_POOLS) {
    const rp = resourcePoolByComponent.get(pool.address);
    const balances = rp ? balancesByRp.get(rp) : undefined;
    const xrdBal = balances?.get(XRD_RESOURCE) ?? 0;
    const tvlUsd = xrdBal > 0 && xrdUsd > 0 ? (xrdBal * 2 * xrdUsd).toFixed(2) : '0';

    // Try to estimate APY from 7d snapshot history
    const snapshots = db
      .prepare(
        `SELECT apy_bps FROM pool_snapshots
         WHERE pool_address = ? AND scanned_at >= datetime('now', '-7 days')
         ORDER BY scanned_at DESC`
      )
      .all(pool.address) as Array<{ apy_bps: number }>;

    let apy = 0;
    let apySource: PoolInfo['apySource'] = 'unknown';
    if (snapshots.length > 0) {
      const avg = snapshots.reduce((sum, s) => sum + s.apy_bps, 0) / snapshots.length;
      apy = avg / 100; // bps to percentage
      apySource = 'estimated';
    }

    results.push({
      address: pool.address,
      name: pool.name,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      tvl: tvlUsd,
      apy,
      protocol: 'caviarnine',
      audited: true,
      apySource,
    });
  }
  return results;
}
