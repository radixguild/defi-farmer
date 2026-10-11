import { describe, test, expect } from 'bun:test';
import { enrichPools, DEFAULT_RISK, type EnrichDeps } from '../src/services/pool-enricher';
import type { GatewayClient, PoolInfo } from '../src/services/gateway';
import type { PairRisk } from '../src/services/price-feed';

const gw = {} as GatewayClient; // deps injected — the gateway is never touched

const POOL_A = 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';
const POOL_B = 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const XUSDC = 'resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf';

function scanned(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    address: POOL_A,
    name: 'XRD-xWBTC', // registry label — WRONG on purpose
    tokenA: 'XRD',
    tokenB: 'xWBTC',
    tvl: '0',
    apy: 10,
    protocol: 'caviarnine', // registry label — WRONG on purpose
    audited: true,
    apySource: 'estimated',
    ...overrides,
  };
}

const PAIR_RISK: PairRisk = {
  dailyVolA: 0.04,
  dailyVolB: 0.002,
  correlation: 0.1,
  relAnnualVol: 0.77,
  estimatedIlPct: -7.4,
  samples: 29,
};

function deps(overrides: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    resolve: async () => ({
      protocol: 'ociswap' as const,
      kind: 'ociswap_precision' as const,
      tokenX: XRD,
      tokenY: XUSDC,
    }),
    pairRisk: async () => PAIR_RISK,
    symbols: async () => new Map([[XRD, 'XRD'], [XUSDC, 'xUSDC']]),
    tvls: async () => new Map([[POOL_A, 123456.789]]),
    ...overrides,
  };
}

describe('enrichPools', () => {
  test('replaces registry labels with runtime-resolved identity', async () => {
    const [p] = await enrichPools(gw, [scanned()], deps());
    expect(p.protocol).toBe('ociswap'); // registry said caviarnine
    expect(p.kind).toBe('ociswap_precision');
    expect(p.tokenA).toBe(XRD);
    expect(p.tokenB).toBe(XUSDC);
    expect(p.name).toBe('XRD-xUSDC'); // rebuilt from on-ledger symbols
    expect(p.tvl).toBe('123456.79'); // filled from vault balances
    expect(p.risk).toEqual({
      volatility: (PAIR_RISK.dailyVolA + PAIR_RISK.dailyVolB) / 2,
      correlation: PAIR_RISK.correlation,
      relAnnualVol: PAIR_RISK.relAnnualVol,
      // recomputed via the #4 dispatch (−σ_rel²/8), not copied from the feed
      estimatedIlPct: -((PAIR_RISK.relAnnualVol ** 2) / 8) * 100,
      source: 'live',
    });
  });

  test('an unresolvable pool keeps its scanned labels and gets the default risk', async () => {
    const [p] = await enrichPools(
      gw,
      [scanned({ tvl: '5000' })],
      deps({
        resolve: async () => {
          throw new Error('gateway down');
        },
        pairRisk: async () => {
          throw new Error('must not be called for symbol tokens');
        },
      }),
    );
    expect(p.protocol).toBe('caviarnine');
    expect(p.kind).toBeUndefined();
    expect(p.tokenA).toBe('XRD'); // symbols, not resources → no pair-risk lookup
    expect(p.risk).toEqual(DEFAULT_RISK);
    expect(p.tvl).toBe('5000');
  });

  test('unsupported blueprints keep scanner labels but are tagged', async () => {
    const [p] = await enrichPools(
      gw,
      [scanned()],
      deps({
        resolve: async () => ({
          protocol: 'unknown' as const,
          kind: 'unsupported' as const,
          tokenX: '',
          tokenY: '',
        }),
      }),
    );
    expect(p.kind).toBe('unsupported');
    expect(p.protocol).toBe('caviarnine'); // untouched — display only
    expect(p.tvl).toBe('0'); // no TVL lookup for unsupported pools
  });

  test('dedupes the same pool listed by two scanners, preferring live APY data', async () => {
    const fromRegistry = scanned({ apy: 0, apySource: 'unknown' });
    const fromApi = scanned({ apy: 34.2, apySource: 'live', tvl: '99000', protocol: 'ociswap' });
    const out = await enrichPools(gw, [fromRegistry, fromApi], deps());
    expect(out).toHaveLength(1);
    expect(out[0].apy).toBe(34.2);
    expect(out[0].apySource).toBe('live');
  });

  test('pair risk falls back to the skeptical default when the feed has nothing', async () => {
    const [p] = await enrichPools(gw, [scanned()], deps({ pairRisk: async () => null }));
    expect(p.risk).toEqual(DEFAULT_RISK);
    expect(p.risk!.estimatedIlPct).toBe(-12.5);
  });

  test('TVL is only filled where the scanner reported none', async () => {
    const scannedWithTvl = scanned({ address: POOL_B, tvl: '777' });
    const out = await enrichPools(gw, [scanned(), scannedWithTvl], deps());
    const a = out.find((p) => p.address === POOL_A)!;
    const b = out.find((p) => p.address === POOL_B)!;
    expect(a.tvl).toBe('123456.79');
    expect(b.tvl).toBe('777'); // live scanner value stands
  });

  test('a failing enrichment step degrades, never throws', async () => {
    const out = await enrichPools(
      gw,
      [scanned({ tvl: '0' })],
      deps({
        symbols: async () => {
          throw new Error('metadata down');
        },
        tvls: async () => {
          throw new Error('vault read down');
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('XRD-xWBTC'); // scanned name stands
    expect(out[0].tvl).toBe('0');
    expect(out[0].risk?.source).toBe('live'); // risk still attached
  });
});
