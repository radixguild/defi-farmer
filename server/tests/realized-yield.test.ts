import { describe, test, expect } from 'bun:test';
import {
  MIN_WINDOW_DAYS,
  REALIZED_WINDOW_DAYS,
  annualizedYieldPct,
  fieldByName,
  parseDecimal,
  parseLedgerState,
  windowStartIso,
  withinBand,
} from '../src/services/realized-yield';

const DAY = 86_400_000;
const NOW_MS = Date.parse('2026-07-25T10:38:16.508Z');

function snap(msAgo: number, stateVersion: number) {
  return { stateVersion, timestampMs: NOW_MS - msAgo };
}

describe('annualizedYieldPct', () => {
  test('reproduces the measured LSU Pool figure', () => {
    // Real values fetched from the Gateway on 2026-07-25 — the redemption ratio
    // dex_valuation_xrd / LSULP.total_supply, 30 days apart.
    const rNow = 333648032.446657748312341069 / 274010685.226637971614455961;
    const rPast = 340746940.716011201503533997 / 281207079.474015578261788773;
    const apy = annualizedYieldPct(
      rNow,
      rPast,
      snap(0, 541303903),
      snap(30 * DAY, 527457465),
    )!;
    // Independently brackets native staking's ~6.06%, which is the whole point:
    // a liquid wrapper over staking must return roughly the staking rate.
    expect(apy).toBeGreaterThan(5.5);
    expect(apy).toBeLessThan(6.7);
  });

  test('compounds correctly — a 1% rise over 30d annualizes above 12%', () => {
    const apy = annualizedYieldPct(1.01, 1.0, snap(0, 200), snap(30 * DAY, 100))!;
    expect(apy).toBeGreaterThan(12);
    expect(apy).toBeLessThan(13.5);
  });

  test('refuses when the historical read did not go back far enough', () => {
    // Short windows annualize discrete jumps into noise: measured, LSULP reads
    // ~8% over 7 days against a ~6% truth.
    const justUnder = (MIN_WINDOW_DAYS - 0.1) * DAY;
    expect(
      annualizedYieldPct(1.01, 1.0, snap(0, 200), snap(justUnder, 100)),
    ).toBeNull();
  });

  test('refuses when time travel silently degraded to now', () => {
    // Equal or newer state_version means the historical query returned current
    // state; the ratio would divide out to ~0% and look like a real answer.
    expect(annualizedYieldPct(1.01, 1.0, snap(0, 100), snap(30 * DAY, 100))).toBeNull();
    expect(annualizedYieldPct(1.01, 1.0, snap(0, 100), snap(30 * DAY, 101))).toBeNull();
  });

  test('refuses a non-increasing ratio, which means an inverted formula', () => {
    // Weft's unit_ratio falls as interest accrues. Passing it un-inverted lands
    // here rather than publishing a negative yield.
    expect(annualizedYieldPct(1.0, 1.01, snap(0, 200), snap(30 * DAY, 100))).toBeNull();
    expect(annualizedYieldPct(1.0, 1.0, snap(0, 200), snap(30 * DAY, 100))).toBeNull();
  });

  test('refuses zero, negative and non-finite ratios instead of defaulting', () => {
    for (const [a, b] of [
      [0, 1],
      [1, 0],
      [-1, 1],
      [NaN, 1],
      [1, NaN],
      [Infinity, 1],
    ] as const) {
      expect(annualizedYieldPct(a, b, snap(0, 200), snap(30 * DAY, 100))).toBeNull();
    }
  });
});

describe('withinBand', () => {
  test('fails closed outside the band', () => {
    expect(withinBand(6.1, 3, 10)).toBe(true);
    expect(withinBand(3, 3, 10)).toBe(true);
    expect(withinBand(10, 3, 10)).toBe(true);
    expect(withinBand(30, 3, 10)).toBe(false);
    expect(withinBand(0.2, 3, 10)).toBe(false);
    expect(withinBand(NaN, 3, 10)).toBe(false);
    expect(withinBand(-5, 3, 10)).toBe(false);
  });
});

describe('windowStartIso', () => {
  test('is exactly one window back and Gateway-formatted', () => {
    const iso = windowStartIso(NOW_MS);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const delta = NOW_MS - Date.parse(iso);
    expect(delta / DAY).toBeCloseTo(REALIZED_WINDOW_DAYS, 3);
  });
});

describe('parseLedgerState', () => {
  test('reads state version and proposer timestamp', () => {
    const s = parseLedgerState({
      ledger_state: {
        state_version: 541303903,
        proposer_round_timestamp: '2026-07-25T10:38:16.508Z',
      },
    })!;
    expect(s.stateVersion).toBe(541303903);
    expect(s.timestampMs).toBe(NOW_MS);
  });

  test('returns null on missing or malformed state', () => {
    expect(parseLedgerState({})).toBeNull();
    expect(parseLedgerState({ ledger_state: {} })).toBeNull();
    expect(
      parseLedgerState({
        ledger_state: { state_version: 1, proposer_round_timestamp: 'nope' },
      }),
    ).toBeNull();
  });
});

describe('fieldByName', () => {
  const fields = [
    { field_name: 'a', value: '1' },
    { field_name: 'unit_ratio', value: '0.9564199223585780189' },
  ];

  test('matches by name, not position', () => {
    expect(fieldByName(fields, 'unit_ratio')?.value).toBe('0.9564199223585780189');
  });

  test('returns null for absent fields and non-arrays', () => {
    expect(fieldByName(fields, 'missing')).toBeNull();
    expect(fieldByName(undefined, 'a')).toBeNull();
    expect(fieldByName({}, 'a')).toBeNull();
  });
});

describe('parseDecimal', () => {
  test('keeps full precision of a 36-digit PreciseDecimal', () => {
    const v = parseDecimal('0.956419922358578018978072546008227574');
    expect(v).toBeCloseTo(0.956419922358578, 15);
  });

  test('returns NaN for non-strings so callers fail closed', () => {
    expect(parseDecimal(undefined)).toBeNaN();
    expect(parseDecimal(null)).toBeNaN();
    expect(parseDecimal(123)).toBeNaN();
  });
});
