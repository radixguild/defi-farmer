/// DF-1 / DF-7: a pool's kind comes from its (blueprint name, package) PAIR,
/// never the name alone, and the resolver cache keyed on caller-supplied
/// addresses stays bounded.
import { describe, test, expect, beforeEach } from 'bun:test';
import { buildAndPreview, poolInfo, DexBuildError } from '../src/services/dex/build-service';
import {
  resolvePool, _clearResolverCache, _resolverCacheSize, RESOLVER_CACHE_MAX,
  VERIFIED_POOL_PACKAGES, isPinnedPackage,
} from '../src/services/dex/pool-resolver';
import { parseDexPackagePins, DEX_PACKAGE_ENV } from '../src/config';
import type { GatewayClient, GwEntityItem } from '../src/services/gateway';

const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const XWBTC = 'resource_rdx1t580qxc7upat7lww4l2c4jckacafjeudxj5wpjrrct0p3e82sq4y75';
const ACCOUNT = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const POOL = 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr';
const PLAZA = 'component_rdx1cplazapairxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BASE_POOL = 'pool_rdx1cbasepoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const QUOTE_POOL = 'pool_rdx1cquotepoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BASE_LP = 'resource_rdx1tbaselpxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const QUOTE_LP = 'resource_rdx1tquotelpxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const STRANGER = 'resource_rdx1tstrangerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const VERIFIED_PRECISION_PKG = VERIFIED_POOL_PACKAGES.ociswap_precision[0];
const ATTACKER_PKG = 'package_rdx1attackerlookalikexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
/// Set by tests/setup.ts (test-only pin; no PlazaPair package is recorded).
const TEST_PLAZA_PKG = process.env.DEX_PACKAGES_DEFIPLAZA_PAIR as string;

function precisionItem(address: string, pkg: string, blueprint = 'PrecisionPool'): GwEntityItem {
  return {
    address,
    details: {
      blueprint_name: blueprint,
      package_address: pkg,
      state: {
        fields: [
          { field_name: 'active_tick', fields: [{ value: '173640' }] },
          { field_name: 'price_sqrt', value: '8310.022582033909680813481414597178625815' },
        ],
      },
    },
    metadata: {
      items: [
        { key: 'x_address', value: { typed: { value: XWBTC } } },
        { key: 'y_address', value: { typed: { value: XRD } } },
        { key: 'lp_address', value: { typed: { value: 'resource_rdx1nlpnftxxxxxxxxxxxxxxxxxxxxxxx' } } },
        { key: 'tick_spacing', value: { typed: { value: '60' } } },
      ],
    },
  } as unknown as GwEntityItem;
}

function plazaItem(pkg: string): GwEntityItem {
  return {
    address: PLAZA,
    details: {
      blueprint_name: 'PlazaPair',
      package_address: pkg,
      state: {
        fields: [
          { field_name: 'base_address', value: XWBTC },
          { field_name: 'quote_address', value: XRD },
          { field_name: 'base_pool', value: BASE_POOL },
          { field_name: 'quote_pool', value: QUOTE_POOL },
          { field_name: 'state', fields: [{ field_name: 'shortage', variant_name: 'Equilibrium' }] },
        ],
      },
    },
  } as unknown as GwEntityItem;
}

const nativePools: Record<string, GwEntityItem> = {
  [BASE_POOL]: { address: BASE_POOL, details: { state: { pool_unit_resource_address: BASE_LP } } } as GwEntityItem,
  [QUOTE_POOL]: { address: QUOTE_POOL, details: { state: { pool_unit_resource_address: QUOTE_LP } } } as GwEntityItem,
};

interface StubGw {
  calls: number;
  previews: number;
}

/// Minimal Gateway stub: entityDetailsGlobal answers from a per-address table;
/// preview always succeeds (the point is what reaches it, not its verdict).
function stubGw(items: Record<string, GwEntityItem>): GatewayClient & StubGw {
  const gw = {
    calls: 0,
    previews: 0,
    async entityDetailsGlobal(addresses: string[]) {
      gw.calls++;
      return { items: addresses.map((a) => items[a] ?? ({ address: a } as GwEntityItem)) };
    },
    async getCurrentEpoch() {
      return 334_599;
    },
    async previewTransaction() {
      gw.previews++;
      return { receipt: { status: 'Succeeded' }, resource_changes: [] };
    },
  };
  return gw as unknown as GatewayClient & StubGw;
}

beforeEach(() => _clearResolverCache());

describe('DF-1 — blueprint name alone is not an identity', () => {
  test('PrecisionPool on the doc-verified package resolves as ociswap_precision', async () => {
    const pool = await resolvePool(stubGw({ [POOL]: precisionItem(POOL, VERIFIED_PRECISION_PKG) }), POOL);
    expect(pool.kind).toBe('ociswap_precision');
    expect(pool.unsupportedReason).toBeUndefined();
  });

  test('a lookalike "PrecisionPool" on another package resolves as unsupported (unpinned_package)', async () => {
    const pool = await resolvePool(stubGw({ [POOL]: precisionItem(POOL, ATTACKER_PKG) }), POOL);
    expect(pool.kind).toBe('unsupported');
    expect(pool.unsupportedReason).toBe('unpinned_package');
    expect(pool.blueprintName).toBe('PrecisionPool');
    expect(pool.tokenX).toBe(''); // nothing from the lookalike's metadata is trusted
  });

  test('a missing package address never matches a pin', async () => {
    const pool = await resolvePool(stubGw({ [POOL]: precisionItem(POOL, '') }), POOL);
    expect(pool.kind).toBe('unsupported');
    expect(pool.unsupportedReason).toBe('unpinned_package');
  });

  test('an unknown blueprint keeps its own reason', async () => {
    const pool = await resolvePool(
      stubGw({ [POOL]: precisionItem(POOL, VERIFIED_PRECISION_PKG, 'FlexPool') }), POOL,
    );
    expect(pool.kind).toBe('unsupported');
    expect(pool.unsupportedReason).toBe('unknown_blueprint');
  });

  test('buildAndPreview refuses the lookalike with a DexBuildError, before any preview', async () => {
    const gw = stubGw({ [POOL]: precisionItem(POOL, ATTACKER_PKG) });
    const p = buildAndPreview(gw, {
      action: 'deposit', account: ACCOUNT, poolAddress: POOL,
      amountX: '0.001', amountY: '100', range: { below: 10, above: 10 },
    });
    await expect(p).rejects.toBeInstanceOf(DexBuildError);
    await expect(p).rejects.toThrow(
      /unsupported pool blueprint: PrecisionPool \(package not on the verified allowlist\)/,
    );
    expect(gw.previews).toBe(0);
  });

  test('the verified PrecisionPool still builds and previews (the pin does not block the real one)', async () => {
    const gw = stubGw({ [POOL]: precisionItem(POOL, VERIFIED_PRECISION_PKG) });
    const r = await buildAndPreview(gw, {
      action: 'deposit', account: ACCOUNT, poolAddress: POOL,
      amountX: '0.001', amountY: '100', range: { below: 10, above: 10 },
    });
    expect(r.pool.kind).toBe('ociswap_precision');
    expect(gw.previews).toBe(1);
  });

  test('poolInfo reports the lookalike as unsupported (the UI shows it, the builder refuses)', async () => {
    const info = await poolInfo(stubGw({ [POOL]: precisionItem(POOL, ATTACKER_PKG) }), POOL);
    expect(info.kind).toBe('unsupported');
  });

  test('pins are per kind; kinds with no recorded package are unpinned by default', () => {
    expect(VERIFIED_POOL_PACKAGES.ociswap_basic).toEqual([]);
    expect(isPinnedPackage('ociswap_basic', ATTACKER_PKG)).toBe(false);
    expect(isPinnedPackage('ociswap_precision', VERIFIED_PRECISION_PKG)).toBe(true);
    // the Precision package does not vouch for a QuantaSwap
    expect(isPinnedPackage('caviarnine_quantaswap', VERIFIED_PRECISION_PKG)).toBe(false);
    expect(isPinnedPackage('defiplaza_pair', TEST_PLAZA_PKG)).toBe(true); // env extension
  });
});

describe('DF-1 — DefiPlaza tokens must belong to the resolved pair', () => {
  const items = () => ({ [PLAZA]: plazaItem(TEST_PLAZA_PKG), ...nativePools });

  test('a foreign inputToken is a DexBuildError (400), never a manifest', async () => {
    const gw = stubGw(items());
    const p = buildAndPreview(gw, {
      action: 'deposit', account: ACCOUNT, poolAddress: PLAZA, inputToken: STRANGER, inputAmount: '1',
    });
    await expect(p).rejects.toBeInstanceOf(DexBuildError);
    await expect(p).rejects.toThrow(/inputToken is not this pair's base or quote token/);
    expect(gw.previews).toBe(0);
  });

  test('a pair token as inputToken builds and previews', async () => {
    const r = await buildAndPreview(stubGw(items()), {
      action: 'deposit', account: ACCOUNT, poolAddress: PLAZA, inputToken: XRD, inputAmount: '1',
    });
    expect(r.pool.kind).toBe('defiplaza_pair');
    expect(r.preview.ok).toBe(true);
  });

  test('a foreign lpToken on withdraw is a 400; the pair LP builds', async () => {
    const bad = buildAndPreview(stubGw(items()), {
      action: 'withdraw', account: ACCOUNT, poolAddress: PLAZA, lpToken: STRANGER, lpAmount: '1',
    });
    await expect(bad).rejects.toBeInstanceOf(DexBuildError);
    await expect(bad).rejects.toThrow(/lpToken is not this pair's base or quote LP/);
    const ok = await buildAndPreview(stubGw(items()), {
      action: 'withdraw', account: ACCOUNT, poolAddress: PLAZA, lpToken: QUOTE_LP, lpAmount: '1',
    });
    expect(ok.manifest).toContain(QUOTE_LP);
  });

  test('the same PlazaPair on an unpinned package is refused', async () => {
    const p = buildAndPreview(stubGw({ [PLAZA]: plazaItem(ATTACKER_PKG), ...nativePools }), {
      action: 'deposit', account: ACCOUNT, poolAddress: PLAZA, inputToken: XRD, inputAmount: '1',
    });
    await expect(p).rejects.toThrow(/unsupported pool blueprint: PlazaPair/);
  });
});

describe('DF-1 — parseDexPackagePins', () => {
  test('unset → empty pins for every kind', () => {
    const pins = parseDexPackagePins({});
    for (const kind of Object.keys(DEX_PACKAGE_ENV) as (keyof typeof pins)[]) {
      expect(pins[kind]).toEqual([]);
    }
  });
  test('comma list, trimmed, per kind', () => {
    const a = 'package_rdx1aaaaaaaaaaaa';
    const b = 'package_rdx1bbbbbbbbbbbb';
    const pins = parseDexPackagePins({ DEX_PACKAGES_OCISWAP_BASIC: ` ${a}, ${b} ,` });
    expect(pins.ociswap_basic).toEqual([a, b]);
    expect(pins.ociswap_precision).toEqual([]);
  });
  test('a malformed entry throws by name instead of pinning nothing', () => {
    expect(() => parseDexPackagePins({ DEX_PACKAGES_DEFIPLAZA_PAIR: 'component_rdx1notapackage' }))
      .toThrow(/Invalid DEX_PACKAGES_DEFIPLAZA_PAIR/);
    expect(() => parseDexPackagePins({ DEX_PACKAGES_OCISWAP_BASIC: 'package_tdx_2_1abcdefgh' }))
      .toThrow(/Invalid DEX_PACKAGES_OCISWAP_BASIC/);
  });
});

describe('DF-7 — resolver cache is bounded', () => {
  test('distinct caller-supplied addresses never grow the cache past its cap', async () => {
    const gw = stubGw({});
    for (let i = 0; i < RESOLVER_CACHE_MAX + 50; i++) {
      await resolvePool(gw, `component_rdx1junk${i.toString().padStart(8, '0')}`);
    }
    expect(_resolverCacheSize()).toBe(RESOLVER_CACHE_MAX);
  });

  test('a recently used entry survives eviction (LRU), the oldest goes', async () => {
    const gw = stubGw({ [POOL]: precisionItem(POOL, VERIFIED_PRECISION_PKG) });
    await resolvePool(gw, POOL);
    for (let i = 0; i < RESOLVER_CACHE_MAX - 1; i++) {
      await resolvePool(gw, `component_rdx1fill${i.toString().padStart(8, '0')}`);
    }
    await resolvePool(gw, POOL); // hit → most recent
    const before = gw.calls;
    await resolvePool(gw, 'component_rdx1onemorexxxxxxx'); // evicts fill00000000, not POOL
    await resolvePool(gw, POOL);
    expect(gw.calls).toBe(before + 1); // only the new address cost a Gateway call
    await resolvePool(gw, 'component_rdx1fill00000000');
    expect(gw.calls).toBe(before + 2); // the evicted oldest had to be re-resolved
  });
});
