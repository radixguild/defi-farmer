/// venue-exit — the ledger reads an exit depends on, and the claim math.
///
/// The contract these pin: an exit NEVER builds against a resource the caller
/// named. Stake units and claim NFTs come from the validator's own state, Weft's
/// receipt token from Weft's own pool entry, and a resource that merely *claims*
/// (via metadata) to belong to a validator is rejected unless that validator
/// agrees. Claim readiness is pure and clock-injected so it is not flaky.

import { describe, test, expect } from 'bun:test';
import {
  resolveValidatorExitResources, resolveWeftDepositUnit, readStakeClaims, readStakeClaim,
  claimReadiness, claimCopy, VenueExitError,
} from '../src/services/dex/venue-exit';
import type { GatewayClient } from '../src/services/gateway';

const ACCOUNT = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const VALIDATOR = 'validator_rdx1swt8pyg3qs0ra3472jd23hx0520yyz665ypgmc2r7xa33mq9488atw';
const VALIDATOR_B = 'validator_rdx1svfvxj0glmg0ea2m0nqm47qlfypj2rcmp74t7p4wgjx2m0f2nju2zz';
const LSU = 'resource_rdx1t405vgxl7wup4lce727l6mue4e7f4ku7y750savh48k4gwnk9gcpmy';
const CLAIM_NFT = 'resource_rdx1nta23ustrhrwncyhflmz8y845tq2e648g5hvlpulexvlx4atxvwd40';
const IMPOSTOR_NFT = 'resource_rdx1ngvcjjnea4c897000pznkvelej3sur4gu94jcdqsntyzux2z5x6jk9';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const W2_XRD = 'resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz';
const KVS = 'internal_keyvaluestore_rdx1kzjr763caq96j0kv883vy8gnf3jvrrp7dfm9zr5n0akryvzsxvyujc';
const ID_A = '{d6823bcd82ad7ce3-4264293749495db4-eaaa7ff718f20713-b5c3927546aa80ea}';
const ID_B = '{8f4d518f9cc5306e-cd70a0f3ad7dd31e-098d40a19d033a89-c8c641605505f776}';

/// Fake Gateway dispatching on path, mirroring the real response envelopes
/// (shapes captured from mainnet 2026-08-13 — envelope misreads are exactly how
/// getAccountBalances silently returned [] for weeks).
function fakeGw(handlers: Record<string, (body: any) => any>, epoch = 334_599): GatewayClient {
  return {
    async post(path: string, body: unknown) {
      const h = handlers[path];
      if (!h) throw new Error(`unexpected Gateway call: ${path}`);
      return h(body as any);
    },
    async getCurrentEpoch() {
      return epoch;
    },
  } as unknown as GatewayClient;
}

const validatorStateResponse = (map: Record<string, { lsu?: string; claim?: string }>) =>
  (body: any) => ({
    items: (body.addresses as string[]).map((address) => ({
      address,
      details: {
        state: {
          stake_unit_resource_address: map[address]?.lsu,
          claim_token_resource_address: map[address]?.claim,
        },
      },
    })),
  });

describe('resolveValidatorExitResources', () => {
  test('reads both exit resources from the validator itself', async () => {
    const gw = fakeGw({
      '/state/entity/details': validatorStateResponse({ [VALIDATOR]: { lsu: LSU, claim: CLAIM_NFT } }),
    });
    expect(await resolveValidatorExitResources(gw, VALIDATOR)).toEqual({
      validator: VALIDATOR, lsuResource: LSU, claimNftResource: CLAIM_NFT,
    });
  });

  test('fails closed when the validator does not answer', async () => {
    const gw = fakeGw({ '/state/entity/details': () => ({ items: [] }) });
    await expect(resolveValidatorExitResources(gw, VALIDATOR)).rejects.toThrow(VenueExitError);
  });

  test('fails closed when only one of the two resources is present', async () => {
    const gw = fakeGw({
      '/state/entity/details': validatorStateResponse({ [VALIDATOR]: { lsu: LSU } }),
    });
    await expect(resolveValidatorExitResources(gw, VALIDATOR)).rejects.toThrow(/claim NFT/);
  });
});

describe('resolveWeftDepositUnit', () => {
  const weftHandlers = (opts: { poolFor?: string } = {}) => ({
    '/state/entity/details': () => ({
      items: [{ details: { state: { fields: [{ field_name: 'resource_pools', value: KVS }] } } }],
    }),
    '/state/key-value-store/keys': () => ({
      items: [{ key: { raw_hex: '5c805da6', programmatic_json: { value: opts.poolFor ?? XRD } } }],
    }),
    '/state/key-value-store/data': () => ({
      entries: [{
        value: {
          programmatic_json: {
            fields: [
              { field_name: 'interest_rate', value: '0.0493' },
              { field_name: 'deposit_unit_res_address', value: W2_XRD },
            ],
          },
        },
      }],
    }),
  });

  test('walks component → resource_pools KVS → the entry deposit unit', async () => {
    expect(await resolveWeftDepositUnit(fakeGw(weftHandlers()))).toBe(W2_XRD);
  });

  test('matched by field NAME, not position', async () => {
    // deposit_unit_res_address sits second here; a positional read returns the rate.
    const unit = await resolveWeftDepositUnit(fakeGw(weftHandlers()));
    expect(unit.startsWith('resource_')).toBe(true);
  });

  test('throws when Weft has no pool for the asset', async () => {
    const gw = fakeGw(weftHandlers({ poolFor: 'resource_rdx1tsomethingelse' }));
    await expect(resolveWeftDepositUnit(gw)).rejects.toThrow(/no pool for/);
  });

  test('throws when the store cannot be resolved (never a stale hardcode)', async () => {
    const gw = fakeGw({ '/state/entity/details': () => ({ items: [{ details: { state: { fields: [] } } }] }) });
    await expect(resolveWeftDepositUnit(gw)).rejects.toThrow(/resource_pools/);
  });
});

describe('claimReadiness (pure)', () => {
  const base = {
    validator: VALIDATOR, claimNftResource: CLAIM_NFT, localId: ID_A,
    claimEpoch: 336_613, claimAmountXrd: '4516151.390084284836838257',
  };
  const NOW = Date.parse('2026-08-13T12:00:00.000Z');

  test('an unbonding claim reports the gap and an estimated unlock', () => {
    const c = claimReadiness(base, 334_597, NOW);
    expect(c.ready).toBe(false);
    expect(c.epochsRemaining).toBe(2016);
    // 2016 epochs × 300 s = exactly 7 days out
    expect(c.readyAtEstimate).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
  });

  test('ready at the claim epoch, and stays ready past it', () => {
    expect(claimReadiness(base, 336_613, NOW).ready).toBe(true);
    const past = claimReadiness(base, 400_000, NOW);
    expect(past.ready).toBe(true);
    expect(past.epochsRemaining).toBe(0); // clamped, never negative
    expect(past.readyAtEstimate).toBeNull();
  });

  test('the amount is carried through verbatim — it is fixed at unstake time', () => {
    expect(claimReadiness(base, 334_597, NOW).claimAmountXrd).toBe(base.claimAmountXrd);
  });

  test('copy states the delay cannot be shortened, and flips when ready', () => {
    expect(claimCopy(claimReadiness(base, 334_597, NOW))).toMatch(/cannot be shortened/);
    expect(claimCopy(claimReadiness(base, 334_597, NOW))).toContain('~7.0 days');
    expect(claimCopy(claimReadiness(base, 336_613, NOW))).toMatch(/Ready to claim/);
  });
});

describe('readStakeClaims', () => {
  const accountNfts = (resources: Array<{ resource: string; validator?: string; ids: string[] }>) => (_body?: any) => ({
    items: [{
      non_fungible_resources: {
        items: resources.map((r) => ({
          resource_address: r.resource,
          explicit_metadata: {
            items: r.validator ? [{ key: 'validator', value: { typed: { value: r.validator } } }] : [],
          },
          vaults: { items: [{ items: r.ids }] },
        })),
      },
    }],
  });

  const nfData = (rows: Array<{ id: string; epoch?: number; amount?: string; burned?: boolean }>) => (_body?: any) => ({
    non_fungible_ids: rows.map((r) => ({
      non_fungible_id: r.id,
      is_burned: r.burned ?? false,
      data: {
        programmatic_json: {
          fields: [
            { field_name: 'name', value: 'Stake Claim' },
            { field_name: 'claim_epoch', value: String(r.epoch ?? 336_613) },
            { field_name: 'claim_amount', value: r.amount ?? '100' },
          ],
        },
      },
    })),
  });

  test('returns the account unbonding queue, soonest first', async () => {
    let call = 0;
    const gw = fakeGw({
      '/state/entity/details': (body) => {
        call += 1;
        return call === 1
          ? accountNfts([{ resource: CLAIM_NFT, validator: VALIDATOR, ids: [ID_A, ID_B] }])(body)
          : validatorStateResponse({ [VALIDATOR]: { lsu: LSU, claim: CLAIM_NFT } })(body);
      },
      '/state/non-fungible/data': nfData([
        { id: ID_A, epoch: 336_613, amount: '4516151.39' },
        { id: ID_B, epoch: 334_700, amount: '12.5' },
      ]),
    });
    const claims = await readStakeClaims(gw, ACCOUNT, Date.parse('2026-08-13T12:00:00Z'));
    expect(claims.map((c) => c.localId)).toEqual([ID_B, ID_A]); // soonest first
    expect(claims[0].epochsRemaining).toBe(101);
    expect(claims[1].claimAmountXrd).toBe('4516151.39');
    expect(claims.every((c) => c.validator === VALIDATOR)).toBe(true);
  });

  test('rejects an impostor: metadata names a validator whose real claim resource differs', async () => {
    let call = 0;
    const gw = fakeGw({
      '/state/entity/details': (body) => {
        call += 1;
        return call === 1
          // an NFT that CLAIMS to belong to VALIDATOR, but is not its claim token
          ? accountNfts([{ resource: IMPOSTOR_NFT, validator: VALIDATOR, ids: [ID_A] }])(body)
          : validatorStateResponse({ [VALIDATOR]: { lsu: LSU, claim: CLAIM_NFT } })(body);
      },
      '/state/non-fungible/data': () => {
        throw new Error('must not read data for an unverified resource');
      },
    });
    expect(await readStakeClaims(gw, ACCOUNT)).toEqual([]);
  });

  test('ignores NFTs with no validator metadata, and burned claims', async () => {
    let call = 0;
    const gw = fakeGw({
      '/state/entity/details': (body) => {
        call += 1;
        return call === 1
          ? accountNfts([
              { resource: IMPOSTOR_NFT, ids: ['#407#'] }, // a plain badge
              { resource: CLAIM_NFT, validator: VALIDATOR, ids: [ID_A, ID_B] },
            ])(body)
          : validatorStateResponse({ [VALIDATOR]: { lsu: LSU, claim: CLAIM_NFT } })(body);
      },
      '/state/non-fungible/data': nfData([
        { id: ID_A, burned: true },
        { id: ID_B, epoch: 335_000, amount: '9' },
      ]),
    });
    const claims = await readStakeClaims(gw, ACCOUNT);
    expect(claims).toHaveLength(1);
    expect(claims[0].localId).toBe(ID_B);
  });

  test('an account holding no NFTs is empty, not an error', async () => {
    const gw = fakeGw({ '/state/entity/details': () => ({ items: [{}] }) });
    expect(await readStakeClaims(gw, ACCOUNT)).toEqual([]);
  });

  test('claims from two different validators are both kept', async () => {
    let call = 0;
    const OTHER_CLAIM = 'resource_rdx1ntzkvzevv8xsp2ayaxy6euqyqflm9w76h5le2g9096ywxcgz5q7z5x';
    const gw = fakeGw({
      '/state/entity/details': (body) => {
        call += 1;
        return call === 1
          ? accountNfts([
              { resource: CLAIM_NFT, validator: VALIDATOR, ids: [ID_A] },
              { resource: OTHER_CLAIM, validator: VALIDATOR_B, ids: [ID_B] },
            ])(body)
          : validatorStateResponse({
              [VALIDATOR]: { lsu: LSU, claim: CLAIM_NFT },
              [VALIDATOR_B]: { lsu: LSU, claim: OTHER_CLAIM },
            })(body);
      },
      '/state/non-fungible/data': (body) =>
        nfData([{ id: body.non_fungible_ids[0], epoch: 335_000 }])(body),
    });
    const claims = await readStakeClaims(gw, ACCOUNT);
    expect(claims.map((c) => c.validator).sort()).toEqual([VALIDATOR_B, VALIDATOR].sort());
  });
});

describe('readStakeClaim (single, the build pre-flight)', () => {
  test('reads epoch + amount for one claim', async () => {
    const gw = fakeGw({
      '/state/non-fungible/data': () => ({
        non_fungible_ids: [{
          non_fungible_id: ID_A,
          is_burned: false,
          data: {
            programmatic_json: {
              fields: [
                { field_name: 'claim_epoch', value: '336613' },
                { field_name: 'claim_amount', value: '4516151.39' },
              ],
            },
          },
        }],
      }),
    }, 334_597);
    const c = await readStakeClaim(gw, VALIDATOR, CLAIM_NFT, ID_A);
    expect(c.ready).toBe(false);
    expect(c.epochsRemaining).toBe(2016);
    expect(c.claimAmountXrd).toBe('4516151.39');
  });

  test('an already-claimed (burned) receipt is a clear error, not a built manifest', async () => {
    const gw = fakeGw({
      '/state/non-fungible/data': () => ({
        non_fungible_ids: [{ non_fungible_id: ID_A, is_burned: true }],
      }),
    });
    await expect(readStakeClaim(gw, VALIDATOR, CLAIM_NFT, ID_A)).rejects.toThrow(/already been claimed/);
  });

  test('a missing receipt is an error', async () => {
    const gw = fakeGw({ '/state/non-fungible/data': () => ({ non_fungible_ids: [] }) });
    await expect(readStakeClaim(gw, VALIDATOR, CLAIM_NFT, ID_A)).rejects.toThrow(VenueExitError);
  });
});
