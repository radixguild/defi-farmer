import { describe, test, expect } from 'bun:test';
import { scanDefiPlaza } from '../src/services/defiplaza';

function mockGateway(overrides: {
  componentState?: unknown;
  batchDetails?: unknown;
  xrdPrice?: number;
  shouldThrow?: boolean;
} = {}) {
  return {
    getComponentState: async () => {
      if (overrides.shouldThrow) throw new Error('Gateway down');
      return overrides.componentState ?? { items: [] };
    },
    batchEntityDetails: async () => {
      return overrides.batchDetails ?? { items: [] };
    },
    getXrdUsdPrice: async () => {
      return overrides.xrdPrice ?? 0.05;
    },
    // Other methods not used by scanDefiPlaza
    scanPools: async () => [],
    getCurrentEpoch: async () => 1,
    getAccountBalances: async () => [],
    submitTransaction: async () => ({ intentHash: '', duplicate: false }),
    waitForCommit: async () => ({ status: 'Unknown' as const, epoch: 0, events: [] }),
    getTransactionDetails: async () => ({ balanceChanges: [], events: [] }),
  } as unknown as Parameters<typeof scanDefiPlaza>[0];
}

describe('scanDefiPlaza', () => {
  test('returns empty array when no pairs found', async () => {
    const gateway = mockGateway({ componentState: { items: [] } });
    const pools = await scanDefiPlaza(gateway);
    expect(pools).toEqual([]);
  });

  test('all returned pools have protocol: defiplaza and audited: true', async () => {
    const gateway = mockGateway({
      componentState: {
        items: [
          {
            details: {
              state: {
                fields: [
                  {
                    field_name: 'pairs',
                    entries: [
                      { key: { value: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky' } },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
      batchDetails: {
        items: [
          {
            address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
            fungible_resources: {
              items: [
                {
                  resource_address: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
                  vaults: { items: [{ amount: '50000' }] },
                },
                {
                  resource_address: 'resource_rdx1token2',
                  vaults: { items: [{ amount: '1000' }] },
                },
              ],
            },
            metadata: {
              items: [{ key: 'name', value: { typed: { value: 'XRD-TOKEN Pair' } } }],
            },
          },
        ],
      },
      xrdPrice: 0.05,
    });

    const pools = await scanDefiPlaza(gateway);
    expect(pools.length).toBe(1);
    expect(pools[0].protocol).toBe('defiplaza');
    expect(pools[0].audited).toBe(true);
  });

  test('falls back gracefully when gateway throws', async () => {
    // Both gateway and fallback will fail (no real network), should return []
    const gateway = mockGateway({ shouldThrow: true });
    const pools = await scanDefiPlaza(gateway);
    expect(pools).toEqual([]);
  });

  test('returned PoolInfo has correct shape', async () => {
    const gateway = mockGateway({
      componentState: {
        items: [
          {
            details: {
              state: {
                fields: [
                  {
                    field_name: 'pairs',
                    entries: [
                      { key: { value: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky' } },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
      batchDetails: {
        items: [
          {
            address: 'component_rdx1cq0kkun8x09jwwgkfp3gpcxds4uv9xedpz05c6f9whapkc9arefvky',
            fungible_resources: {
              items: [
                {
                  resource_address: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
                  vaults: { items: [{ amount: '10000' }] },
                },
              ],
            },
            metadata: { items: [] },
          },
        ],
      },
      xrdPrice: 0.05,
    });

    const pools = await scanDefiPlaza(gateway);
    expect(pools.length).toBe(1);
    const pool = pools[0];
    expect(typeof pool.address).toBe('string');
    expect(typeof pool.name).toBe('string');
    expect(typeof pool.tvl).toBe('string');
    expect(typeof pool.apy).toBe('number');
    expect(pool.apySource).toBeDefined();
  });
});
