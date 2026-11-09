import { describe, test, expect } from 'bun:test';
import { summarizePreview, refuseLsulpPartFill, toScaled, fromScaled, type PreviewResult } from '../src/services/dex/preview';
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

describe('refuseLsulpPartFill — pure gate', () => {
  const ok = (amt?: string): PreviewResult => ({
    ok: true, status: 'Succeeded', movements: amt ? [{ resource: LP, amount: amt }] : [],
  });
  test('exact spend passes; over-spend passes (never refuses a full fill)', () => {
    expect(refuseLsulpPartFill(ok('-500'), LP, '500').ok).toBe(true);
    expect(refuseLsulpPartFill(ok('-500.5'), LP, '500').ok).toBe(true);
  });
  test('net spend below the request is refused and names the returned amount', () => {
    const r = refuseLsulpPartFill(ok('-1.9314'), LP, '500');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Refused');
    expect(r.error).toContain('498.0686');
  });
  test('no movement for the resource is refused', () => {
    expect(refuseLsulpPartFill(ok(), LP, '1').ok).toBe(false);
  });
  test('a different resource moving does not count as LSULP spent', () => {
    const p: PreviewResult = { ok: true, status: 'Succeeded', movements: [{ resource: XRD, amount: '-500' }] };
    expect(refuseLsulpPartFill(p, LP, '500').ok).toBe(false);
  });
  test('already-failed previews pass through unchanged', () => {
    const f: PreviewResult = { ok: false, status: 'Failed', error: 'x', movements: [] };
    expect(refuseLsulpPartFill(f, LP, '1')).toBe(f);
  });
});
