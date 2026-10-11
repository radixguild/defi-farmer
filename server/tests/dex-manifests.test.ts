import { describe, test, expect } from 'bun:test';
import {
  buildTwoSidedDeposit, buildDefiplazaDeposit, buildFungibleWithdraw, buildDefiplazaWithdraw, buildDeposit,
  buildPrecisionDeposit, buildQuantaSwapDeposit, buildNftWithdraw, type BuildOpts,
} from '../src/services/dex/manifests';
import * as lpBuilders from '../src/services/dex/manifests';
import {
  buildStakeDeposit, buildWeftSupplyDeposit, buildLsulpDeposit,
  buildStakeUnstake, buildStakeClaim, buildWeftSupplyWithdraw, buildLsulpWithdraw,
} from '../src/services/dex/venue-manifests';
import * as venueBuilders from '../src/services/dex/venue-manifests';
import type { ResolvedPool } from '../src/services/dex/pool-resolver';

const ACCT = 'account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const OCI = 'resource_rdx1t52pvtk5wfhltchwh3rkzls2x0r98fw9cjhpyrf3vsykhkuwrf7jg8';
const XETH = 'resource_rdx1th88qcj5syl9ghka2g9l7tw497vy5x6zaatyvgfkwcfe8n9jt2npww';
const TREASURY = 'component_rdx1cptreasuryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const basic: ResolvedPool = {
  address: 'component_rdx1cz89w3ecvh9jvdd892vycs44rr042lteg75zgdydq9csn5d87snvdw',
  protocol: 'ociswap', kind: 'ociswap_basic', blueprintName: 'BasicPool', packageAddress: 'package_rdx1x',
  concentrated: false, tokenX: OCI, tokenY: XRD,
  lp: { kind: 'fungible', resource: 'resource_rdx1th7ew2u9c9t00xhk34efm9uj8zxnme48h4ypuerv5uu4ftz8j82gdm' },
};
const plaza: ResolvedPool = {
  address: 'component_rdx1crwdzvlv7djtkug9gmvp9ejun0gm0w6cvkpfqycw8fcp4gg82eftjc',
  protocol: 'defiplaza', kind: 'defiplaza_pair', blueprintName: 'PlazaPair', packageAddress: 'package_rdx1x',
  concentrated: false, tokenX: XETH, tokenY: XRD,
  lp: { kind: 'defiplaza',
    baseLp: 'resource_rdx1t5psxgpqpqahz3c2acjnrj7hnrxkw96artmlc0mz80nqgszauw9nvl',
    quoteLp: 'resource_rdx1tkh2swl9qsfwp33cy8v6mfsmmdpxfa3emt0mz6an56ytat0gnl8fe5' },
  shortage: 'Equilibrium', router: 'component_rdx1cqy7sq3mxj2whhlqlryy05hzs96m0ajnv23e7j7vanmdwwlccnmz68',
};

describe('two-sided deposit (Basic/Weighted)', () => {
  test('matches the verified add_liquidity(x,y) shape', () => {
    const m = buildTwoSidedDeposit(ACCT, basic, '100', '5');
    expect(m).not.toContain('lock_fee'); // the wallet locks the fee itself
    expect(m).toContain(`"withdraw" Address("${OCI}") Decimal("100")`);
    expect(m).toContain(`"withdraw" Address("${XRD}") Decimal("5")`);
    expect(m).toContain(`Address("${basic.address}") "add_liquidity" Bucket("bucket_x") Bucket("bucket_y")`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
    // no fee by default
    expect(m).not.toContain('try_deposit_or_abort');
  });

  test('fee splice: takes rate·amount to treasury before the pool call', () => {
    const m = buildTwoSidedDeposit(ACCT, basic, '100', '5', { fee: { rate: '0.0015', component: TREASURY } });
    expect(m).toContain(`TAKE_FROM_WORKTOP Address("${OCI}") Decimal("0.15") Bucket("fee_x")`);
    expect(m).toContain(`TAKE_FROM_WORKTOP Address("${XRD}") Decimal("0.0075") Bucket("fee_y")`);
    expect(m).toContain(`Address("${TREASURY}") "try_deposit_or_abort" Bucket("fee_x") Enum<0u8>()`);
    // fee TAKE precedes the pool call (order is load-bearing)
    expect(m.indexOf('try_deposit_or_abort')).toBeLessThan(m.indexOf('add_liquidity'));
  });
});

describe('DefiPlaza single-sided deposit (router)', () => {
  test('None co-liquidity when not in shortage; always Some(base)', () => {
    const m = buildDefiplazaDeposit(ACCT, plaza, XRD, '500', undefined);
    expect(m).toContain(`Address("${plaza.router}") "add_liquidity" Bucket("bucket_in") Enum<0u8>() Enum<1u8>(Address("${XETH}"))`);
  });
  test('Some(co) bucket when co-liquidity supplied (shortage side)', () => {
    const m = buildDefiplazaDeposit(ACCT, plaza, XETH, '1', '500');
    expect(m).toContain(`"withdraw" Address("${XRD}") Decimal("500")`); // the OTHER token
    expect(m).toContain(`"add_liquidity" Bucket("bucket_in") Enum<1u8>(Bucket("bucket_co")) Enum<1u8>(Address("${XETH}"))`);
  });
});

describe('withdraw', () => {
  test('fungible remove_liquidity on the pool', () => {
    const m = buildFungibleWithdraw(ACCT, basic, '2920.6');
    expect(m).toContain(`"withdraw" Address("${basic.lp.kind === 'fungible' ? basic.lp.resource : ''}") Decimal("2920.6")`);
    expect(m).toContain(`Address("${basic.address}") "remove_liquidity" Bucket("bucket_lp")`);
  });
  test('DefiPlaza remove routes through the router', () => {
    const lp = plaza.lp.kind === 'defiplaza' ? plaza.lp.baseLp : '';
    const m = buildDefiplazaWithdraw(ACCT, plaza, lp, '90000');
    expect(m).toContain(`Address("${plaza.router}") "remove_liquidity" Bucket("bucket_lp")`);
  });
});

describe('safety', () => {
  test('rejects injection in amount', () => {
    expect(() => buildTwoSidedDeposit(ACCT, basic, '1") ; CALL_METHOD Address("x', '5')).toThrow();
  });
  test('dispatcher requires a range for concentrated, rejects unsupported', () => {
    // concentrated pools need a tick/bin range computed via concentrated.ts
    expect(() => buildDeposit({ account: ACCT, pool: { ...basic, kind: 'ociswap_precision', concentrated: true }, amountX: '1', amountY: '1' })).toThrow(/leftTick/);
    expect(() => buildDeposit({ account: ACCT, pool: { ...basic, kind: 'caviarnine_quantaswap', concentrated: true, activeBin: 100, binSpan: 100 }, amountX: '1', amountY: '1' })).toThrow(/bins/);
    expect(() => buildDeposit({ account: ACCT, pool: { ...basic, kind: 'unsupported' } })).toThrow(/unsupported/);
  });
});

// ── the lock_fee rule, over EVERY builder ─────────────────────────────────────
//
// No builder locks a fee unless the caller passes opts.lockFee: the wallet adds
// its own fee lock and rejects a manifest that already carries one, and nothing
// in the app sets lockFee. The table names each builder, and the coverage test
// below fails if a builder is exported without a row here.

const PRECISION: ResolvedPool = {
  address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
  protocol: 'ociswap', kind: 'ociswap_precision', blueprintName: 'PrecisionPool', packageAddress: 'package_rdx1x',
  concentrated: true, tokenX: XETH, tokenY: XRD, lp: { kind: 'nft', resource: 'resource_rdx1nprecisionlpxx' },
  tickSpacing: 60, activeTick: 173640,
};
const QUANTA: ResolvedPool = {
  address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
  protocol: 'caviarnine', kind: 'caviarnine_quantaswap', blueprintName: 'QuantaSwap', packageAddress: 'package_rdx1y',
  concentrated: true, tokenX: XRD, tokenY: OCI, lp: { kind: 'nft', resource: 'resource_rdx1nquantalpxxx' },
  binSpan: 100, activeBin: 19900,
};
const WEIGHTED: ResolvedPool = {
  ...basic, protocol: 'caviarnine', kind: 'caviarnine_weighted', blueprintName: 'WeightedPool',
  address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
};
const VALIDATOR = 'validator_rdx1swt8pyg3qs0ra3472jd23hx0520yyz665ypgmc2r7xa33mq9488atw';
const LSU_RES = 'resource_rdx1thuy5j23qjskmqjq2700am2w63yn47daplvvhnw6ece3y02ft3aske';
const CLAIM_NFT = 'resource_rdx1nta23ustrhrwncyhflmz8y845tq2e648g5hvlpulexvlx4atxvwd40';
const CLAIM_ID = '{d6823bcd82ad7ce3-4264293749495db4-eaaa7ff718f20713-b5c3927546aa80ea}';
const W2_XRD = 'resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz';
const plazaBaseLp = plaza.lp.kind === 'defiplaza' ? plaza.lp.baseLp : '';

type Row = [label: string, builder: string, build: (opts?: BuildOpts) => string];
const BUILDER_ROWS: Row[] = [
  // LP add, one row per pool kind
  ['ociswap_basic add', 'buildTwoSidedDeposit', (o) => buildTwoSidedDeposit(ACCT, basic, '100', '5', o)],
  ['caviarnine_weighted add', 'buildTwoSidedDeposit', (o) => buildTwoSidedDeposit(ACCT, WEIGHTED, '100', '5', o)],
  ['defiplaza_pair add', 'buildDefiplazaDeposit', (o) => buildDefiplazaDeposit(ACCT, plaza, XETH, '1', '500', o)],
  ['ociswap_precision add', 'buildPrecisionDeposit', (o) => buildPrecisionDeposit(ACCT, PRECISION, 173580, 173760, '0.01', '100', o)],
  ['caviarnine_quantaswap add', 'buildQuantaSwapDeposit', (o) => buildQuantaSwapDeposit(ACCT, QUANTA, [19800, 19900, 20000], '100', '5', o)],
  // LP remove, one row per pool kind
  ['ociswap_basic remove', 'buildFungibleWithdraw', (o) => buildFungibleWithdraw(ACCT, basic, '10', o)],
  ['caviarnine_weighted remove', 'buildFungibleWithdraw', (o) => buildFungibleWithdraw(ACCT, WEIGHTED, '10', o)],
  ['defiplaza_pair remove', 'buildDefiplazaWithdraw', (o) => buildDefiplazaWithdraw(ACCT, plaza, plazaBaseLp, '10', o)],
  ['ociswap_precision remove', 'buildNftWithdraw', (o) => buildNftWithdraw(ACCT, PRECISION, '#421#', o)],
  ['caviarnine_quantaswap remove', 'buildNftWithdraw', (o) => buildNftWithdraw(ACCT, QUANTA, CLAIM_ID, o)],
  // single-sided venue deposits
  ['native stake deposit', 'buildStakeDeposit', (o) => buildStakeDeposit(ACCT, VALIDATOR, '100', o)],
  ['weft supply deposit', 'buildWeftSupplyDeposit', (o) => buildWeftSupplyDeposit(ACCT, '100', o)],
  ['lsulp deposit', 'buildLsulpDeposit', (o) => buildLsulpDeposit(ACCT, VALIDATOR, LSU_RES, '100', o)],
  // single-sided venue exits
  ['native unstake', 'buildStakeUnstake', (o) => buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '10', o)],
  ['native claim', 'buildStakeClaim', (o) => buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, CLAIM_ID, o)],
  ['weft supply withdraw', 'buildWeftSupplyWithdraw', (o) => buildWeftSupplyWithdraw(ACCT, W2_XRD, '10', o)],
  ['lsulp withdraw', 'buildLsulpWithdraw', (o) => buildLsulpWithdraw(ACCT, '10', LSU_RES, VALIDATOR, o)],
];

describe('lock_fee is opt-in on every builder', () => {
  test.each(BUILDER_ROWS)('%s (%s): none by default, exactly one on request', (_label, _builder, build) => {
    const without = build();
    expect(without).not.toContain('lock_fee');
    expect(build({})).toBe(without);

    const withLock = build({ lockFee: '5' });
    const lock = `CALL_METHOD Address("${ACCT}") "lock_fee" Decimal("5");`;
    expect(withLock.split('lock_fee').length - 1).toBe(1);
    // It is the first instruction, and the only difference from the default.
    expect(withLock).toBe(`${lock}\n${without}`);
  });

  test('a malformed lockFee is still rejected, never interpolated', () => {
    expect(() => buildTwoSidedDeposit(ACCT, basic, '100', '5', { lockFee: '5"); DROP' })).toThrow(/lockFee/);
  });

  test('the platform fee splice and the lock are independent', () => {
    const fee = { rate: '0.0015', component: TREASURY };
    const m = buildTwoSidedDeposit(ACCT, basic, '100', '5', { fee });
    expect(m).toContain('try_deposit_or_abort');
    expect(m).not.toContain('lock_fee');
  });

  test('every exported builder has a row in the table', () => {
    const exported = [...Object.keys(lpBuilders), ...Object.keys(venueBuilders)]
      .filter((name) => /^build[A-Z]/.test(name) && name !== 'buildDeposit'); // buildDeposit only dispatches
    const covered = new Set(BUILDER_ROWS.map(([, builder]) => builder));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });
});
