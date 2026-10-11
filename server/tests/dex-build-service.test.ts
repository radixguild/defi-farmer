import { describe, test, expect, beforeEach } from 'bun:test';
import {
  resolveFee, isShortagePanic, posNum, deriveRange, multipleToSteps, DexBuildError,
  buildAndPreview,
} from '../src/services/dex/build-service';
import {
  type ResolvedPool, VERIFIED_POOL_PACKAGES, _clearResolverCache,
} from '../src/services/dex/pool-resolver';
import type { GatewayClient, GwEntityItem } from '../src/services/gateway';
import { XRD_STAKING_ADDRESS } from '../src/services/staking';
import { WEFT_V2_LENDING_COMPONENT } from '../src/services/weft';
import { LSU_POOL_COMPONENT } from '../src/services/lsu-pool';
import { _clearBoardCache } from '../src/services/validator-board';

const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const XWBTC = 'resource_rdx1t580qxc7upat7lww4l2c4jckacafjeudxj5wpjrrct0p3e82sq4y75';
const XUSDT = 'resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw';
const TREASURY = 'component_rdx1cptreasuryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const precision: ResolvedPool = {
  address: 'component_rdx1cpgmgrskahkxe4lnpp9s2f5ga0z8jkl7ne8gjmw3fc2224lxq505mr',
  protocol: 'ociswap', kind: 'ociswap_precision', blueprintName: 'PrecisionPool', packageAddress: 'package_rdx1x',
  concentrated: true, tokenX: XWBTC, tokenY: XRD, lp: { kind: 'nft', resource: 'resource_rdx1n2zsvvdah' },
  tickSpacing: 60, activeTick: 173640, priceSqrt: '8310.022582033909680813481414597178625815',
};
const quanta: ResolvedPool = {
  address: 'component_rdx1cqs338cyje65rk44zgmjvvy42qcszrhk9ewznedtkqd8l3crtgnmh5',
  protocol: 'caviarnine', kind: 'caviarnine_quantaswap', blueprintName: 'QuantaSwap', packageAddress: 'package_rdx1y',
  concentrated: true, tokenX: XRD, tokenY: XUSDT, lp: { kind: 'nft', resource: 'resource_rdx1nft63k' },
  binSpan: 100, activeBin: 19900, lowerLimit: '0.028750135585789412', upperLimit: '0.030223808884146787',
};

describe('resolveFee — server-policy fee, fail-safe', () => {
  test('off when either side empty (Phase 0)', () => {
    expect(resolveFee('', '')).toBeUndefined();
    expect(resolveFee('0.0015', '')).toBeUndefined();
    expect(resolveFee('', TREASURY)).toBeUndefined();
  });
  test('enabled with valid rate + component', () => {
    expect(resolveFee('0.0015', TREASURY)).toEqual({ rate: '0.0015', component: TREASURY });
  });
  test('misconfig disables the fee (never breaks deposits)', () => {
    expect(resolveFee('not-a-number', TREASURY)).toBeUndefined();
    expect(resolveFee('0.0015', 'account_rdx1notacomponent')).toBeUndefined(); // account, not component
    expect(resolveFee('0', TREASURY)).toBeUndefined(); // zero rate
  });
});

describe('isShortagePanic', () => {
  test('matches the DefiPlaza counter-liquidity panic', () => {
    expect(isShortagePanic('ApplicationError(PanicMessage("In shortage: requires counter liquidity"))')).toBe(true);
    expect(isShortagePanic('pair.rs:290 requires COUNTER LIQUIDITY')).toBe(true);
    expect(isShortagePanic('some unrelated failure')).toBe(false);
    expect(isShortagePanic(undefined)).toBe(false);
  });
});

describe('posNum', () => {
  test('parses positive decimals, rejects junk/zero/negatives', () => {
    expect(posNum('1.5', 'x')).toBe(1.5);
    expect(() => posNum(undefined, 'x')).toThrow(DexBuildError);
    expect(() => posNum('0', 'x')).toThrow(DexBuildError);
    expect(() => posNum('-1', 'x')).toThrow(DexBuildError);
    expect(() => posNum('1e5', 'x')).toThrow(DexBuildError); // no exponent form
  });
});

describe('deriveRange — Precision (ticks)', () => {
  test('width path centers on price_sqrt (not stale active_tick), snaps to spacing', () => {
    const r = deriveRange(precision, { below: 3, above: 3 }) as { left: number; right: number };
    // price_sqrt 8310 → true tick ~180513; cell 180480; ±3 spacings of 60
    expect(r.left).toBe(180480 - 3 * 60);
    expect(r.right).toBe(180480 + (3 + 1) * 60);
    expect(r.left % 60).toBe(0);
    expect(r.right % 60).toBe(0);
  });
  test('price path snaps to spacing and brackets', () => {
    const r = deriveRange(precision, { loPrice: '60000000', hiPrice: '80000000' }) as { left: number; right: number };
    expect(r.left % 60).toBe(0);
    expect(r.right).toBeGreaterThan(r.left);
  });
  test('missing range or malformed spec throws 400', () => {
    expect(() => deriveRange(precision, undefined)).toThrow(DexBuildError);
    expect(() => deriveRange(precision, {})).toThrow(DexBuildError);
    expect(() => deriveRange(precision, { below: -1, above: 2 })).toThrow(DexBuildError);
  });
});

describe('deriveRange — QuantaSwap (bins)', () => {
  test('width path → on-grid bins around active', () => {
    const r = deriveRange(quanta, { below: 2, above: 2 }) as { bins: number[] };
    expect(r.bins).toEqual([19700, 19800, 19900, 20000, 20100]);
  });
  test('price path uses lower_limit anchor', () => {
    const r = deriveRange(quanta, { loPrice: '0.0287', hiPrice: '0.0302' }) as { bins: number[] };
    for (const b of r.bins) expect(b % 100).toBe(0);
    expect(r.bins).toContain(19900);
  });
  test('price path without lower_limit tells caller to use width', () => {
    expect(() => deriveRange({ ...quanta, lowerLimit: undefined }, { loPrice: '0.0287', hiPrice: '0.0302' })).toThrow(/width range/);
  });
  test('a pathologically wide range is rejected (DoS guard), not built', () => {
    expect(() => deriveRange(quanta, { below: 10_000_000, above: 0 })).toThrow(DexBuildError);
    expect(() => deriveRange(quanta, { below: 0, above: 5_000_000 })).toThrow(/too wide/);
  });
});

describe('deriveRange — {multiple} (the optimizer width form)', () => {
  test('multipleToSteps: per-side log-price over grid units, min 1', () => {
    expect(multipleToSteps(1.2, Math.log(1.0001), 60)).toBe(30);
    expect(multipleToSteps(1.2, Math.log(1.0005), 100)).toBe(4);
    expect(multipleToSteps(1.0001, Math.log(1.0001), 60)).toBe(1);
    expect(() => multipleToSteps(1, Math.log(1.0001), 60)).toThrow(DexBuildError);
    expect(() => multipleToSteps(101, Math.log(1.0001), 60)).toThrow(DexBuildError);
    expect(() => multipleToSteps(Number.NaN, Math.log(1.0001), 60)).toThrow(DexBuildError);
  });

  test('precision: {multiple} equals the symmetric-steps width form', () => {
    const viaMultiple = deriveRange(precision, { multiple: 1.2 });
    const viaWidth = deriveRange(precision, { below: 30, above: 30 });
    expect(viaMultiple).toEqual(viaWidth);
  });

  test('quantaswap: {multiple} equals the symmetric-bins width form', () => {
    const viaMultiple = deriveRange(quanta, { multiple: 1.2 }) as { bins: number[] };
    const viaWidth = deriveRange(quanta, { below: 4, above: 4 }) as { bins: number[] };
    expect(viaMultiple.bins).toEqual(viaWidth.bins);
  });

  test('an explicit width wins over a stray multiple', () => {
    expect(deriveRange(precision, { multiple: 3, below: 2, above: 2 })).toEqual(
      deriveRange(precision, { below: 2, above: 2 }),
    );
  });

  test('non-concentrated kinds reject {multiple}', () => {
    const basic: ResolvedPool = {
      address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      protocol: 'ociswap', kind: 'ociswap_basic', blueprintName: 'BasicPool', packageAddress: 'package_rdx1z',
      concentrated: false, tokenX: XRD, tokenY: XUSDT, lp: { kind: 'fungible', resource: 'resource_rdx1t5abcde' },
    };
    expect(() => deriveRange(basic, { multiple: 1.2 })).toThrow(DexBuildError);
  });
});

// ── single-sided venue EXITS (dispatch) ───────────────────────────────────────
//
// The deposit path was proven in #40; these pin the exit dispatch, whose failure
// modes are worse than a rejected build: an unstake that reaches a wallet
// WITHOUT the unbonding warning, or a claim built for a receipt that is not
// claimable yet, both look fine in a dry-run.

const EXIT_VALIDATOR = 'validator_rdx1swt8pyg3qs0ra3472jd23hx0520yyz665ypgmc2r7xa33mq9488atw';
const EXIT_LSU = 'resource_rdx1t405vgxl7wup4lce727l6mue4e7f4ku7y750savh48k4gwnk9gcpmy';
const EXIT_CLAIM_NFT = 'resource_rdx1nta23ustrhrwncyhflmz8y845tq2e648g5hvlpulexvlx4atxvwd40';
const EXIT_ACCOUNT = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const EXIT_CLAIM_ID = '{d6823bcd82ad7ce3-4264293749495db4-eaaa7ff718f20713-b5c3927546aa80ea}';

function exitGw(over: Record<string, (body: any) => any> = {}, epoch = 334_599): GatewayClient {
  const handlers: Record<string, (body: any) => any> = {
    '/state/entity/details': (body: any) => ({
      items: (body.addresses as string[]).map((address: string) => ({
        address,
        details: {
          state: {
            stake_unit_resource_address: EXIT_LSU,
            claim_token_resource_address: EXIT_CLAIM_NFT,
          },
        },
      })),
    }),
    ...over,
  };
  return {
    async post(path: string, body: unknown) {
      const h = handlers[path];
      if (!h) throw new Error(`unexpected Gateway call: ${path}`);
      return h(body as any);
    },
    async getCurrentEpoch() {
      return epoch;
    },
    async previewTransaction() {
      return { receipt: { status: 'Succeeded' }, resource_changes: [] };
    },
  } as unknown as GatewayClient;
}

describe('buildAndPreview — native staking exit', () => {
  test('withdraw builds an unstake and ALWAYS carries the unbonding notice', async () => {
    const r = await buildAndPreview(exitGw(), {
      action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, lpAmount: '25',
    });
    expect(r.manifest).toContain(`"unstake" Bucket("bucket_lsu")`);
    expect(r.manifest).toContain(`"withdraw" Address("${EXIT_LSU}") Decimal("25")`);
    expect(r.notice).toContain('does NOT return XRD');
    expect(r.pool.kind).toBe('native_stake');
    expect(r.preview.ok).toBe(true);
  });

  test('the LSU is resolved from the validator — a caller cannot name it', async () => {
    const r = await buildAndPreview(exitGw(), {
      action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, lpAmount: '25',
      // a hostile/mistaken caller cannot inject a resource: there is no field for it
    } as never);
    expect(r.manifest).toContain(EXIT_LSU);
  });

  test('missing validator, missing amount and zero amount are all 400-class', async () => {
    const base = { action: 'withdraw' as const, account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS };
    await expect(buildAndPreview(exitGw(), { ...base, lpAmount: '1' })).rejects.toThrow(/needs a validator/);
    await expect(buildAndPreview(exitGw(), { ...base, validator: EXIT_VALIDATOR })).rejects.toThrow(/lpAmount/);
    await expect(
      buildAndPreview(exitGw(), { ...base, validator: EXIT_VALIDATOR, lpAmount: '0' }),
    ).rejects.toThrow(/greater than zero/);
    await expect(
      buildAndPreview(exitGw(), { ...base, validator: EXIT_ACCOUNT, lpAmount: '1' }),
    ).rejects.toThrow(/validator_ address/);
  });
});

describe('buildAndPreview — stake claim', () => {
  const claimData = (epoch: number) => ({
    '/state/non-fungible/data': () => ({
      non_fungible_ids: [{
        non_fungible_id: EXIT_CLAIM_ID,
        is_burned: false,
        data: {
          programmatic_json: {
            fields: [
              { field_name: 'claim_epoch', value: String(epoch) },
              { field_name: 'claim_amount', value: '4516151.39' },
            ],
          },
        },
      }],
    }),
  });

  test('a ready claim builds claim_xrd and reports what it is worth', async () => {
    const r = await buildAndPreview(exitGw(claimData(334_000)), {
      action: 'claim', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, localId: EXIT_CLAIM_ID,
    });
    expect(r.manifest).toContain(`"claim_xrd" Bucket("bucket_claim")`);
    expect(r.claim?.ready).toBe(true);
    expect(r.claim?.claimAmountXrd).toBe('4516151.39');
  });

  test('an unbonding claim is REFUSED with the real numbers, not a raw engine error', async () => {
    const p = buildAndPreview(exitGw(claimData(336_613)), {
      action: 'claim', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, localId: EXIT_CLAIM_ID,
    });
    await expect(p).rejects.toThrow(DexBuildError);
    await expect(p).rejects.toThrow(/2014 epochs away/);
  });

  test('claim needs a localId, and does not apply to LP pools', async () => {
    await expect(
      buildAndPreview(exitGw(), {
        action: 'claim', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
        validator: EXIT_VALIDATOR,
      }),
    ).rejects.toThrow(/localId/);
    await expect(
      buildAndPreview(exitGw(), {
        action: 'claim', account: EXIT_ACCOUNT,
        poolAddress: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
      }),
    ).rejects.toThrow(/native staking only/);
  });
});

describe('buildAndPreview — Weft supply exit', () => {
  test('spends the resolved w2 deposit unit, not XRD', async () => {
    const W2 = 'resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz';
    const gw = exitGw({
      '/state/entity/details': () => ({
        items: [{ details: { state: { fields: [{ field_name: 'resource_pools', value: 'internal_keyvaluestore_rdx1kzjr763' }] } } }],
      }),
      '/state/key-value-store/keys': () => ({
        items: [{ key: { raw_hex: 'ab', programmatic_json: { value: XRD } } }],
      }),
      '/state/key-value-store/data': () => ({
        entries: [{ value: { programmatic_json: { fields: [{ field_name: 'deposit_unit_res_address', value: W2 }] } } }],
      }),
    });
    const r = await buildAndPreview(gw, {
      action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: `weft-v2:${XRD}`, lpAmount: '500',
    });
    expect(r.manifest).toContain(`"withdraw" Address("${W2}") Decimal("500")`);
    expect(r.manifest).toContain(`"withdraw" Array<Bucket>(Bucket("bucket_w2"))`);
    expect(r.notice).toMatch(/un-borrowed liquidity/);
  });
});

describe('buildAndPreview — venue exit error mapping', () => {
  test('an unresolvable validator is a 400-class build error, not an upstream one', async () => {
    const gw = exitGw({ '/state/entity/details': () => ({ items: [] }) });
    await expect(
      buildAndPreview(gw, {
        action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
        validator: EXIT_VALIDATOR, lpAmount: '1',
      }),
    ).rejects.toThrow(DexBuildError);
  });

  test('a Gateway outage stays upstream — it must not be reported as a bad request', async () => {
    const gw = exitGw({
      '/state/entity/details': () => {
        throw new Error('Gateway https://mainnet.radixdlt.com failed: 503 Service Unavailable');
      },
    });
    const p = buildAndPreview(gw, {
      action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, lpAmount: '1',
    });
    await expect(p).rejects.toThrow(/503 Service Unavailable/);
    await expect(p).rejects.not.toBeInstanceOf(DexBuildError);
  });

  test('a genuine bug (TypeError) is not relabeled as the caller\'s bad request', async () => {
    // Not a Gateway-status failure and not one of rtm.ts's assert* validation
    // errors (those are always a plain `Error`) — a TypeError reaching this
    // path is a bug (or a raw network failure — `fetch` itself throws
    // TypeError, not an Error, for connection failures), and must reach the
    // caller as an upstream 5xx with a generic message, never as a 400 that
    // quotes an internal error string back at them as if it were their typo.
    const gw = exitGw({
      '/state/entity/details': () => {
        throw new TypeError("Cannot read properties of undefined (reading 'items')");
      },
    });
    const p = buildAndPreview(gw, {
      action: 'withdraw', account: EXIT_ACCOUNT, poolAddress: XRD_STAKING_ADDRESS,
      validator: EXIT_VALIDATOR, lpAmount: '1',
    });
    await expect(p).rejects.toThrow(/Cannot read properties of undefined/);
    await expect(p).rejects.not.toBeInstanceOf(DexBuildError);
  });
});

// ── buildAndPreview: no lock_fee reaches the preview or the wallet ───────────
//
// The builders are pinned in dex-manifests.test.ts; this pins the service that
// calls them, for every kind the endpoint can build, so no path through it adds
// a lock back. That includes the two that build a SECOND manifest: the
// CaviarNine WeightedPool swapped-order retry, and the DefiPlaza shortage reply
// the UI re-requests with co-liquidity. Every manifest that reaches the preview
// is checked, not only the one returned.

const LF_BASIC = 'component_rdx1cbasicpoolfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_BASIC_NATIVE = 'pool_rdx1cbasicnativefixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_BASIC_LP = 'resource_rdx1tbasiclpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_WEIGHTED = 'component_rdx1cweightedpoolfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_WEIGHTED_NATIVE = 'pool_rdx1cweightednativefixturexxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_WEIGHTED_LP = 'resource_rdx1tweightedlpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PRECISION = 'component_rdx1cprecisionpoolfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PRECISION_LP = 'resource_rdx1nprecisionlpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_QUANTA = 'component_rdx1cquantaswapfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_QUANTA_LP = 'resource_rdx1nquantalpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PLAZA = 'component_rdx1cplazapairfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PLAZA_BASE_POOL = 'pool_rdx1cplazabasefixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PLAZA_QUOTE_POOL = 'pool_rdx1cplazaquotefixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PLAZA_BASE_LP = 'resource_rdx1tplazabaselpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_PLAZA_QUOTE_LP = 'resource_rdx1tplazaquotelpfixturexxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const LF_W2 = 'resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz';
const SHORTAGE_PANIC = 'ApplicationError(PanicMessage("In shortage: requires counter liquidity"))';

const lfItems: Record<string, GwEntityItem> = {
  [LF_BASIC]: {
    address: LF_BASIC,
    details: {
      blueprint_name: 'BasicPool', package_address: process.env.DEX_PACKAGES_OCISWAP_BASIC,
      state: { fields: [
        { field_name: 'x_address', value: XUSDT },
        { field_name: 'y_address', value: XRD },
        { field_name: 'liquidity_pool', value: LF_BASIC_NATIVE },
      ] },
    },
  },
  [LF_BASIC_NATIVE]: { address: LF_BASIC_NATIVE, details: { state: { pool_unit_resource_address: LF_BASIC_LP } } },
  [LF_WEIGHTED]: {
    address: LF_WEIGHTED,
    details: {
      blueprint_name: 'WeightedPool', package_address: process.env.DEX_PACKAGES_CAVIARNINE_WEIGHTED,
      state: { fields: [{ field_name: 'resource_pool', value: LF_WEIGHTED_NATIVE }] },
    },
  },
  [LF_WEIGHTED_NATIVE]: {
    address: LF_WEIGHTED_NATIVE,
    details: { state: {
      pool_unit_resource_address: LF_WEIGHTED_LP,
      vaults: [{ resource_address: XRD }, { resource_address: XUSDT }],
    } },
  },
  [LF_PRECISION]: {
    address: LF_PRECISION,
    details: {
      blueprint_name: 'PrecisionPool', package_address: VERIFIED_POOL_PACKAGES.ociswap_precision[0],
      state: { fields: [
        { field_name: 'active_tick', fields: [{ value: '173640' }] },
        { field_name: 'price_sqrt', value: '8310.022582033909680813481414597178625815' },
      ] },
    },
    metadata: { items: [
      { key: 'x_address', value: { typed: { value: XWBTC } } },
      { key: 'y_address', value: { typed: { value: XRD } } },
      { key: 'lp_address', value: { typed: { value: LF_PRECISION_LP } } },
      { key: 'tick_spacing', value: { typed: { value: '60' } } },
    ] },
  },
  [LF_QUANTA]: {
    address: LF_QUANTA,
    details: {
      blueprint_name: 'QuantaSwap', package_address: VERIFIED_POOL_PACKAGES.caviarnine_quantaswap[0],
      state: { fields: [
        { field_name: 'liquidity_receipt_manager', value: LF_QUANTA_LP },
        { field_name: 'bin_span', value: '100' },
        { field_name: 'tick_index', fields: [
          { field_name: 'current', variant_name: 'Some', fields: [{ fields: [{ value: '19900' }] }] },
        ] },
        { field_name: 'lower_limit', value: '0.028750135585789412' },
        { field_name: 'upper_limit', value: '0.030223808884146787' },
      ] },
    },
    metadata: { items: [
      { key: 'token_x', value: { typed: { value: XRD } } },
      { key: 'token_y', value: { typed: { value: XUSDT } } },
    ] },
  },
  [LF_PLAZA]: {
    address: LF_PLAZA,
    details: {
      blueprint_name: 'PlazaPair', package_address: process.env.DEX_PACKAGES_DEFIPLAZA_PAIR,
      state: { fields: [
        { field_name: 'base_address', value: XWBTC },
        { field_name: 'quote_address', value: XRD },
        { field_name: 'base_pool', value: LF_PLAZA_BASE_POOL },
        { field_name: 'quote_pool', value: LF_PLAZA_QUOTE_POOL },
        { field_name: 'state', fields: [{ field_name: 'shortage', variant_name: 'Equilibrium' }] },
      ] },
    },
  },
  [LF_PLAZA_BASE_POOL]: { address: LF_PLAZA_BASE_POOL, details: { state: { pool_unit_resource_address: LF_PLAZA_BASE_LP } } },
  [LF_PLAZA_QUOTE_POOL]: { address: LF_PLAZA_QUOTE_POOL, details: { state: { pool_unit_resource_address: LF_PLAZA_QUOTE_LP } } },
} as unknown as Record<string, GwEntityItem>;

interface LockFeeGw {
  previewed: string[];
}

/// One stub for every kind: LP pools resolve from `lfItems`; validators, Weft
/// and stake claims answer the venue paths. `verdict` decides each preview, so
/// a test can fail the first build and watch the retry.
function lockFeeGw(verdict: (manifest: string, n: number) => Record<string, unknown> = () => ({ status: 'Succeeded' })) {
  const validatorState = {
    stake_unit_resource_address: EXIT_LSU,
    claim_token_resource_address: EXIT_CLAIM_NFT,
  };
  const handlers: Record<string, (body: any) => any> = {
    '/state/validators/list': () => ({
      ledger_state: { proposer_round_timestamp: '2026-10-01T00:00:00Z' },
      validators: { items: [{
        address: EXIT_VALIDATOR,
        active_in_epoch: { stake: '1000000' },
        stake_vault: { balance: '1000000' },
        state: validatorState,
        effective_fee_factor: { current: { fee_factor: '0.01' } },
      }] },
    }),
    '/state/entity/details': (body: any) => {
      const addrs = body.addresses as string[];
      if (addrs.includes(WEFT_V2_LENDING_COMPONENT)) {
        return { items: [{ details: { state: { fields: [{ field_name: 'resource_pools', value: 'internal_keyvaluestore_rdx1kzjr763' }] } } }] };
      }
      // validator state for the venue paths; LSU supplies (unmeasured) otherwise
      return { items: addrs.filter((a) => a.startsWith('validator_')).map((address) => ({ address, details: { state: validatorState } })) };
    },
    '/state/key-value-store/keys': () => ({ items: [{ key: { raw_hex: 'ab', programmatic_json: { value: XRD } } }] }),
    '/state/key-value-store/data': () => ({
      entries: [{ value: { programmatic_json: { fields: [{ field_name: 'deposit_unit_res_address', value: LF_W2 }] } } }],
    }),
    '/state/non-fungible/data': () => ({
      non_fungible_ids: [{
        non_fungible_id: EXIT_CLAIM_ID, is_burned: false,
        data: { programmatic_json: { fields: [
          { field_name: 'claim_epoch', value: '334000' },
          { field_name: 'claim_amount', value: '100' },
        ] } },
      }],
    }),
  };
  const gw = {
    previewed: [] as string[],
    async entityDetailsGlobal(addresses: string[]) {
      return { items: addresses.map((a) => lfItems[a] ?? ({ address: a } as GwEntityItem)) };
    },
    async post(path: string, body: unknown) {
      const h = handlers[path];
      if (!h) throw new Error(`unexpected Gateway call: ${path}`);
      return h(body);
    },
    async getCurrentEpoch() {
      return 334_599;
    },
    async previewTransaction(manifest: string) {
      gw.previewed.push(manifest);
      return { receipt: verdict(manifest, gw.previewed.length), resource_changes: [] };
    },
  };
  return gw as unknown as GatewayClient & LockFeeGw;
}

describe('buildAndPreview — no lock_fee on any path', () => {
  beforeEach(() => {
    _clearResolverCache();
    _clearBoardCache();
  });

  const acct = EXIT_ACCOUNT;
  const rows: Array<[string, Parameters<typeof buildAndPreview>[1]]> = [
    ['ociswap_basic deposit', { action: 'deposit', account: acct, poolAddress: LF_BASIC, amountX: '10', amountY: '100' }],
    ['caviarnine_weighted deposit', { action: 'deposit', account: acct, poolAddress: LF_WEIGHTED, amountX: '100', amountY: '10' }],
    ['ociswap_precision deposit', { action: 'deposit', account: acct, poolAddress: LF_PRECISION, amountX: '0.001', amountY: '100', range: { below: 3, above: 3 } }],
    ['caviarnine_quantaswap deposit', { action: 'deposit', account: acct, poolAddress: LF_QUANTA, amountX: '100', amountY: '5', range: { below: 2, above: 2 } }],
    ['defiplaza_pair deposit', { action: 'deposit', account: acct, poolAddress: LF_PLAZA, inputToken: XRD, inputAmount: '100' }],
    ['defiplaza_pair deposit with co-liquidity', { action: 'deposit', account: acct, poolAddress: LF_PLAZA, inputToken: XRD, inputAmount: '100', coAmount: '0.001' }],
    ['ociswap_basic withdraw', { action: 'withdraw', account: acct, poolAddress: LF_BASIC, lpAmount: '1' }],
    ['caviarnine_weighted withdraw', { action: 'withdraw', account: acct, poolAddress: LF_WEIGHTED, lpAmount: '1' }],
    ['ociswap_precision withdraw', { action: 'withdraw', account: acct, poolAddress: LF_PRECISION, localId: '#421#' }],
    ['caviarnine_quantaswap withdraw', { action: 'withdraw', account: acct, poolAddress: LF_QUANTA, localId: EXIT_CLAIM_ID }],
    ['defiplaza_pair withdraw', { action: 'withdraw', account: acct, poolAddress: LF_PLAZA, lpToken: LF_PLAZA_QUOTE_LP, lpAmount: '1' }],
    ['native stake deposit', { action: 'deposit', account: acct, poolAddress: XRD_STAKING_ADDRESS, amountX: '100' }],
    ['weft supply deposit', { action: 'deposit', account: acct, poolAddress: `weft-v2:${XRD}`, amountX: '100' }],
    ['lsulp deposit', { action: 'deposit', account: acct, poolAddress: LSU_POOL_COMPONENT, amountX: '100' }],
    ['native unstake', { action: 'withdraw', account: acct, poolAddress: XRD_STAKING_ADDRESS, validator: EXIT_VALIDATOR, lpAmount: '1' }],
    ['native claim', { action: 'claim', account: acct, poolAddress: XRD_STAKING_ADDRESS, validator: EXIT_VALIDATOR, localId: EXIT_CLAIM_ID }],
    ['weft supply withdraw', { action: 'withdraw', account: acct, poolAddress: `weft-v2:${XRD}`, lpAmount: '1' }],
    ['lsulp withdraw to LSU', { action: 'withdraw', account: acct, poolAddress: LSU_POOL_COMPONENT, lpAmount: '1' }],
    ['lsulp withdraw to XRD', { action: 'withdraw', account: acct, poolAddress: LSU_POOL_COMPONENT, lpAmount: '1', exitTo: 'xrd' }],
  ];

  test.each(rows)('%s', async (_label, req) => {
    const gw = lockFeeGw();
    const r = await buildAndPreview(gw, req);
    expect(r.preview.ok).toBe(true);
    expect(r.manifest).not.toContain('lock_fee');
    expect(gw.previewed.length).toBeGreaterThan(0);
    for (const m of gw.previewed) expect(m).not.toContain('lock_fee');
  });

  test('CaviarNine WeightedPool swapped-order retry: the second manifest is fee-less too', async () => {
    // Fail the first (vault-order) build so the service retries with x/y swapped.
    const gw = lockFeeGw((_m, n) => (n === 1 ? { status: 'Failed', error_message: 'wrong order' } : { status: 'Succeeded' }));
    const r = await buildAndPreview(gw, {
      action: 'deposit', account: acct, poolAddress: LF_WEIGHTED, amountX: '100', amountY: '10',
    });
    expect(gw.previewed.length).toBe(2);
    expect(r.manifest).toBe(gw.previewed[1]); // the swapped one was taken
    expect(r.manifest.indexOf(`"withdraw" Address("${XUSDT}")`))
      .toBeLessThan(r.manifest.indexOf(`"withdraw" Address("${XRD}")`));
    expect(r.preview.ok).toBe(true);
    for (const m of gw.previewed) expect(m).not.toContain('lock_fee');
  });

  test('DefiPlaza shortage: the manifest returned with needsCoLiquidity is fee-less', async () => {
    const gw = lockFeeGw(() => ({ status: 'Failed', error_message: SHORTAGE_PANIC }));
    const r = await buildAndPreview(gw, {
      action: 'deposit', account: acct, poolAddress: LF_PLAZA, inputToken: XRD, inputAmount: '100',
    });
    expect(r.needsCoLiquidity).toEqual({ otherToken: XWBTC });
    expect(r.manifest).not.toContain('lock_fee');
    for (const m of gw.previewed) expect(m).not.toContain('lock_fee');
  });
});
