import { describe, test, expect } from 'bun:test';
import {
  LSULP_RESOURCE,
  LSU_POOL_COMPONENT,
  scanLsuPool,
} from '../src/services/lsu-pool';
import { WEFT_V2_LENDING_COMPONENT, scanWeftLending } from '../src/services/weft';
import type { GatewayClient } from '../src/services/gateway';

const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const NOW_TS = '2026-07-25T10:38:16.508Z';
const PAST_TS = '2026-06-25T10:38:15.008Z';

// ─── CaviarNine LSU Pool ──────────────────────────────────────────────────────

function lsuResponse(
  dexValuation: string,
  supply: string,
  ts: string,
  stateVersion: number,
  bind: string = LSULP_RESOURCE,
) {
  return {
    ledger_state: { state_version: stateVersion, proposer_round_timestamp: ts },
    items: [
      {
        address: LSU_POOL_COMPONENT,
        details: {
          blueprint_name: 'LsuPool',
          state: {
            fields: [
              { field_name: 'dex_valuation_xrd', value: dexValuation },
              { field_name: 'liquidity_token_resource_manager', value: bind },
            ],
          },
        },
      },
      { address: LSULP_RESOURCE, details: { total_supply: supply } },
    ],
  };
}

/// Real Gateway values from 2026-07-25, 30 days apart.
const LSU_NOW = () =>
  lsuResponse(
    '333648032.446657748312341069',
    '274010685.226637971614455961',
    NOW_TS,
    541303903,
  );
const LSU_PAST = () =>
  lsuResponse(
    '340746940.716011201503533997',
    '281207079.474015578261788773',
    PAST_TS,
    527457465,
  );

function lsuGateway(now: unknown, past: unknown): GatewayClient {
  let call = 0;
  return {
    post: async () => (call++ === 0 ? now : past),
  } as unknown as GatewayClient;
}

describe('scanLsuPool', () => {
  test('derives ~6.1% from the real on-ledger redemption ratio', async () => {
    const [pool] = await scanLsuPool(lsuGateway(LSU_NOW(), LSU_PAST()), 0.00102);
    expect(pool.protocol).toBe('caviarnine');
    // Must be 'staking', not 'amm-lp' — a single-asset wrapper cannot suffer IL,
    // and mislabelling it charges a ~12.5% haircut it can never incur.
    expect(pool.yieldKind).toBe('staking');
    expect(pool.apy).toBeGreaterThan(5.5);
    expect(pool.apy).toBeLessThan(6.7);
    // TVL = dex_valuation_xrd x XRD price.
    expect(parseFloat(pool.tvl)).toBeCloseTo(333648032.446657748 * 0.00102, 0);
    // The window must be visible: the figure genuinely depends on it.
    expect(pool.name).toContain('30d');
    // We have not verified a CaviarNine audit, so we must not assert one.
    expect(pool.audited).toBe(false);
  });

  test('publishes nothing when the pool is re-pointed at another resource', async () => {
    // The component's liquidity token moving would make our denominator wrong.
    const repointed = lsuResponse(
      '333648032.446657748312341069',
      '274010685.226637971614455961',
      NOW_TS,
      541303903,
      'resource_rdx1someotherresourceentirely',
    );
    expect(await scanLsuPool(lsuGateway(repointed, LSU_PAST()), 0.00102)).toEqual([]);
  });

  test('publishes nothing when the derived APY leaves the plausible band', async () => {
    // A wrapper over ~6% staking reading 60% means the derivation broke.
    const inflated = lsuResponse('600000000', '274010685', NOW_TS, 541303903);
    expect(await scanLsuPool(lsuGateway(inflated, LSU_PAST()), 0.00102)).toEqual([]);
  });

  test('publishes nothing when the gateway fails', async () => {
    const gw = {
      post: async () => {
        throw new Error('gateway down');
      },
    } as unknown as GatewayClient;
    expect(await scanLsuPool(gw, 0.00102)).toEqual([]);
  });

  test('publishes nothing when the ratio did not rise', async () => {
    // Monotonic by construction; a fall means a bad snapshot.
    expect(await scanLsuPool(lsuGateway(LSU_PAST(), LSU_NOW()), 0.00102)).toEqual([]);
  });
});

// ─── Weft V2 lending ──────────────────────────────────────────────────────────

const KVS = 'internal_keyvaluestore_rdx1kzjr763caq96j0kv883vy8gnf3jvrrp7dfm9zr5n0akryvzsxvyujc';
const XRD_KEY_HEX = '5c805da66318c6318c61f5a61b4c6318c6318cf794aa8d295f14e6318c6318c6';

function weftEntry(unitRatio: string, supplied: string, borrowed: string) {
  return {
    key: { raw_hex: XRD_KEY_HEX, programmatic_json: { value: XRD } },
    value: {
      programmatic_json: {
        fields: [
          {
            field_name: 'deposit_state',
            fields: [
              { field_name: 'unit_ratio', value: unitRatio },
              { field_name: 'total', value: supplied },
            ],
          },
          {
            field_name: 'loan_state',
            fields: [{ field_name: 'total', value: borrowed }],
          },
        ],
      },
    },
  };
}

function weftGateway(opts: {
  nowRatio?: string;
  pastRatio?: string;
  supplied?: string;
  borrowed?: string;
}): GatewayClient {
  const {
    // Real values from 2026-07-25 — note unit_ratio FALLS as interest accrues.
    nowRatio = '0.956419922358578018978072546008227574',
    pastRatio = '0.960012704134637741951857692671353870',
    supplied = '62694785.1856998833',
    borrowed = '44557178.8149897728',
  } = opts;
  let call = 0;
  return {
    post: async () => {
      call++;
      if (call === 1) {
        return {
          items: [
            {
              details: {
                state: { fields: [{ field_name: 'resource_pools', value: KVS }] },
              },
            },
          ],
        };
      }
      if (call === 2) {
        return { items: [{ key: { raw_hex: XRD_KEY_HEX, programmatic_json: { value: XRD } } }] };
      }
      if (call === 3) {
        return {
          ledger_state: { state_version: 541304296, proposer_round_timestamp: NOW_TS },
          entries: [weftEntry(nowRatio, supplied, borrowed)],
        };
      }
      return {
        ledger_state: { state_version: 527457733, proposer_round_timestamp: PAST_TS },
        entries: [weftEntry(pastRatio, supplied, borrowed)],
      };
    },
  } as unknown as GatewayClient;
}

describe('scanWeftLending', () => {
  test('derives ~4.7% by inverting unit_ratio', async () => {
    const [pool] = await scanWeftLending(weftGateway({}), 0.00102);
    expect(pool.protocol).toBe('weft');
    expect(pool.yieldKind).toBe('lending');
    expect(pool.apy).toBeGreaterThan(4.3);
    expect(pool.apy).toBeLessThan(5.1);
    expect(pool.name).toContain('30d');
    expect(pool.address).toBe(`weft-v2:${XRD}`);
  });

  test('refuses a pool at or above the utilization safety cap', async () => {
    // hUSDC really does sit at 93% against a 95% cap while showing the highest
    // yield of any Weft pool. That yield exists precisely because suppliers may
    // be unable to withdraw — it must never be surfaced as an opportunity.
    const distressed = weftGateway({
      supplied: '62694785.1856998833',
      borrowed: '59560045.9264148891', // 95% utilization
    });
    expect(await scanWeftLending(distressed, 0.00102)).toEqual([]);
  });

  test('refuses a pool below the TVL floor', async () => {
    const dust = weftGateway({ supplied: '1000', borrowed: '100' });
    expect(await scanWeftLending(dust, 0.00102)).toEqual([]);
  });

  test('refuses when the XRD price is unavailable rather than showing $0 TVL', async () => {
    expect(await scanWeftLending(weftGateway({}), 0)).toEqual([]);
  });

  test('refuses an implausibly high yield', async () => {
    // A large ratio move annualizes to a distress-level number.
    const spiking = weftGateway({
      nowRatio: '0.90',
      pastRatio: '0.96',
    });
    expect(await scanWeftLending(spiking, 0.00102)).toEqual([]);
  });

  test('refuses when unit_ratio moved the wrong way', async () => {
    // Rising unit_ratio means value going backwards — inverted or bad data.
    const inverted = weftGateway({
      nowRatio: '0.960012704134637741951857692671353870',
      pastRatio: '0.956419922358578018978072546008227574',
    });
    expect(await scanWeftLending(inverted, 0.00102)).toEqual([]);
  });

  test('publishes nothing when the gateway fails', async () => {
    const gw = {
      post: async () => {
        throw new Error('gateway down');
      },
    } as unknown as GatewayClient;
    expect(await scanWeftLending(gw, 0.00102)).toEqual([]);
  });

  test('resolves the key-value store from the component, never hardcoded', async () => {
    // Weft V1 runs in parallel with its own components; a hardcoded KVS could
    // silently read the wrong market after a redeploy.
    const noKvs = {
      post: async () => ({ items: [{ details: { state: { fields: [] } } }] }),
    } as unknown as GatewayClient;
    expect(await scanWeftLending(noKvs, 0.00102)).toEqual([]);
    expect(WEFT_V2_LENDING_COMPONENT).toStartWith('component_rdx1');
  });
});
