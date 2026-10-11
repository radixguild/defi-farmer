import { describe, test, expect } from 'bun:test';
import { parseSqliteUtc, formatSqliteUtc } from '../src/agent/loop';
import { CONFIG, MIN_RETENTION_DAYS } from '../src/config';

describe('parseSqliteUtc', () => {
  test('reads SQLite datetime as UTC, not local time', () => {
    // datetime('now') has no zone marker, so `new Date(...)` would apply the
    // host offset — 10h for the operator's box. That would put lastPersist
    // hours in the past (a burst of writes) or the future (writes stop).
    expect(parseSqliteUtc('2026-07-25 00:45:28')).toBe(Date.parse('2026-07-25T00:45:28Z'));
  });

  test('agrees with SQLite for a value at a UTC day boundary', () => {
    expect(parseSqliteUtc('2026-07-24 23:59:59')).toBe(Date.parse('2026-07-24T23:59:59Z'));
  });

  test('returns 0 for unparseable input so the caller writes now', () => {
    expect(parseSqliteUtc('not-a-timestamp')).toBe(0);
    expect(parseSqliteUtc('')).toBe(0);
  });
});

describe('formatSqliteUtc', () => {
  test('matches the shape of SQLite datetime(\'now\')', () => {
    expect(formatSqliteUtc(new Date('2026-07-25T04:23:35.912Z'))).toBe('2026-07-25 04:23:35');
  });

  test('round-trips through parseSqliteUtc', () => {
    const d = new Date('2026-07-25T04:23:35.000Z');
    expect(parseSqliteUtc(formatSqliteUtc(d))).toBe(d.getTime());
  });

  test('renders UTC regardless of host timezone', () => {
    // A batch stamped from a +10 host must not land 10h off in the DB.
    expect(formatSqliteUtc(new Date('2026-07-25T23:59:59Z'))).toBe('2026-07-25 23:59:59');
  });
});

describe('cadence config', () => {
  test('defaults persist hourly, not per scan', () => {
    expect(CONFIG.SNAPSHOT_INTERVAL_MS).toBe(3_600_000);
    expect(CONFIG.SNAPSHOT_INTERVAL_MS).toBeGreaterThan(CONFIG.SCAN_INTERVAL_MS);
  });

  test('retention outlives the longest read lookback', () => {
    // scorer.computeApyMa7d and caviarnine's APY estimate both read 7 days;
    // pruning inside that window would silently starve scoring.
    expect(CONFIG.SNAPSHOT_RETENTION_DAYS).toBeGreaterThanOrEqual(MIN_RETENTION_DAYS);
  });
});
