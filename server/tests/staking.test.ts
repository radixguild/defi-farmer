import { describe, test, expect } from 'bun:test';
import { fetchStakingStats, scanStaking, XRD_STAKING_ADDRESS } from '../src/services/staking';
import type { GatewayClient } from '../src/services/gateway';

/// Minimal GatewayClient stand-in — only `post` is exercised.
function fakeGateway(response: unknown, throws = false): GatewayClient {
  return {
    post: async () => {
      if (throws) throw new Error('gateway down');
      return response;
    },
  } as unknown as GatewayClient;
}

/**
 * A validator that earns emissions. Registered by default, because that is the
 * only kind whose stake belongs in the emission denominator — an unregistered
 * validator can hold stake and earn nothing.
 */
function validator(stake: string, fee: string, isRegistered = true) {
  return {
    address: 'validator_rdx1test',
    stake_vault: { balance: stake },
    effective_fee_factor: { current: { fee_factor: fee } },
    state: { is_registered: isRegistered },
  };
}

describe('fetchStakingStats', () => {
  test('derives gross APY as emissions / total stake', async () => {
    // 300M emission / 3B staked = 10% gross; 0% fees so net == gross.
    const gw = fakeGateway({
      validators: {
        total_count: 2,
        items: [validator('1500000000', '0'), validator('1500000000', '0')],
      },
    });
    const stats = (await fetchStakingStats(gw))!;
    expect(stats.totalStakedXrd).toBe(3_000_000_000);
    expect(stats.grossApyPercent).toBeCloseTo(10, 6);
    expect(stats.apyPercent).toBeCloseTo(10, 6);
  });

  test('nets the MEDIAN validator fee, not the stake-weighted mean', async () => {
    // Mirrors mainnet's real shape: one enormous 100%-fee treasury node beside
    // ordinary 2% validators. Stake-weighting would drag the fee toward 50%+
    // and understate what a user who picks a normal validator actually earns.
    const gw = fakeGateway({
      validators: {
        total_count: 5,
        items: [
          validator('2000000000', '1.0'), // treasury node, takes everything
          validator('250000000', '0.02'),
          validator('250000000', '0.02'),
          validator('250000000', '0.02'),
          validator('250000000', '0.02'),
        ],
      },
    });
    const stats = (await fetchStakingStats(gw))!;
    expect(stats.medianFeeFactor).toBe(0.02);
    // 300M / 3B = 10% gross, less the 2% median fee.
    expect(stats.apyPercent).toBeCloseTo(9.8, 6);
  });

  test('returns null on a short page rather than overstating APY', async () => {
    // A truncated list means a smaller denominator and so an INFLATED APY.
    // Failing closed keeps a too-good number off the screen entirely.
    const gw = fakeGateway({
      validators: { total_count: 100, items: [validator('1000000', '0')] },
    });
    expect(await fetchStakingStats(gw)).toBeNull();
  });

  test('ignores zero-stake validators', async () => {
    const gw = fakeGateway({
      validators: {
        total_count: 3,
        items: [
          validator('3000000000', '0'),
          validator('0', '0.5'),
          validator('0', '0.9'),
        ],
      },
    });
    const stats = (await fetchStakingStats(gw))!;
    expect(stats.validatorCount).toBe(1);
    expect(stats.medianFeeFactor).toBe(0);
  });

  test('excludes UNREGISTERED validators from the emission denominator', async () => {
    // Unregistered validators can hold large stake and earn nothing. Counting
    // them inflates the divisor and understates the yield. On mainnet 2026-08-02
    // this was 218.4M XRD across 61 nodes — 4.94B counted vs 4.72B earning,
    // which published 6.073% gross where the truth was 6.354%.
    const gw = fakeGateway({
      validators: {
        total_count: 2,
        items: [
          validator('3000000000', '0'),
          validator('2000000000', '0', false), // holds stake, earns nothing
        ],
      },
    });
    const stats = (await fetchStakingStats(gw))!;
    expect(stats.totalStakedXrd).toBe(3_000_000_000);
    // 300M / 3B = 10%. Including the unregistered 2B would give 6%.
    expect(stats.grossApyPercent).toBeCloseTo(10, 6);
    expect(stats.validatorCount).toBe(1);
  });

  test('the median fee is taken over ALL registered validators, not the largest', async () => {
    // A first cut at the registered filter also capped the population to the
    // top 100 by stake, on the theory that emissions go to the active set. The
    // denominator barely moved (the tail is 0.003% of stake) but the FEE median
    // did, because the biggest validators charge more: 2.00% -> 5.00%, dropping
    // the published net yield 6.227% -> 6.037%. Small, high-fee validators must
    // stay in the fee sample — a user is free to pick one.
    const items = [
      ...Array.from({ length: 3 }, () => validator('1000000000', '0.10')), // whales, expensive
      ...Array.from({ length: 4 }, () => validator('1000', '0.02')), // small, cheap
    ];
    const gw = fakeGateway({ validators: { total_count: 7, items } });
    const stats = (await fetchStakingStats(gw))!;
    expect(stats.validatorCount).toBe(7);
    expect(stats.medianFeeFactor).toBe(0.02);
  });

  test('returns null when the gateway fails', async () => {
    expect(await fetchStakingStats(fakeGateway(null, true))).toBeNull();
  });

  test('returns null on an empty validator set instead of dividing by zero', async () => {
    const gw = fakeGateway({ validators: { total_count: 0, items: [] } });
    expect(await fetchStakingStats(gw)).toBeNull();
  });
});

describe('scanStaking', () => {
  test('emits an IL-free staking opportunity with USD TVL', async () => {
    const gw = fakeGateway({
      validators: { total_count: 1, items: [validator('3000000000', '0')] },
    });
    const [pool] = await scanStaking(gw, 0.001);
    expect(pool.address).toBe(XRD_STAKING_ADDRESS);
    expect(pool.yieldKind).toBe('staking');
    expect(pool.protocol).toBe('radix');
    expect(pool.apy).toBeCloseTo(10, 6);
    // 3B XRD × $0.001
    expect(parseFloat(pool.tvl)).toBeCloseTo(3_000_000, 2);
  });

  test('reports $0 TVL rather than inventing one when the price is unknown', async () => {
    const gw = fakeGateway({
      validators: { total_count: 1, items: [validator('3000000000', '0')] },
    });
    const [pool] = await scanStaking(gw, 0);
    expect(parseFloat(pool.tvl)).toBe(0);
    // The yield itself is XRD-denominated and stays valid without a USD price.
    expect(pool.apy).toBeCloseTo(10, 6);
  });

  test('yields no opportunity when stats are unavailable', async () => {
    expect(await scanStaking(fakeGateway(null, true), 0.001)).toEqual([]);
  });
});
