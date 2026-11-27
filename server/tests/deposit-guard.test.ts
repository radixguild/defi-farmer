import { describe, test, expect, beforeEach } from 'bun:test';
import {
  decimalPlaces, assertFitsDivisibility, minimumDepositRefusal, readDivisibility,
  refuseBelowMinimum, checkDepositAmounts, DepositAmountError, MIN_DEPOSIT_XRD,
  _clearDivisibilityCache,
} from '../src/services/dex/deposit-guard';
import type { GatewayClient, GwEntityItem } from '../src/services/gateway';
import type { PreviewResult } from '../src/services/dex/preview';
import { XRD, fungibleItem } from './deposit-stub';

const BTC8 = 'resource_rdx1tbtceightdecimalsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const WHOLE0 = 'resource_rdx1twholeunitsonlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const NFT = 'resource_rdx1nnonfungiblexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function gwWith(items: Record<string, GwEntityItem>, opts: { fail?: boolean } = {}) {
  const gw = {
    reads: [] as string[][],
    async entityDetailsGlobal(addresses: string[]) {
      gw.reads.push(addresses);
      if (opts.fail) throw new Error('gateway down');
      return { items: addresses.filter((a) => items[a]).map((a) => items[a]) };
    },
  };
  return gw as unknown as GatewayClient & { reads: string[][] };
}

const leg = (resource: string, amount: string, label = 'amountX') => ({ resource, amount, label });

beforeEach(() => _clearDivisibilityCache());

describe('decimalPlaces', () => {
  test('counts only significant fractional digits', () => {
    expect(decimalPlaces('5')).toBe(0);
    expect(decimalPlaces('5.0')).toBe(0);
    expect(decimalPlaces('1.50')).toBe(1);
    expect(decimalPlaces('0.00000001')).toBe(8);
    expect(decimalPlaces('0.000000000000000001')).toBe(18);
  });
});

describe('assertFitsDivisibility — rejects, never rounds', () => {
  test('divisibility 8: 8 places pass, 9 places are refused', () => {
    expect(() => assertFitsDivisibility(leg(BTC8, '0.00000001'), 8)).not.toThrow();
    expect(() => assertFitsDivisibility(leg(BTC8, '1.12345678'), 8)).not.toThrow();
    expect(() => assertFitsDivisibility(leg(BTC8, '1.123456780'), 8)).not.toThrow(); // trailing zero
    expect(() => assertFitsDivisibility(leg(BTC8, '0.000000001'), 8)).toThrow(DepositAmountError);
    expect(() => assertFitsDivisibility(leg(BTC8, '1.123456789'), 8)).toThrow(/at most 8 decimal places/);
  });

  test('divisibility 0: whole units only', () => {
    expect(() => assertFitsDivisibility(leg(WHOLE0, '5'), 0)).not.toThrow();
    expect(() => assertFitsDivisibility(leg(WHOLE0, '5.0'), 0)).not.toThrow();
    expect(() => assertFitsDivisibility(leg(WHOLE0, '5.5'), 0)).toThrow(/whole units only/);
    expect(() => assertFitsDivisibility(leg(WHOLE0, '0.1'), 0)).toThrow(DepositAmountError);
  });

  test('divisibility 18: the full engine precision passes', () => {
    expect(() => assertFitsDivisibility(leg(XRD, '0.000000000000000001'), 18)).not.toThrow();
  });

  test('the message says nothing was rounded and names the leg', () => {
    expect(() => assertFitsDivisibility(leg(BTC8, '0.000000001', 'amountY'), 8))
      .toThrow(/amountY 0\.000000001 is finer than this token allows.*nothing was rounded/);
  });
});

describe('minimumDepositRefusal — XRD legs', () => {
  test(`the minimum is ${MIN_DEPOSIT_XRD} XRD`, () => {
    expect(MIN_DEPOSIT_XRD).toBe('10');
  });

  test('boundary: exactly the minimum passes; one smallest unit below is refused', () => {
    expect(minimumDepositRefusal([leg(XRD, '10')])).toBeUndefined();
    expect(minimumDepositRefusal([leg(XRD, '10.000000000000000001')])).toBeUndefined();
    expect(minimumDepositRefusal([leg(XRD, '9.999999999999999999')])).toMatch(/minimum deposit is 10 XRD/);
    expect(minimumDepositRefusal([leg(XRD, '0.000000000000000001')])).toMatch(/minimum deposit is 10 XRD/);
  });

  test('a deposit that sends no XRD is refused (no value the server can state)', () => {
    expect(minimumDepositRefusal([leg(BTC8, '1')])).toMatch(/sends no XRD/);
    expect(minimumDepositRefusal([leg(BTC8, '1'), leg(XRD, '0', 'amountY')])).toMatch(/sends no XRD/);
  });

  test('every non-zero XRD leg must meet it', () => {
    expect(minimumDepositRefusal([leg(XRD, '100'), leg(BTC8, '0.1', 'amountY')])).toBeUndefined();
    expect(minimumDepositRefusal([leg(XRD, '100'), leg(XRD, '1', 'coAmount')])).toMatch(/coAmount is 1/);
  });
});

describe('readDivisibility — from the ledger, fail closed', () => {
  test('XRD needs no read; other tokens are read in one batch and cached', async () => {
    const gw = gwWith({ [BTC8]: fungibleItem(BTC8, 8), [WHOLE0]: fungibleItem(WHOLE0, 0) });
    expect((await readDivisibility(gw, [XRD])).get(XRD)).toBe(18);
    expect(gw.reads).toEqual([]);
    const d = await readDivisibility(gw, [XRD, BTC8, WHOLE0]);
    expect(d.get(BTC8)).toBe(8);
    expect(d.get(WHOLE0)).toBe(0);
    expect(gw.reads).toEqual([[BTC8, WHOLE0]]);
    await readDivisibility(gw, [BTC8]);
    expect(gw.reads.length).toBe(1); // cached
  });

  test('missing, non-fungible, out-of-range or unreadable → refused', async () => {
    await expect(readDivisibility(gwWith({}), [BTC8])).rejects.toBeInstanceOf(DepositAmountError);
    await expect(
      readDivisibility(gwWith({ [NFT]: { address: NFT, details: { type: 'NonFungibleResource' } } as GwEntityItem }), [NFT]),
    ).rejects.toThrow(/divisibility/);
    await expect(readDivisibility(gwWith({ [BTC8]: fungibleItem(BTC8, 19) }), [BTC8])).rejects.toThrow(/divisibility/);
    await expect(readDivisibility(gwWith({}, { fail: true }), [BTC8])).rejects.toThrow(/try again/);
  });
});

describe('checkDepositAmounts', () => {
  const gw = () => gwWith({ [BTC8]: fungibleItem(BTC8, 8), [WHOLE0]: fungibleItem(WHOLE0, 0) });

  test('zero legs are skipped; all-zero is refused', async () => {
    await expect(checkDepositAmounts(gw(), [leg(XRD, '0'), leg(BTC8, '0', 'amountY')])).rejects.toThrow(/greater than zero/);
    await expect(checkDepositAmounts(gw(), [leg(XRD, '10'), leg(BTC8, '0', 'amountY')])).resolves.toBeUndefined();
  });

  test('the minimum is checked before any ledger read', async () => {
    const g = gw();
    await expect(checkDepositAmounts(g, [leg(XRD, '1'), leg(BTC8, '0.1', 'amountY')])).rejects.toThrow(/minimum/);
    expect(g.reads).toEqual([]);
  });

  test('divisibility applies to every non-zero leg', async () => {
    await expect(checkDepositAmounts(gw(), [leg(XRD, '10'), leg(WHOLE0, '2.5', 'amountY')])).rejects.toThrow(/whole units only/);
    await expect(checkDepositAmounts(gw(), [leg(XRD, '10'), leg(WHOLE0, '2', 'amountY')])).resolves.toBeUndefined();
  });
});

describe('refuseBelowMinimum — the dry-run XRD outflow', () => {
  const ACCT_PREVIEW = (xrd?: string): PreviewResult => ({
    ok: true, status: 'Succeeded',
    movements: xrd === undefined ? [] : [{ resource: XRD, amount: xrd }],
  });

  test('net outflow at the minimum passes unchanged', () => {
    const p = ACCT_PREVIEW('-10');
    expect(refuseBelowMinimum(p)).toBe(p);
  });

  test('a ratio pool that hands most of the XRD back is refused', () => {
    const r = refuseBelowMinimum(ACCT_PREVIEW('-0.5'));
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Refused');
    expect(r.error).toContain('0.5 XRD');
    expect(r.error!.length).toBeLessThan(280); // the modal truncates at 280
  });

  test('no XRD movement at all is refused', () => {
    expect(refuseBelowMinimum(ACCT_PREVIEW()).ok).toBe(false);
  });

  test('a preview that already failed keeps its own error', () => {
    const failed: PreviewResult = { ok: false, status: 'Failed', error: 'boom', movements: [] };
    expect(refuseBelowMinimum(failed)).toBe(failed);
  });
});
