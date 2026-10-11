import { describe, test, expect } from 'bun:test';
import {
  ociTickToPrice, ociPriceToTick, ociTickFromPriceSqrt, ociTickRangeByPrice, ociTickRangeByWidth,
  cavBinToPrice, cavPriceToBin, cavBinRangeByPrice, cavBinRangeByWidth,
  distributeQuanta, netAfterFee, OCI_TICK_BASE, CAV_TICK_BASE,
} from '../src/services/dex/concentrated';
import { buildPrecisionDeposit, buildQuantaSwapDeposit, buildNftWithdraw } from '../src/services/dex/manifests';
import { sumDecimals } from '../src/services/dex/decimal';
import type { ResolvedPool } from '../src/services/dex/pool-resolver';

const ACCT = 'account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const XWBTC = 'resource_rdx1t580qxc7upat7lww4l2c4jckacafjeudxj5wpjrrct0p3e82sq4y75';
const XUSDT = 'resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw';
const TREASURY = 'component_rdx1cptreasuryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// Real mainnet pools (verified 2026-07-18, docs/DEX-INTEGRATION.md).
const precision: ResolvedPool = {
  address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
  protocol: 'ociswap', kind: 'ociswap_precision', blueprintName: 'PrecisionPool', packageAddress: 'package_rdx1x',
  concentrated: true, tokenX: XWBTC, tokenY: XRD,
  lp: { kind: 'nft', resource: 'resource_rdx1n2zsvvdahtnlm53ms5f6zazjx6rnnmu2u6xjdr8ggzw45way0tefe6' },
  tickSpacing: 60, activeTick: 173640, priceSqrt: '8310.022582033909680813481414597178625815',
};
const quanta: ResolvedPool = {
  address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
  protocol: 'caviarnine', kind: 'caviarnine_quantaswap', blueprintName: 'QuantaSwap', packageAddress: 'package_rdx1y',
  concentrated: true, tokenX: XRD, tokenY: XUSDT,
  lp: { kind: 'nft', resource: 'resource_rdx1nft63kjp38agw0z8nnwkyjhcgpzwjer84945h5z8yr663fgukjyp3l' },
  binSpan: 100, activeBin: 20400, lowerLimit: '0.028750135585789412', upperLimit: '0.030223808884146787',
};

describe('Ociswap tick math (price = 1.0001^tick, verified)', () => {
  test('base + round-trip', () => {
    expect(OCI_TICK_BASE).toBe(1.0001);
    expect(ociTickToPrice(0)).toBe(1);
    for (const t of [166708, 180572, -60, 100000]) {
      expect(ociPriceToTick(ociTickToPrice(t))).toBeCloseTo(t, 3);
    }
  });
  test('the real add ratio Y/X = 1.0001^activeTick (the base proof)', () => {
    // real add txid_rdx1eudksd…: 1488.553749962652686347 XRD / 0.00004286 xWBTC
    const ratio = 1488.553749962652686347 / 0.00004286;
    expect(ociTickToPrice(173640)).toBeCloseTo(ratio, -6); // ~3.473e7, within rounding of the deposit
  });
  test('price_sqrt gives the true current tick (independent of stale active_tick)', () => {
    // price_sqrt 8310 ⇒ real tick ~180510, NOT the stale active_tick 173640
    const t = ociTickFromPriceSqrt(8310.022582033909680813481414597178625815);
    expect(t).toBeGreaterThan(180000);
    expect(t).toBeLessThan(181000);
  });
  test('range snaps to tick_spacing and brackets the price', () => {
    const p = ociTickToPrice(173640);
    const { left, right } = ociTickRangeByPrice(p * 0.9, p * 1.1, 60);
    expect(left % 60).toBe(0);
    expect(right % 60).toBe(0);
    expect(left).toBeLessThan(173640);
    expect(right).toBeGreaterThan(173640);
  });
  test('width range is formula-free, on-grid, ≥ one spacing', () => {
    const { left, right } = ociTickRangeByWidth(173655, 60, 2, 3);
    expect(left).toBe(173640 - 2 * 60); // cell floor 173640, minus 2 spacings
    expect(right).toBe(173640 + (3 + 1) * 60); // plus active cell + 3 spacings
    expect(right).toBeGreaterThan(left);
    expect(() => ociTickRangeByWidth(1000, 60, -1, 0)).toThrow();
  });
});

describe('CaviarNine bin math (price = lower_limit·1.0005^(bin−active), verified)', () => {
  test('base + the active bin edges reconcile to lower/upper_limit', () => {
    expect(CAV_TICK_BASE).toBe(1.0005);
    const a = { activeBin: 20400, binSpan: 100, lowerLimit: 0.028750135585789412 };
    expect(cavBinToPrice(20400, a)).toBeCloseTo(0.028750135585789412, 12); // = lower_limit
    expect(cavBinToPrice(20500, a)).toBeCloseTo(0.030223808884146787, 10); // = upper_limit (active+bin_span)
  });
  test('price→bin round-trips on the grid', () => {
    const a = { activeBin: 20400, binSpan: 100, lowerLimit: 0.028750135585789412 };
    expect(cavPriceToBin(cavBinToPrice(20700, a), a)).toBeCloseTo(20700, 6);
  });
  test('price range → on-grid bin list bracketing the request', () => {
    const a = { activeBin: 20400, binSpan: 100, lowerLimit: 0.028750135585789412 };
    const bins = cavBinRangeByPrice(cavBinToPrice(20200, a), cavBinToPrice(20600, a), a);
    for (const b of bins) expect(b % 100).toBe(0);
    expect(Math.min(...bins)).toBeLessThanOrEqual(20200);
    expect(Math.max(...bins)).toBeGreaterThanOrEqual(20600);
  });
  test('width range around active bin (formula-free)', () => {
    const a = { activeBin: 20400, binSpan: 100 };
    expect(cavBinRangeByWidth(a, 3, 2)).toEqual([20100, 20200, 20300, 20400, 20500, 20600]);
    expect(cavBinRangeByWidth(a, 0, 0)).toEqual([20400]);
  });
});

describe('QuantaSwap per-bin distribution (matches the real add shape)', () => {
  const bins = [20100, 20200, 20300, 20400, 20500, 20600];
  test('x only ≥ active, y only ≤ active, active holds both; sums are exact', () => {
    const pos = distributeQuanta(bins, 20400, '6000', '15');
    const byBin = Object.fromEntries(pos.map((p) => [p.bin, p]));
    // above active → x only
    expect(byBin[20500]).toEqual({ bin: 20500, amountX: '2000', amountY: '0' });
    expect(byBin[20600]).toEqual({ bin: 20600, amountX: '2000', amountY: '0' });
    // below active → y only
    expect(byBin[20100]).toEqual({ bin: 20100, amountX: '0', amountY: '3.75' });
    expect(byBin[20300]).toEqual({ bin: 20300, amountX: '0', amountY: '3.75' });
    // active → both
    expect(byBin[20400]).toEqual({ bin: 20400, amountX: '2000', amountY: '3.75' });
    // no x below active, no y above active
    for (const p of pos) {
      if (p.bin < 20400) expect(p.amountX).toBe('0');
      if (p.bin > 20400) expect(p.amountY).toBe('0');
    }
    // conservation: parts sum back to the inputs exactly
    expect(sumDecimals(pos.map((p) => p.amountX))).toBe('6000');
    expect(sumDecimals(pos.map((p) => p.amountY))).toBe('15');
  });
  test('truncation remainder lands on the active bin (no dust loss)', () => {
    const pos = distributeQuanta(bins, 20400, '10', '0'); // 10/3 x-bins, indivisible
    expect(sumDecimals(pos.map((p) => p.amountX))).toBe('10'); // exact despite 3.333… split
    const active = pos.find((p) => p.bin === 20400)!;
    expect(active.amountX).toBe('3.333333333333333334'); // gets the remainder
  });
  test('single-sided range with no eligible bin for a side throws', () => {
    expect(() => distributeQuanta([20500, 20600], 20400, '0', '10')).toThrow(/no bin ≤ active/);
  });
});

describe('netAfterFee mirrors withdrawWithFee', () => {
  test('no fee → unchanged; 0.15% → amount·(1−rate); dust fee ignored', () => {
    expect(netAfterFee('1000', undefined)).toBe('1000');
    expect(netAfterFee('1000', '0.0015')).toBe('998.5');
    expect(netAfterFee('0.000000000000000001', '0.0015')).toBe('0.000000000000000001'); // fee rounds to 0
  });
});

describe('buildPrecisionDeposit (Ociswap) — verified add_liquidity(i32,i32,x,y)', () => {
  test('emits bare i32 tick literals then both buckets', () => {
    const m = buildPrecisionDeposit(ACCT, precision, 166708, 180572, '0.00004286', '1488.55');
    expect(m).toContain(`"withdraw" Address("${XWBTC}") Decimal("0.00004286")`);
    expect(m).toContain(`Address("${precision.address}") "add_liquidity" 166708i32 180572i32 Bucket("bucket_x") Bucket("bucket_y")`);
    expect(m).toContain('"deposit_batch" Expression("ENTIRE_WORKTOP")');
    expect(m).not.toContain('try_deposit_or_abort'); // no fee by default
  });
  test('rejects left ≥ right', () => {
    expect(() => buildPrecisionDeposit(ACCT, precision, 180572, 166708, '1', '1')).toThrow(/leftTick < rightTick/);
  });
  test('fee splice precedes the pool call', () => {
    const m = buildPrecisionDeposit(ACCT, precision, 166708, 180572, '100', '100', { fee: { rate: '0.0015', component: TREASURY } });
    expect(m).toContain(`TAKE_FROM_WORKTOP Address("${XWBTC}") Decimal("0.15") Bucket("fee_x")`);
    expect(m.indexOf('try_deposit_or_abort')).toBeLessThan(m.indexOf('add_liquidity'));
  });
});

describe('buildQuantaSwapDeposit (CaviarNine) — verified add_liquidity(x,y,positions)', () => {
  test('emits Array<Tuple>(Tuple(binu32, Decimal, Decimal)) with x≥active / y≤active', () => {
    const bins = [20100, 20200, 20300, 20400, 20500, 20600];
    const m = buildQuantaSwapDeposit(ACCT, quanta, bins, '6000', '15');
    expect(m).toContain('"add_liquidity" Bucket("bucket_x") Bucket("bucket_y") Array<Tuple>(');
    expect(m).toContain('Tuple(20400u32, Decimal("2000"), Decimal("3.75"))'); // active: both
    expect(m).toContain('Tuple(20500u32, Decimal("2000"), Decimal("0"))'); // above: x only
    expect(m).toContain('Tuple(20100u32, Decimal("0"), Decimal("3.75"))'); // below: y only
  });
  test('fee reduces the distributed (post-fee) amounts, splice precedes pool call', () => {
    const m = buildQuantaSwapDeposit(ACCT, quanta, [20300, 20400, 20500], '1000', '0', {
      fee: { rate: '0.0015', component: TREASURY },
    });
    // 1000 XRD − 0.15% = 998.5 split across x-eligible bins {20400,20500} → 499.25 each
    expect(m).toContain('Decimal("499.25")');
    expect(m).toContain(`TAKE_FROM_WORKTOP Address("${XRD}") Decimal("1.5") Bucket("fee_x")`);
    expect(m.indexOf('try_deposit_or_abort')).toBeLessThan(m.indexOf('add_liquidity'));
  });
  test('unresolved active bin throws (must resolve first)', () => {
    expect(() => buildQuantaSwapDeposit(ACCT, { ...quanta, activeBin: undefined }, [20400], '1', '1')).toThrow(/activeBin/);
  });
});

describe('buildNftWithdraw — both id shapes → remove_liquidity(lp_nft)', () => {
  test('Ociswap integer id #421#', () => {
    const m = buildNftWithdraw(ACCT, precision, '421');
    expect(m).toContain(`"withdraw_non_fungibles" Address("${precision.lp.kind === 'nft' ? precision.lp.resource : ''}") Array<NonFungibleLocalId>(NonFungibleLocalId("#421#"))`);
    expect(m).toContain(`Address("${precision.address}") "remove_liquidity" Bucket("bucket_lp")`);
  });
  test('QuantaSwap ruid id {…}', () => {
    const ruid = '{fc23de6308275c56-f89f715cc6a7f583-bc3aee11a0bea223-50d4fd1d3188dd70}';
    const m = buildNftWithdraw(ACCT, quanta, ruid);
    expect(m).toContain(`NonFungibleLocalId("${ruid}")`);
    expect(m).toContain(`Address("${quanta.address}") "remove_liquidity" Bucket("bucket_lp")`);
  });
  test('rejects a malformed id (injection guard)', () => {
    expect(() => buildNftWithdraw(ACCT, precision, '1") ; CALL_METHOD Address("x')).toThrow(/Invalid/);
  });
});
