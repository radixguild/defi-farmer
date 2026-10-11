/// readHoldings — the account-holdings classifier.
///
/// Pins the honesty contract: unknown resources are REPORTED, not dropped;
/// xrdValueTotal sums only convertible rows; validator LSUs convert at the
/// measured redemption rate (stake vault ÷ supply), and a validator whose
/// LSU never accrued shows rate 1.0 rather than being hidden.

import { describe, test, expect, beforeEach } from 'bun:test';
import { readHoldings, XRD_RESOURCE, isAccountAddress, WEFT_VENUE_ID } from '../src/services/holdings';
import { _clearWeftUnitCache } from '../src/services/dex/venue-exit';
import type { GatewayClient } from '../src/services/gateway';

/// The Weft deposit unit is resolved once and cached across calls, so every
/// test must start from a cold cache or the first one to run decides the rest.
beforeEach(() => _clearWeftUnitCache());

const ACCOUNT = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';
const LSU = 'resource_rdx1t5x9fx6vjyk5x77vtqtzchxdlk5p9hgp8vpz8v3s0dzdu0dmps58pu';
const VALIDATOR = 'validator_rdx1s0lz5v68gtqwswu7lrx9yrjte4ts0l2saphmplsz68nsv2aux0xvfq';
const LSULP = 'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf';
const POOL_LP = 'resource_rdx1t5poolunitbasicorweighted0aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL = 'pool_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky';
const MYSTERY = 'resource_rdx1tmysterymemetoken0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Vaultish {
  fungible_resources: {
    items: Array<{ resource_address: string; vaults: { items: Array<{ amount: string }> } }>;
  };
}

/// Minimal fake Gateway: balances + resource metadata + validator vaults.
function fakeGateway(opts: {
  balances: Array<{ resourceAddress: string; amount: string }>;
  resourceMeta?: Record<string, { meta?: Record<string, string>; supply?: string }>;
  validatorStake?: Record<string, string>;
  /// Weft deposit unit the component chain resolves to. Omit to make the whole
  /// Weft lookup fail, which is the fail-open case worth testing.
  weftDepositUnit?: string;
}): GatewayClient {
  const KVS = 'internal_keyvaluestore_rdx1krweft0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return {
    async getAccountBalances() {
      return opts.balances;
    },
    async entityDetailsGlobal(addresses: string[]) {
      return {
        items: addresses.map((address) => {
          const r = opts.resourceMeta?.[address] ?? {};
          return {
            address,
            details: { total_supply: r.supply },
            metadata: {
              items: Object.entries(r.meta ?? {}).map(([key, value]) => ({
                key,
                value: { typed: { value } },
              })),
            },
          };
        }),
      };
    },
    async post(path: string, body: unknown) {
      // ── the Weft deposit-unit chain: component → resource_pools KVS → entry ──
      if (opts.weftDepositUnit) {
        if (path === '/state/key-value-store/keys') {
          return {
            items: [
              { key: { raw_hex: 'deadbeef', programmatic_json: { value: XRD_RESOURCE } } },
            ],
          };
        }
        if (path === '/state/key-value-store/data') {
          return {
            entries: [
              {
                value: {
                  programmatic_json: {
                    fields: [
                      { field_name: 'deposit_unit_res_address', value: opts.weftDepositUnit },
                    ],
                  },
                },
              },
            ],
          };
        }
        const addrs = (body as { addresses?: string[] }).addresses ?? [];
        if (addrs.some((a) => a.startsWith('component_'))) {
          return {
            items: [
              {
                address: addrs[0],
                details: { state: { fields: [{ field_name: 'resource_pools', value: KVS }] } },
              },
            ],
          };
        }
      }

      // Batch 3 — validator stake vaults (Vault aggregation).
      const addresses = (body as { addresses: string[] }).addresses;
      return {
        items: addresses.map((address): Vaultish & { address: string } => {
          const stake = opts.validatorStake?.[address];
          return {
            address,
            fungible_resources: {
              items:
                stake === undefined
                  ? [] // validator exposes no XRD vault at all → unpriceable
                  : [
                      {
                        resource_address: XRD_RESOURCE,
                        vaults: {
                          // A smaller pending/locked vault rides along — the
                          // stake vault dominates and max() must select it.
                          items: [{ amount: stake }, { amount: '17.5' }],
                        },
                      },
                    ],
            },
          };
        }),
      };
    },
  } as unknown as GatewayClient;
}

describe('readHoldings', () => {
  test('classifies XRD, validator LSU, LSULP, pool LP and unknown in one pass', async () => {
    const gw = fakeGateway({
      balances: [
        { resourceAddress: XRD_RESOURCE, amount: '1000' },
        { resourceAddress: LSU, amount: '100' },
        { resourceAddress: LSULP, amount: '50' },
        { resourceAddress: POOL_LP, amount: '7' },
        { resourceAddress: MYSTERY, amount: '9999' },
      ],
      resourceMeta: {
        [LSU]: { meta: { validator: VALIDATOR, name: 'Liquid Stake Units' }, supply: '1000000' },
        [LSULP]: { meta: { symbol: 'LSULP', name: 'LSU Pool LP' } },
        [POOL_LP]: { meta: { pool: POOL, symbol: 'OCI-LP' } },
        [MYSTERY]: { meta: { symbol: 'MOON' } },
      },
      validatorStake: { [VALIDATOR]: '1220000' }, // rate = 1.22
    });

    const r = await readHoldings(gw, ACCOUNT);
    const byKind = Object.fromEntries(r.holdings.map((h) => [h.kind, h]));

    expect(r.holdings).toHaveLength(5);
    expect(byKind['xrd'].xrdValue).toBe(1000);

    const stake = byKind['validator-stake'];
    expect(stake.detail).toBe(VALIDATOR);
    expect(stake.redemptionRate).toBeCloseTo(1.22, 10);
    expect(stake.xrdValue).toBeCloseTo(122, 8);

    expect(byKind['lsulp'].xrdValue).toBeNull();
    expect(byKind['pool-lp'].detail).toBe(POOL);
    expect(byKind['unknown'].label).toBe('MOON');
    // The honesty contract: the mystery token is present with its raw amount…
    expect(byKind['unknown'].amount).toBe('9999');
    // …and the total refuses to pretend it valued what it could not.
    expect(r.xrdValueTotal).toBeCloseTo(1122, 6);
    expect(r.unconvertibleCount).toBe(3);
  });

  test('a validator that never accrued shows redemptionRate 1.0, not nothing', async () => {
    const gw = fakeGateway({
      balances: [{ resourceAddress: LSU, amount: '100' }],
      resourceMeta: { [LSU]: { meta: { validator: VALIDATOR }, supply: '500' } },
      validatorStake: { [VALIDATOR]: '500' },
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings[0].redemptionRate).toBe(1);
    expect(r.holdings[0].xrdValue).toBe(100);
  });

  test('a validator read that returns no stake yields xrdValue null — never 0', async () => {
    // "This LSU is worth 0" and "we could not price this LSU" must be
    // distinguishable: 0 would read as a total loss.
    const gw = fakeGateway({
      balances: [{ resourceAddress: LSU, amount: '100' }],
      resourceMeta: { [LSU]: { meta: { validator: VALIDATOR }, supply: '500' } },
      validatorStake: {},
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings[0].xrdValue).toBeNull();
    expect(r.unconvertibleCount).toBe(1);
  });

  test('zero balances are filtered; an empty account is an empty result, not an error', async () => {
    const gw = fakeGateway({
      balances: [{ resourceAddress: MYSTERY, amount: '0' }],
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings).toHaveLength(0);
    expect(r.xrdValueTotal).toBe(0);
  });

  // ── Weft V2 deposit units ──────────────────────────────────────────────────
  // Identified by resolving Weft's OWN component chain, never by symbol: a
  // scam token can call itself w2-XRD, and the consequence of believing it is
  // an Exit button that builds a withdraw against the wrong resource.
  const W2_XRD = 'resource_rdx1th0weftdepositunit0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  test('a Weft deposit unit is classified and carries the venue id it exits through', async () => {
    const gw = fakeGateway({
      balances: [{ resourceAddress: W2_XRD, amount: '250' }],
      resourceMeta: { [W2_XRD]: { meta: { symbol: 'w2-XRD' } } },
      weftDepositUnit: W2_XRD,
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings).toHaveLength(1);
    expect(r.holdings[0].kind).toBe('weft-lending');
    // detail must be exactly what detectVenue() matches, so the UI can hand it
    // straight back as poolAddress.
    expect(r.holdings[0].detail).toBe(WEFT_VENUE_ID);
    expect(r.holdings[0].amount).toBe('250');
    // unit_ratio is not read here, so the value is unknown — never 0, never
    // silently assumed to be parity with XRD.
    expect(r.holdings[0].xrdValue).toBeNull();
    expect(r.xrdValueTotal).toBe(0);
    expect(r.unconvertibleCount).toBe(1);
  });

  test('an impostor token with the same symbol is NOT classified as Weft', async () => {
    const gw = fakeGateway({
      balances: [{ resourceAddress: MYSTERY, amount: '999' }],
      resourceMeta: { [MYSTERY]: { meta: { symbol: 'w2-XRD' } } },
      weftDepositUnit: W2_XRD, // the real one, which MYSTERY is not
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings[0].kind).toBe('unknown');
    expect(r.holdings[0].detail).toBeNull();
  });

  test('an unresolvable Weft lookup degrades to unknown, never to a failed read', async () => {
    // The classifier gained a fourth network dependency; a holdings read must
    // not start failing because Weft is unreachable. The row keeps its amount.
    const gw = fakeGateway({
      balances: [
        { resourceAddress: W2_XRD, amount: '250' },
        { resourceAddress: XRD_RESOURCE, amount: '10' },
      ],
      // weftDepositUnit omitted → the component chain cannot resolve
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings).toHaveLength(2);
    const w2 = r.holdings.find((h) => h.resource === W2_XRD)!;
    expect(w2.kind).toBe('unknown');
    expect(w2.amount).toBe('250');
    // The rest of the pass is unaffected.
    expect(r.holdings.find((h) => h.resource === XRD_RESOURCE)!.xrdValue).toBe(10);
  });

  test('rejects a non-account address before any gateway call', async () => {
    const gw = fakeGateway({ balances: [] });
    await expect(readHoldings(gw, 'component_rdx1notanaccount0aaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(
      'Invalid account address',
    );
    expect(isAccountAddress(ACCOUNT)).toBe(true);
    expect(isAccountAddress('validator_rdx1abcdefabcdefabcdefabcdefabcdef')).toBe(false);
  });

  test('rows sort convertible-value first so staking leads the view', async () => {
    const gw = fakeGateway({
      balances: [
        { resourceAddress: MYSTERY, amount: '1' },
        { resourceAddress: LSU, amount: '100' },
        { resourceAddress: XRD_RESOURCE, amount: '5' },
      ],
      resourceMeta: { [LSU]: { meta: { validator: VALIDATOR }, supply: '100' } },
      validatorStake: { [VALIDATOR]: '120' },
    });
    const r = await readHoldings(gw, ACCOUNT);
    expect(r.holdings.map((h) => h.kind)).toEqual(['validator-stake', 'xrd', 'unknown']);
  });
});

describe('getAccountBalances — real Gateway envelope', () => {
  // The 2026-08-10 regression class: unit tests that mock getAccountBalances
  // itself can never catch a wrong read of the Gateway envelope. This one
  // mocks at the POST boundary with the real response shape — balances nest
  // under items[0], and only Global aggregation carries per-resource amounts.
  test('parses items[0].fungible_resources and requests Global aggregation', async () => {
    const { GatewayClient } = await import('../src/services/gateway');
    const gw = new GatewayClient();
    const captured: { body?: Record<string, unknown> } = {};
    (gw as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post =
      async (_p: string, body: unknown) => {
        captured.body = body as Record<string, unknown>;
        return {
          items: [
            {
              address: ACCOUNT,
              fungible_resources: {
                items: [
                  { resource_address: XRD_RESOURCE, amount: '6551.32' },
                  { resource_address: MYSTERY, amount: '9999' },
                  { resource_address: 'resource_rdx1malformed_no_amount' },
                ],
              },
            },
          ],
        };
      };
    const balances = await gw.getAccountBalances(ACCOUNT);
    expect(captured.body?.aggregation_level).toBe('Global');
    expect(balances).toEqual([
      { resourceAddress: XRD_RESOURCE, amount: '6551.32' },
      { resourceAddress: MYSTERY, amount: '9999' },
    ]);
  });

  test('an empty envelope yields [], not a crash', async () => {
    const { GatewayClient } = await import('../src/services/gateway');
    const gw = new GatewayClient();
    (gw as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post =
      async () => ({ items: [] });
    expect(await gw.getAccountBalances(ACCOUNT)).toEqual([]);
  });
});
