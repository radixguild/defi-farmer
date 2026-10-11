/// The validator board — Δredemption semantics.
///
/// The product-defining case: an UNCHANGED redemption rate over the window is
/// a real 0.000% (the validator keeps everything), NOT a failed measurement.
/// realized-yield.ts nulls equality because its venues always accrue; copying
/// that here would hide exactly the validators the board exists to expose.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  boardApyPct,
  fetchValidatorBoard,
  getValidatorBoard,
  _clearBoardCache,
  BOARD_TTL_MS,
  PAYS_NOTHING_BELOW_PCT,
} from '../src/services/validator-board';
import type { GatewayClient } from '../src/services/gateway';

const NOW_MS = Date.parse('2026-08-10T12:00:00Z');
const V = (n: number) => `validator_rdx1s0${String(n).padStart(3, '0')}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const LSU = (n: number) => `resource_rdx1t5${String(n).padStart(3, '0')}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

interface FakeValidator {
  address: string;
  stakeNow: string;
  stakePast?: string; // absent = not in the past list (new validator)
  supplyNow?: string;
  supplyPast?: string;
  effectiveFee?: number;
  staleFee?: number;
  name?: string;
  inactive?: boolean;
}

function fakeGateway(validators: FakeValidator[], batchLog?: number[]): GatewayClient {
  const gwValidator = (f: FakeValidator, past: boolean) => ({
    address: f.address,
    active_in_epoch: f.inactive ? null : { stake: f.stakeNow },
    stake_vault: { balance: past ? f.stakePast : f.stakeNow },
    state: {
      stake_unit_resource_address: LSU(validators.indexOf(f)),
      validator_fee_factor: f.staleFee ?? 0.01,
    },
    effective_fee_factor: { current: { fee_factor: f.effectiveFee ?? 0.01 } },
    metadata: f.name ? { items: [{ key: 'name', value: { typed: { value: f.name } } }] } : undefined,
  });

  return {
    async post(path: string, body: Record<string, unknown>) {
      const past = !!body.at_ledger_state;
      if (path === '/state/validators/list') {
        const items = validators
          .filter((f) => !past || f.stakePast !== undefined)
          .map((f) => gwValidator(f, past));
        return {
          ledger_state: {
            state_version: past ? 100 : 200,
            proposer_round_timestamp: past ? '2026-07-11T12:00:00Z' : '2026-08-10T12:00:00Z',
          },
          validators: { items },
        };
      }
      // supply batches
      const addresses = body.addresses as string[];
      batchLog?.push(addresses.length);
      return {
        items: addresses.flatMap((address) => {
          const idx = validators.findIndex((_, i) => LSU(i) === address);
          if (idx < 0) return [];
          const f = validators[idx];
          const supply = past ? f.supplyPast : f.supplyNow;
          return supply === undefined ? [] : [{ address, details: { total_supply: supply } }];
        }),
      };
    },
  } as unknown as GatewayClient;
}

beforeEach(() => _clearBoardCache());

describe('boardApyPct semantics', () => {
  test('an unchanged rate is a REAL 0.000%, never null — the DefiPlaza case', () => {
    expect(boardApyPct(1.17084116, 1.17084116, 30)).toBe(0);
  });
  test('a decrease is a measurement error (redemption is monotonic)', () => {
    expect(boardApyPct(1.15, 1.17, 30)).toBeNull();
  });
  test('normal accrual annualizes', () => {
    // +0.5243% over 30d ≈ 6.57% compounded annual (Jazzer9F's real numbers).
    const apy = boardApyPct(1.22224806, 1.21587375, 30)!;
    expect(apy).toBeGreaterThan(6.3);
    expect(apy).toBeLessThan(6.8);
  });
  test('missing either end, or a degenerate window, is null', () => {
    expect(boardApyPct(null, 1.2, 30)).toBeNull();
    expect(boardApyPct(1.2, null, 30)).toBeNull();
    expect(boardApyPct(1.2, 1.1, 0.5)).toBeNull();
  });
});

describe('fetchValidatorBoard', () => {
  test('flags the zero-payer, exposes the fee divergence, ranks payers first', async () => {
    const gw = fakeGateway([
      // Honest payer: rate 1.20 → 1.21
      { address: V(0), name: 'Honest', stakeNow: '1210000', stakePast: '1200000', supplyNow: '1000000', supplyPast: '1000000' },
      // Full-fee product: displays 0%, charges a VISIBLE 100%, rate frozen at
      // 1.17 — zero payout is what it says it does (lottery/fund/treasury).
      { address: V(1), name: 'Trap', stakeNow: '1170000', stakePast: '1170000', supplyNow: '1000000', supplyPast: '1000000', staleFee: 0, effectiveFee: 1 },
      // New validator: absent from the past list → unmeasured
      { address: V(2), name: 'Newcomer', stakeNow: '500000', supplyNow: '500000' },
      // The real anomaly: claims the default 1% fee, pays nothing.
      { address: V(3), name: 'Silent', stakeNow: '500000', stakePast: '500000', supplyNow: '500000', supplyPast: '500000' },
    ]);
    const board = await fetchValidatorBoard(gw, NOW_MS);

    expect(board.rows.map((r) => r.name)).toEqual(['Honest', 'Trap', 'Silent', 'Newcomer']);

    const trap = board.rows[1];
    expect(trap.realizedApyPct).toBe(0);
    expect(trap.paysNothing).toBe(true);
    expect(trap.staleFeePct).toBe(0);
    expect(trap.effectiveFeePct).toBe(100);
    expect(trap.feeFieldsDisagree).toBe(true);
    // A 100% effective fee means the zero is disclosed, not anomalous.
    expect(trap.zeroDisclosedByFee).toBe(true);
    // The point-in-time rate CANNOT catch this one — it accrued, then flipped.
    expect(trap.redemptionRate).toBeCloseTo(1.17, 10);

    const silent = board.rows[2];
    expect(silent.paysNothing).toBe(true);
    expect(silent.zeroDisclosedByFee).toBe(false); // 1% fee, pays 0 — the finding

    const newcomer = board.rows[3];
    expect(newcomer.realizedApyPct).toBeNull();
    expect(newcomer.paysNothing).toBe(false); // unmeasured ≠ zero-payer
    expect(newcomer.zeroDisclosedByFee).toBe(false);

    expect(board.activeZeroPayerCount).toBe(2);
    expect(board.activeZeroPayerStakeXrd).toBe(1670000);
    expect(board.activeDisclosedZeroCount).toBe(1);
    expect(board.activeDisclosedZeroStakeXrd).toBe(1170000);
    expect(board.activeAnomalousZeroCount).toBe(1);
    expect(board.activeAnomalousZeroStakeXrd).toBe(500000);
    expect(board.activeCount).toBe(4);
    expect(board.windowDays).toBeCloseTo(30, 0);
  });

  test('measured-zero outranks unmeasured in the sort', async () => {
    const gw = fakeGateway([
      { address: V(0), name: 'Unmeasured', stakeNow: '9999999', supplyNow: '9999999' },
      { address: V(1), name: 'Zero', stakeNow: '100', stakePast: '100', supplyNow: '100', supplyPast: '100' },
    ]);
    const board = await fetchValidatorBoard(gw, NOW_MS);
    expect(board.rows.map((r) => r.name)).toEqual(['Zero', 'Unmeasured']);
  });

  test('supply batches never exceed the Gateway address cap', async () => {
    const many: FakeValidator[] = Array.from({ length: 45 }, (_, i) => ({
      address: V(i), stakeNow: '100', stakePast: '99', supplyNow: '100', supplyPast: '100',
    }));
    const log: number[] = [];
    await fetchValidatorBoard(fakeGateway(many, log), NOW_MS);
    expect(log.length).toBeGreaterThan(0);
    for (const size of log) expect(size).toBeLessThanOrEqual(20);
  });

  test('a failed supply batch degrades those rows to unmeasured, not a dead board', async () => {
    const gw = fakeGateway([
      { address: V(0), name: 'A', stakeNow: '121', stakePast: '120', supplyNow: '100', supplyPast: '100' },
    ]);
    const broken = {
      async post(path: string, body: Record<string, unknown>) {
        if (path !== '/state/validators/list' && body.at_ledger_state) {
          throw new Error('Gateway 500');
        }
        return (gw as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post(path, body);
      },
    } as unknown as GatewayClient;
    const board = await fetchValidatorBoard(broken, NOW_MS);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].realizedApyPct).toBeNull();
  });
});

describe('board cache', () => {
  test('single fetch within TTL; refetch after expiry', async () => {
    let listCalls = 0;
    const base = fakeGateway([
      { address: V(0), stakeNow: '121', stakePast: '120', supplyNow: '100', supplyPast: '100' },
    ]);
    const counting = {
      async post(path: string, body: unknown) {
        if (path === '/state/validators/list') listCalls++;
        return (base as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post(path, body);
      },
    } as unknown as GatewayClient;

    await getValidatorBoard(counting, NOW_MS);
    await getValidatorBoard(counting, NOW_MS + 1000);
    expect(listCalls).toBe(2); // now + past, once

    await getValidatorBoard(counting, NOW_MS + BOARD_TTL_MS + 1);
    expect(listCalls).toBe(4);
  });

  test('PAYS_NOTHING threshold sits under real yields', () => {
    expect(PAYS_NOTHING_BELOW_PCT).toBeLessThan(1);
  });
});
