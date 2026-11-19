import { describe, test, expect, beforeEach } from 'bun:test';
import {
  mapDefiPlazaPairs,
  fetchDefiPlazaPairs,
  refreshDefiPlaza,
  getDefiPlazaView,
  resetDefiPlazaForTests,
  DEFIPLAZA_PAIRS_URL,
  DEFIPLAZA_SOURCE,
} from '../src/services/defiplaza';
import { getSourceHealth, resetSourceHealthForTests } from '../src/services/source-health';

const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const DFP2 = 'resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq';
const ASTRL = 'resource_rdx1t4tjx4g3qzd98nayqxm7qdpj0a0u8ns6a0jrchq49dyfevgh6u0gj3';
const DUST = 'resource_rdx1t42n9kvf9psenuxe55md57p3n70dscpkraf4mnwtwrfplnfcar20az';

/// Three pairs copied from the live API on 2026-11-19 (radix.defiplaza.net/api/pairs).
const LIVE_BODY = {
  message: 'The deXaddress field now contains the router component',
  data: [
    {
      address: 'component_rdx1cppd8rq7gfwad75z56mz9tldqmw4aps48hqnx2stf4eeew8v6tyd72',
      dexAddress: 'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68',
      baseToken: XRD,
      quoteToken: DFP2,
      basePool: 'pool_rdx1chxn0nqj840r78t2ah5agchq4ue9p65q23nc9ckqfe0mmjstq8fyg0',
      quotePool: 'pool_rdx1c4547fnprjhlp2m27aycmf8rzrkrfzcck58jt2706r85gpcaeapz7k',
      baseAPY: 0.16680006739320352,
      quoteAPY: 0.09548119777699826,
      baseTVL: 7415135.246704241,
      quoteTVL: 5912052.64444732,
      tvlUSD: 14680.867880624826,
      volume: 0,
      createdAt: '2023-11-24T13:04:20.078Z',
    },
    {
      address: 'component_rdx1cqvxkaazmpnvg3f9ufc5n2msv6x7ztjdusdm06lhtf5n7wr8guggg5',
      dexAddress: 'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68',
      baseToken: ASTRL,
      quoteToken: DFP2,
      basePool: 'pool_rdx1c47jlmd9stptfy2a7e39wnjfechu72q9ggus29x0mqf98m8xt70rx2',
      quotePool: 'pool_rdx1c4xm5wfm92vh39dzszzv3huvdmvz73juhkw8vls0z4fg2vfr0wkv93',
      baseAPY: -0.013432053731995852,
      quoteAPY: 0.07052199736150744,
      baseTVL: 3013765.0059583234,
      quoteTVL: 3799154.9006100763,
      tvlUSD: 19760.73331887739,
      volume: 0,
      createdAt: '2023-11-24T13:49:22.699Z',
    },
    {
      address: 'component_rdx1czv0sx44tz2gxczt22rwjd0wnz97p3e8krzep9lh6fs37zh0xhml55',
      dexAddress: 'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68',
      baseToken: DUST,
      quoteToken: DFP2,
      basePool: 'pool_rdx1ckzrjvhxjd8jrt9u7u87tu5w3kuzc65dmemqjxs653dz7jcv02zl7c',
      quotePool: 'pool_rdx1chmza7st8tch6xa4u2d3hm8u7h9a8gd84af5rqf9p3eeyh9dxrnj2g',
      baseAPY: null,
      quoteAPY: 0.000520288326103735,
      baseTVL: 10724139155.125727,
      quoteTVL: 506.9098454648073,
      tvlUSD: 2.824248881557308,
      volume: 0,
      createdAt: '2024-01-06T13:04:06.654Z',
    },
  ],
};

function okFetch(body: unknown) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn, calls };
}

beforeEach(() => {
  resetDefiPlazaForTests();
  resetSourceHealthForTests();
});

describe('mapDefiPlazaPairs', () => {
  test('maps each pair to a base row and a quote row with ALR in percent', () => {
    const rows = mapDefiPlazaPairs(LIVE_BODY);
    expect(rows.length).toBe(6);
    const [base, quote] = rows;
    expect(base.side).toBe('base');
    expect(base.token).toBe(XRD);
    expect(base.pairedToken).toBe(DFP2);
    expect(base.poolAddress).toBe('pool_rdx1chxn0nqj840r78t2ah5agchq4ue9p65q23nc9ckqfe0mmjstq8fyg0');
    expect(base.alrPct).toBeCloseTo(16.68, 2);
    expect(base.sideReserve).toBeCloseTo(7415135.25, 1);
    expect(quote.side).toBe('quote');
    expect(quote.token).toBe(DFP2);
    expect(quote.pairedToken).toBe(XRD);
    expect(quote.alrPct).toBeCloseTo(9.55, 2);
    // Both sides carry the pair's TVL unchanged (no per-side USD is reported).
    expect(base.pairTvlUsd).toBe(quote.pairTvlUsd);
  });

  test('negative ALR is kept as negative (it is IL-inclusive)', () => {
    const rows = mapDefiPlazaPairs(LIVE_BODY);
    const astrlBase = rows.find((r) => r.token === ASTRL && r.side === 'base')!;
    expect(astrlBase.alrPct).toBeCloseTo(-1.34, 2);
  });

  test('a null ALR stays null, never 0', () => {
    const rows = mapDefiPlazaPairs(LIVE_BODY);
    const dustBase = rows.find((r) => r.token === DUST && r.side === 'base')!;
    expect(dustBase.alrPct).toBeNull();
  });

  test('flags |ALR| >= 100% as an outlier', () => {
    const body = { data: [{ ...LIVE_BODY.data[0], baseAPY: 6.76, quoteAPY: -0.6 }] };
    const [base, quote] = mapDefiPlazaPairs(body);
    expect(base.outlier).toBe(true);
    expect(quote.outlier).toBe(false);
  });

  test('ignores the volume field entirely', () => {
    const rows = mapDefiPlazaPairs(LIVE_BODY);
    for (const r of rows) expect(Object.keys(r)).not.toContain('volume');
  });

  test('a body without data[] is a bad_response, not an empty success', () => {
    expect(() => mapDefiPlazaPairs([])).toThrow(/no data\[\]/);
    expect(() => mapDefiPlazaPairs({ pairs: [] })).toThrow(/no data\[\]/);
  });

  test('skips a pair with no address and a side with no pool', () => {
    const body = {
      data: [
        { ...LIVE_BODY.data[0], address: undefined },
        { ...LIVE_BODY.data[1], quotePool: undefined },
      ],
    };
    const rows = mapDefiPlazaPairs(body);
    expect(rows.length).toBe(1);
    expect(rows[0].side).toBe('base');
  });
});

describe('fetchDefiPlazaPairs', () => {
  test('calls the radix.defiplaza.net pairs endpoint, not the dead stats host', async () => {
    const { fn, calls } = okFetch(LIVE_BODY);
    await fetchDefiPlazaPairs(fn);
    expect(calls).toEqual([DEFIPLAZA_PAIRS_URL]);
    expect(DEFIPLAZA_PAIRS_URL).toBe('https://radix.defiplaza.net/api/pairs');
  });

  test('a 404 throws http_status', async () => {
    const fn = async () => new Response('not found', { status: 404 });
    const err = await fetchDefiPlazaPairs(fn).catch((e) => e);
    expect(err).toMatchObject({ kind: 'http_status' });
  });

  test('zero pairs throws empty', async () => {
    const { fn } = okFetch({ data: [] });
    const err = await fetchDefiPlazaPairs(fn).catch((e) => e);
    expect(err).toMatchObject({ kind: 'empty' });
  });
});

describe('refreshDefiPlaza + getDefiPlazaView', () => {
  test('a good refresh records health ok and serves rows sorted by pair TVL', async () => {
    const { fn } = okFetch(LIVE_BODY);
    await refreshDefiPlaza({
      fetch: fn,
      now: 1000,
      symbols: async () => new Map([[XRD, 'XRD'], [DFP2, 'DFP2'], [ASTRL, 'ASTRL']]),
    });
    const h = getSourceHealth()[DEFIPLAZA_SOURCE];
    expect(h.ok).toBe(true);
    expect(h.lastSuccessAt).toBe(1000);
    expect(h.lastRows).toBe(6);

    const view = getDefiPlazaView(1000);
    expect(view.returnType).toBe('ALR');
    expect(view.returnNote).toMatch(/not a fee APR/);
    expect(view.fetchedAt).toBe(1000);
    // Dust pair ($2.8 TVL) is below the floor; its null-ALR side counts as no-return.
    expect(view.excludedNoReturn).toBe(1);
    expect(view.excludedBelowFloor).toBe(1);
    expect(view.rows.length).toBe(4);
    // Largest pair first (ASTRL/DFP2 $19.8k), base side before quote.
    expect(view.rows[0].token).toBe(ASTRL);
    expect(view.rows[0].side).toBe('base');
    expect(view.rows[0].tokenSymbol).toBe('ASTRL');
    expect(view.rows[2].token).toBe(XRD);
  });

  test('a dead source shows in health and keeps the last good rows with their timestamp', async () => {
    const { fn } = okFetch(LIVE_BODY);
    await refreshDefiPlaza({ fetch: fn, now: 1000 });
    await refreshDefiPlaza({
      fetch: async () => new Response('gone', { status: 404 }),
      now: 2000,
      force: true,
    });
    const h = getSourceHealth()[DEFIPLAZA_SOURCE];
    expect(h.ok).toBe(false);
    expect(h.lastErrorKind).toBe('http_status');
    expect(h.lastErrorAt).toBe(2000);
    expect(h.lastSuccessAt).toBe(1000);
    expect(getDefiPlazaView(1000).fetchedAt).toBe(1000);
  });

  test('throttles to one fetch per 5 minutes unless forced', async () => {
    const { fn, calls } = okFetch(LIVE_BODY);
    await refreshDefiPlaza({ fetch: fn, now: 10_000 });
    await refreshDefiPlaza({ fetch: fn, now: 10_000 + 60_000 });
    expect(calls.length).toBe(1);
    await refreshDefiPlaza({ fetch: fn, now: 10_000 + 5 * 60_000 });
    expect(calls.length).toBe(2);
  });

  test('before any refresh the view is empty, not an error', () => {
    const view = getDefiPlazaView(1000);
    expect(view.rows).toEqual([]);
    expect(view.fetchedAt).toBeNull();
  });
});
