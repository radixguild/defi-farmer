import { describe, test, expect } from 'bun:test';
import { summarizePreview, toScaled, fromScaled } from '../src/services/dex/preview';
import type { PreviewResponse } from '../src/services/gateway';

const ACCT = 'account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const LP = 'resource_rdx1thlpxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

describe('decimal helpers (BigInt-safe, 18dp)', () => {
  test('round-trips exactly', () => {
    for (const s of ['0', '1', '-1', '38820.9', '0.000000000000000001', '-0.5', '12345.678']) {
      expect(fromScaled(toScaled(s))).toBe(s);
    }
  });
  test('sums without float error', () => {
    expect(fromScaled(toScaled('0.1') + toScaled('0.2'))).toBe('0.3');
    expect(fromScaled(toScaled('-100') + toScaled('100'))).toBe('0');
  });
});

describe('summarizePreview — the non-custodial sign-gate', () => {
  test('Succeeded → ok; nets per-resource, account-only; fee = xrd_total_*_cost sum', () => {
    const res: PreviewResponse = {
      receipt: {
        status: 'Succeeded',
        error_message: null,
        fee_summary: { xrd_total_execution_cost: '0.1', xrd_total_finalization_cost: '0.05', other: '9' },
      },
      resource_changes: [
        { index: 0, resource_changes: [
          { resource_address: XRD, component_entity: { entity_address: ACCT }, amount: '-100' },
          { resource_address: XRD, component_entity: { entity_address: 'component_pool' }, amount: '100' }, // pool — ignored
        ] },
        { index: 2, resource_changes: [
          { resource_address: LP, component_entity: { entity_address: ACCT }, amount: '5.5' },
        ] },
      ],
    };
    const r = summarizePreview(res, ACCT);
    expect(r.ok).toBe(true);
    expect(r.feeXrd).toBe('0.15'); // only xrd_total_*_cost, not 'other'
    const m = Object.fromEntries(r.movements.map((x) => [x.resource, x.amount]));
    expect(m[XRD]).toBe('-100');
    expect(m[LP]).toBe('5.5');
  });

  test('net-zero movement is dropped (withdraw + redeposit)', () => {
    const res: PreviewResponse = {
      receipt: { status: 'Succeeded' },
      resource_changes: [
        { index: 0, resource_changes: [{ resource_address: XRD, component_entity: { entity_address: ACCT }, amount: '-1' }] },
        { index: 2, resource_changes: [{ resource_address: XRD, component_entity: { entity_address: ACCT }, amount: '1' }] },
      ],
    };
    expect(summarizePreview(res, ACCT).movements).toEqual([]);
  });

  test('Failed → not ok, surfaces error (do-not-sign)', () => {
    const res: PreviewResponse = { receipt: { status: 'Failed', error_message: 'ApplicationError(PanicMessage("In shortage"))' } };
    const r = summarizePreview(res, ACCT);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ApplicationError');
    expect(r.movements).toEqual([]);
  });
});
