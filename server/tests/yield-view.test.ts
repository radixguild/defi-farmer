import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import {
  buildYieldView,
  readHistory,
  refreshYieldView,
  getYieldView,
  resetYieldViewForTests,
  writeDailySnapshot,
  utcDay,
  WATCHLIST,
  XRD_RESOURCE,
  ASTROLESCENT_PRICES_URL,
  OCISWAP_POOLS_URL,
  DEFILLAMA_XRD_URL,
  DEFILLAMA_CHAINS_URL,
  type AstrolescentPrices,
  type OciswapPool,
  type Watchlist,
  type YieldInputs,
} from '../src/services/yield-view';
import type { DefiPlazaSideRow } from '../src/services/defiplaza';
import { getSourceHealth, resetSourceHealthForTests } from '../src/services/source-health';

const DCKS = 'resource_rdx1t42hpqvsk4t42l6aw09hwphd2axvetp6gvas9ztue0p30f4hzdwxrp';
const HUSDC = 'resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv';
const XUSDC = 'resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf';
const DFP2 = 'resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq';
const ASTRL = 'resource_rdx1t4tjx4g3qzd98nayqxm7qdpj0a0u8ns6a0jrchq49dyfevgh6u0gj3';
const WOWO = 'resource_rdx1t4kc5ljyrwlxvg54s6gnctt7nwwgx89h9r2gvrpm369s23yhzyyzlx';
const BONK = 'resource_rdx1t5bonkbogusfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxx803ny44t6z';

/// Values copied from Astrolescent /prices on 2026-11-19 (BONK's are real; its address is a fixture).
const ASTROLESCENT: AstrolescentPrices = {
  [XRD_RESOURCE]: { symbol: 'XRD', tokenPriceXRD: 1, aggregateTVL: 59087.7, aggregateVolume7D: 39685380 },
  [DCKS]: { symbol: 'DCKS', tokenPriceXRD: 0.9689, aggregateTVL: 15333.17, aggregateVolume7D: 12767200.7 },
  [HUSDC]: { symbol: 'hUSDC', tokenPriceXRD: 946.39, aggregateTVL: 4627.86, aggregateVolume7D: 11614630.05 },
  [XUSDC]: { symbol: 'xUSDC', tokenPriceXRD: 1585.837, aggregateTVL: 13835.3, aggregateVolume7D: 2083114 },
  [DFP2]: { symbol: 'DFP2', tokenPriceXRD: 1.203111, aggregateTVL: 4561.8, aggregateVolume7D: 1985877 },
  [ASTRL]: { symbol: 'ASTRL', tokenPriceXRD: 4.978318, aggregateTVL: 23138.4, aggregateVolume7D: 972613 },
  [WOWO]: { symbol: 'WOWO', tokenPriceXRD: 0.0393, aggregateTVL: 6727.14, aggregateVolume7D: 690222.6 },
  [BONK]: { symbol: 'BONK', tokenPriceXRD: 1.3240752466897274e16, aggregateTVL: 9593297416130.2, aggregateVolume7D: 0 },
};

function oci(
  address: string, x: string, y: string, type: string, fee: string, apr7d: string,
  tvlXrd: string, vol7dXrd: string, fees7dXrd: string, xPx: string, yPx: string,
): OciswapPool {
  return {
    address, pool_type: type, fee_rate: fee, apr: { '7d': apr7d },
    total_value_locked: { xrd: { now: tvlXrd } }, volume: { xrd: { '7d': vol7dXrd } }, fee: { xrd: { '7d': fees7dXrd } },
    x: { token: { address: x }, price: { xrd: { now: xPx } } },
    y: { token: { address: y }, price: { xrd: { now: yPx } } },
  };
}

/// Ociswap /pools rows from 2026-11-19 (trimmed to the fields read), plus a BONK fixture pool.
const POOLS: OciswapPool[] = [
  oci('component_rdx1cpwwhuxpe2npedx0axkj4nae8uv5222r0syjtu5fxuaxaj78rf30v9', DCKS, XRD_RESOURCE, 'precision', '0.01', '0.4091220290', '13565015.91048', '11739849.07127', '106725.9006479', '0.9783302257', '1'),
  oci('component_rdx1cpj25l4f8v2n4xl2auhwsagwmt5mmxsavxttmkpl90cr2qnyejqcmt', DFP2, XRD_RESOURCE, 'basic', '0.01', '0.2190318686', '3215046.845625', '1340684.117486', '13542.26381299', '1.1939747138', '1'),
  oci('component_rdx1cpqg9y55tv8652k32cznhmu8rz3jgtw57vdg460ld2sy650zpfh5fr', XRD_RESOURCE, HUSDC, 'basic', '0.03', '2.7067696117', '1372187.676353', '2309467.965946', '71426.84430763', '1', '979.57435004'),
  oci('component_rdx1czy2naejcqx8gv46zdsex2syuxrs4jnqzug58e66zr8wglxzvu97qr', XRD_RESOURCE, HUSDC, 'precision', '0.0005', '0.0806846715', '1332158.064962', '4589749.875839', '2067.014153231', '1', '979.57435004'),
  oci('component_rdx1bonkfixture', BONK, XRD_RESOURCE, 'basic', '0.01', '50', '99999999', '0', '0', '1.3240752466897274e16', '1'),
];

function side(
  pool: string, s: 'base' | 'quote', token: string, paired: string, alrPct: number | null, reserve: number, outlier = false,
): DefiPlazaSideRow {
  return {
    pairAddress: `component_${pool}`, side: s, poolAddress: `pool_${pool}_${s}`, token, pairedToken: paired,
    tokenSymbol: null, pairedSymbol: null, alrPct, sideReserve: reserve, pairTvlUsd: 10_000, outlier,
  };
}

const DEFIPLAZA: DefiPlazaSideRow[] = [
  side('xrd_dfp2', 'base', XRD_RESOURCE, DFP2, 16.68, 7415135.25),
  side('xrd_dfp2', 'quote', DFP2, XRD_RESOURCE, 9.55, 5912052.64),
  side('astrl_dfp2', 'base', ASTRL, DFP2, -1.34, 3013765.0),
  side('astrl_dfp2', 'quote', DFP2, ASTRL, 7.05, 3799154.9),
  side('husdc_xrd', 'base', HUSDC, XRD_RESOURCE, 676.3, 872, true),
];

function inputs(over: Partial<YieldInputs> = {}): YieldInputs {
  return {
    astrolescent: ASTROLESCENT,
    ociswapPools: POOLS,
    defiplaza: DEFIPLAZA,
    stakingApyPct: 6.62,
    xrdUsd: 0.0010034,
    chainTvlUsd: 274967.18,
    minDepthUsd: 1000,
    now: Date.parse('2026-11-19T06:00:00Z'),
    ...over,
  };
}

const WITH_BONK: Watchlist = {
  ...WATCHLIST,
  assets: [...WATCHLIST.assets, { resource: BONK, symbol: 'BONK', tags: ['meme'] }],
};

describe('buildYieldView', () => {
  test('returns are split into three typed sections, never one ranked list', () => {
    const v = buildYieldView(inputs());
    expect(v.sections.staking.every((r) => r.returnType === 'staking_apy')).toBe(true);
    expect(v.sections.feeApr.every((r) => r.returnType === 'fee_apr')).toBe(true);
    expect(v.sections.alr.every((r) => r.returnType === 'alr')).toBe(true);
    expect(v.sections.staking[0].returnPct).toBeCloseTo(6.62);
    expect(v.sections.feeApr[0].returnNote).toMatch(/impermanent loss is NOT included/);
    expect(v.sections.alr[0].returnNote).toMatch(/including impermanent loss/);
  });

  test('each section is sorted by exit depth in XRD, not by return', () => {
    const v = buildYieldView(inputs());
    const depths = v.sections.feeApr.map((r) => r.depthXrd!);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
    // The 271% hUSDC pool is NOT first, despite the biggest return.
    expect(v.sections.feeApr[0].label).toMatch(/^DCKS\/XRD/);
  });

  test('the hUSDC/XRD 3% pool (~271% fee APR) carries the bridge flag', () => {
    const v = buildYieldView(inputs());
    const row = v.sections.feeApr.find((r) => r.pool === 'component_rdx1cpqg9y55tv8652k32cznhmu8rz3jgtw57vdg460ld2sy650zpfh5fr')!;
    expect(row.returnPct).toBeCloseTo(270.68, 1);
    expect(row.label).toBe('XRD/hUSDC · basic 3%');
    expect(row.flags).toContain('bridge');
    expect(row.depthXrd).toBeCloseTo(1372187.68, 1);
    expect(row.fees7dXrd).toBeCloseTo(71426.84, 1);
  });

  test('BONK-style junk is filtered by the liquidity floor even when watchlisted', () => {
    const v = buildYieldView(inputs(), WITH_BONK);
    const bonk = v.assets.find((a) => a.symbol === 'BONK')!;
    expect(bonk.flags).toContain('below_floor');
    expect(v.excluded.belowFloorAssets).toEqual(['BONK']);
    const all = [...v.sections.feeApr, ...v.sections.alr];
    expect(all.some((r) => r.label.includes('BONK'))).toBe(false);
  });

  test('rule 1: Astrolescent price, Ociswap cross-check, flagged beyond 5%, never averaged', () => {
    const v = buildYieldView(inputs());
    const husdc = v.assets.find((a) => a.symbol === 'hUSDC')!;
    expect(husdc.priceXrd).toBe(946.39);
    expect(husdc.priceXrdOciswap).toBeCloseTo(979.57, 2);
    expect(husdc.divergencePct).toBeCloseTo(3.51, 1);
    expect(husdc.flags).not.toContain('price_disagree');

    const skewed = { ...ASTROLESCENT, [DFP2]: { ...ASTROLESCENT[DFP2], tokenPriceXRD: 1.0 } };
    const dfp2 = buildYieldView(inputs({ astrolescent: skewed })).assets.find((a) => a.symbol === 'DFP2')!;
    expect(dfp2.priceXrd).toBe(1.0);
    expect(dfp2.priceXrdOciswap).toBeCloseTo(1.194, 3);
    expect(dfp2.flags).toContain('price_disagree');
  });

  test('rule 3 + off-peg: USD comes only from XRD/USD; stables away from $1 are flagged', () => {
    const v = buildYieldView(inputs());
    const xusdc = v.assets.find((a) => a.symbol === 'xUSDC')!;
    expect(xusdc.priceUsd).toBeCloseTo(1585.837 * 0.0010034, 6);
    expect(xusdc.flags).toEqual(expect.arrayContaining(['bridge', 'off_peg']));
    expect(xusdc.bridgeRoute).toBe('Instabridge');
    const husdc = v.assets.find((a) => a.symbol === 'hUSDC')!;
    expect(husdc.priceUsd).toBeCloseTo(0.9496, 3);
    expect(husdc.flags).toContain('off_peg'); // 5.04% below $1
    expect(v.banner.chainTvlXrd).toBeCloseTo(274967.18 / 0.0010034, 0);
  });

  test('a missing XRD/USD price leaves USD unavailable, never 0', () => {
    const v = buildYieldView(inputs({ xrdUsd: null }));
    expect(v.banner.xrdUsd).toBeNull();
    expect(v.banner.chainTvlXrd).toBeNull();
    expect(v.assets.every((a) => a.priceUsd === null)).toBe(true);
  });

  test('DefiPlaza depth is side reserve x rule-1 price, and unavailable when the price is', () => {
    const v = buildYieldView(inputs());
    const astrlSide = v.sections.alr.find((r) => r.pool === 'pool_astrl_dfp2_base')!;
    expect(astrlSide.depthXrd).toBeCloseTo(3013765.0 * 4.978318, 0);
    expect(astrlSide.returnPct).toBeCloseTo(-1.34);
    expect(astrlSide.volume7dXrd).toBeNull(); // not reported by DefiPlaza
    expect(astrlSide.label).toBe('ASTRL side of ASTRL/DFP2');

    const noAstrl = { ...ASTROLESCENT, [ASTRL]: { ...ASTROLESCENT[ASTRL], tokenPriceXRD: null } };
    const v2 = buildYieldView(inputs({ astrolescent: noAstrl }));
    expect(v2.sections.alr.find((r) => r.pool === 'pool_astrl_dfp2_base')!.depthXrd).toBeNull();
  });

  test('pool depth floor (MIN_POOL_TVL_USD in XRD) drops dust rows and counts them', () => {
    const v = buildYieldView(inputs());
    // 872 hUSDC x 946 XRD = ~825k XRD, below the 1000 USD floor (~997k XRD at this price).
    expect(v.sections.alr.find((r) => r.pool === 'pool_husdc_xrd_base')).toBeUndefined();
    expect(v.excluded.rowsBelowDepthFloor).toBe(1);
    expect(v.excluded.rowsDepthUnknown).toBe(0);
    expect(v.excluded.depthFloorXrd).toBeCloseTo(1000 / 0.0010034, 0);
  });

  test('an unknown depth is shown as unavailable and counted, never dropped as dust', () => {
    const noTvl = { ...POOLS[1], address: 'component_rdx1notvl', total_value_locked: {} };
    const v = buildYieldView(inputs({ ociswapPools: [...POOLS, noTvl] }));
    const row = v.sections.feeApr.find((r) => r.pool === 'component_rdx1notvl')!;
    expect(row.depthXrd).toBeNull();
    expect(v.sections.feeApr[v.sections.feeApr.length - 1].pool).toBe('component_rdx1notvl'); // sorted last
    expect(v.excluded.rowsDepthUnknown).toBe(1);
    expect(v.excluded.rowsBelowDepthFloor).toBe(1);
  });

  test('without Astrolescent, rows still show and prices are unavailable (floor unknown, not applied)', () => {
    const v = buildYieldView(inputs({ astrolescent: null }));
    expect(v.assets.find((a) => a.symbol === 'DFP2')!.priceXrd).toBeNull();
    expect(v.sections.feeApr.length).toBeGreaterThan(0);
  });

  test('kickers are listed separately and marked unverified with a source', () => {
    const v = buildYieldView(inputs());
    expect(v.kickers.length).toBe(2);
    for (const k of v.kickers) {
      expect(k.status).toBe('unverified');
      expect(k.source).toMatch(/^https:\/\//);
    }
  });

  test('7d change reads the snapshot history', () => {
    const v = buildYieldView(
      inputs({
        history: (kind, key) =>
          kind === 'price_xrd' && key === DFP2 ? 1.0 : kind === 'return_pct' && key === 'radix:native_xrd_staking' ? 6.0 : null,
      }),
    );
    expect(v.assets.find((a) => a.symbol === 'DFP2')!.priceChange7dPct).toBeCloseTo(20.31, 1);
    expect(v.sections.staking[0].returnChange7dPp).toBeCloseTo(0.62, 2);
    expect(v.assets.find((a) => a.symbol === 'ASTRL')!.priceChange7dPct).toBeNull();
  });

  test('the watchlist is keyed by resource address and has no duplicates', () => {
    const res = WATCHLIST.assets.map((a) => a.resource);
    expect(new Set(res).size).toBe(res.length);
    for (const r of res) expect(r).toMatch(/^resource_rdx1[0-9a-z]+$/);
    expect(res).toContain(XRD_RESOURCE);
  });
});

describe('daily snapshot + refresh', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    setTestDb(db);
    resetYieldViewForTests();
    resetSourceHealthForTests();
  });
  afterAll(() => setTestDb(null));

  test('one row per UTC day; a 7-day-old row drives the change', () => {
    const now = Date.parse('2026-11-19T06:00:00Z');
    const weekAgo = now - 7 * 86_400_000;
    writeDailySnapshot(buildYieldView(inputs({ now: weekAgo, astrolescent: { ...ASTROLESCENT, [DFP2]: { ...ASTROLESCENT[DFP2], tokenPriceXRD: 1.0 } } })), weekAgo);
    writeDailySnapshot(buildYieldView(inputs({ now: weekAgo + 3_600_000 })), weekAgo + 3_600_000); // same day: ignored
    const hist = readHistory(now);
    expect(hist('price_xrd', DFP2)).toBe(1.0);
    expect(utcDay(weekAgo)).toBe('2026-11-12');
    const v = buildYieldView(inputs({ now, history: hist }));
    expect(v.assets.find((a) => a.symbol === 'DFP2')!.priceChange7dPct).toBeCloseTo(20.31, 1);
  });

  test('refreshYieldView fetches the four sources, records their health and serves the view', async () => {
    const bodies: Record<string, unknown> = {
      [ASTROLESCENT_PRICES_URL]: ASTROLESCENT,
      [OCISWAP_POOLS_URL]: { data: POOLS },
      [DEFILLAMA_XRD_URL]: { coins: { 'coingecko:radix': { price: 0.0010034 } } },
      [DEFILLAMA_CHAINS_URL]: [{ name: 'Radix', tvl: 274967.18 }],
    };
    const calls: string[] = [];
    await refreshYieldView({
      stakingApyPct: 6.62,
      minDepthUsd: 1000,
      now: 1_000_000,
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify(bodies[url]), { status: 200 });
      },
    });
    expect(calls.sort()).toEqual(Object.keys(bodies).sort());
    const h = getSourceHealth();
    for (const k of ['astrolescent', 'ociswap-pools', 'defillama-xrd', 'defillama-chains']) expect(h[k].ok).toBe(true);
    const v = getYieldView();
    expect(v.generatedAt).toBe(1_000_000);
    expect(v.sections.feeApr.length).toBeGreaterThan(0);
  });

  test('a dead source shows in health and its values are unavailable, not 0', async () => {
    await refreshYieldView({
      stakingApyPct: null,
      minDepthUsd: 1000,
      now: 2_000_000,
      force: true,
      fetch: async (url) =>
        url === DEFILLAMA_XRD_URL
          ? new Response('bad gateway', { status: 502 })
          : new Response(JSON.stringify(url === OCISWAP_POOLS_URL ? { data: POOLS } : url === DEFILLAMA_CHAINS_URL ? [{ name: 'Radix', tvl: 1 }] : ASTROLESCENT), { status: 200 }),
    });
    expect(getSourceHealth()['defillama-xrd']).toMatchObject({ ok: false, lastErrorKind: 'http_status' });
    expect(getYieldView().banner.xrdUsd).toBeNull();
  });
});
