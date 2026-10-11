/// DefiPlaza pool scanner — scans DefiPlaza DEX on Radix mainnet.
/// Primary: Gateway API reads component state + pair details.
/// Fallback: scrapes stats.defiplaza.net when Gateway path fails.
/// All external HTTP calls use resilientFetch (retry + backoff + timeout).

import type { GatewayClient, PoolInfo } from './gateway.js';
import { resilientFetch } from './gateway.js';
import { getXrdUsdPrice } from './ociswap.js';

const DEFIPLAZA_COMPONENT =
  'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68';

const DEFIPLAZA_STATS_URL = 'https://stats.defiplaza.net';

export async function scanDefiPlaza(gateway: GatewayClient): Promise<PoolInfo[]> {
  try {
    return await scanViaGateway(gateway);
  } catch (err) {
    console.error(`[defiplaza] Gateway path failed, trying fallback: ${err}`);
    try {
      return await scanViaFallback(gateway);
    } catch (fallbackErr) {
      console.error(`[defiplaza] Fallback also failed: ${fallbackErr}`);
      return [];
    }
  }
}

async function scanViaGateway(gateway: GatewayClient): Promise<PoolInfo[]> {
  // Read the DefiPlaza component state to find pair addresses
  const state = (await gateway.getComponentState(DEFIPLAZA_COMPONENT)) as {
    items?: Array<{
      details?: {
        state?: {
          fields?: Array<{
            field_name?: string;
            type_name?: string;
            entries?: Array<{
              key?: { value?: string };
              value?: { value?: string };
            }>;
            elements?: Array<{ value?: string }>;
          }>;
        };
      };
    }>;
  };

  // Extract pair addresses from component state
  const pairAddresses: string[] = [];
  const items = state.items ?? [];
  for (const item of items) {
    const fields = item.details?.state?.fields ?? [];
    for (const field of fields) {
      if (field.entries) {
        for (const entry of field.entries) {
          const addr = entry.key?.value ?? entry.value?.value ?? '';
          if (addr.startsWith('component_rdx1')) pairAddresses.push(addr);
        }
      }
      if (field.elements) {
        for (const elem of field.elements) {
          if (elem.value?.startsWith('component_rdx1')) pairAddresses.push(elem.value);
        }
      }
    }
  }

  if (pairAddresses.length === 0) return [];

  // Batch-read pair details
  const details = await gateway.batchEntityDetails(pairAddresses);
  const xrdUsd = await getXrdUsdPrice();

  const XRD_RESOURCE = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
  const pools: PoolInfo[] = [];

  for (const item of details.items ?? []) {
    const resources = item.fungible_resources?.items ?? [];
    let tokenA = '';
    let tokenB = '';
    let xrdBalance = 0;

    for (const r of resources) {
      const total = (r.vaults?.items ?? []).reduce(
        (s, v) => s + parseFloat(v.amount ?? '0'),
        0,
      );
      if (total > 0) {
        if (!tokenA) tokenA = r.resource_address;
        else if (!tokenB) tokenB = r.resource_address;
        if (r.resource_address === XRD_RESOURCE) xrdBalance = total;
      }
    }

    const nameMeta = item.metadata?.items?.find((m) => m.key === 'name');
    const name = nameMeta?.value?.typed?.value ?? `DefiPlaza-${item.address.slice(-8)}`;

    const tvl = xrdBalance > 0 && xrdUsd > 0 ? (xrdBalance * 2 * xrdUsd).toFixed(2) : '0';

    pools.push({
      address: item.address,
      name,
      tokenA,
      tokenB,
      tvl,
      apy: 0,
      protocol: 'defiplaza',
      audited: true,
      apySource: 'unknown',
    });
  }

  return pools;
}

async function scanViaFallback(gateway: GatewayClient): Promise<PoolInfo[]> {
  const resp = await resilientFetch(`${DEFIPLAZA_STATS_URL}/api/pairs`);
  if (!resp.ok) throw new Error(`DefiPlaza stats API returned ${resp.status}`);

  const data = (await resp.json()) as Array<{
    address?: string;
    name?: string;
    tvl?: string | number;
    apy?: string | number;
    tokenA?: string;
    tokenB?: string;
  }>;

  if (!Array.isArray(data)) return [];

  const xrdUsd = await getXrdUsdPrice();

  return data.map((pair) => ({
    address: pair.address ?? '',
    name: pair.name ?? 'DefiPlaza Pool',
    tokenA: pair.tokenA ?? '',
    tokenB: pair.tokenB ?? '',
    tvl: String(pair.tvl ?? '0'),
    apy: typeof pair.apy === 'number' ? pair.apy : parseFloat(String(pair.apy ?? '0')),
    protocol: 'defiplaza' as const,
    audited: true,
    apySource: 'estimated' as const,
  }));
}
