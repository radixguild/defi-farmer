import { describe, test, expect, beforeEach } from 'bun:test';
import {
  classifySourceError,
  getPublicSourceHealth,
  getSourceHealth,
  recordSourceOutcome,
  resetSourceHealthForTests,
  SourceError,
} from '../src/services/source-health';
import { isDiscoverable, splitDiscoverable, venueStatus } from '../src/services/venue-status';

beforeEach(() => resetSourceHealthForTests());

describe('source health', () => {
  test('rows > 0 is ok; zero rows is the silent failure, recorded as empty', () => {
    recordSourceOutcome('ociswap', { rows: 120 }, 1);
    recordSourceOutcome('weft', { rows: 0 }, 2);
    const h = getSourceHealth();
    expect(h.ociswap).toMatchObject({ ok: true, lastSuccessAt: 1, lastRows: 120 });
    expect(h.weft).toMatchObject({ ok: false, lastErrorAt: 2, lastErrorKind: 'empty', lastSuccessAt: null });
  });

  test('a failure after a success keeps lastSuccessAt', () => {
    recordSourceOutcome('ociswap', { rows: 5 }, 1);
    recordSourceOutcome('ociswap', { error: new Error('Ociswap /pools 503') }, 2);
    expect(getSourceHealth().ociswap).toMatchObject({
      ok: false, lastSuccessAt: 1, lastErrorAt: 2, lastErrorKind: 'http_status',
    });
  });

  test('public shape carries the kind but never the raw failure text (DF-8)', () => {
    recordSourceOutcome('defiplaza', { error: new Error('GET https://internal.example/x returned 500') }, 3);
    const pub = getPublicSourceHealth();
    expect(pub.defiplaza.lastErrorKind).toBe('http_status');
    expect(JSON.stringify(pub)).not.toContain('internal.example');
    expect((pub.defiplaza as Record<string, unknown>).lastError).toBeUndefined();
    expect(getSourceHealth().defiplaza.lastError).toContain('internal.example');
  });

  test('classifies errors coarsely', () => {
    expect(classifySourceError(new SourceError('empty', 'x'))).toBe('empty');
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifySourceError(abort)).toBe('timeout');
    expect(classifySourceError(new SyntaxError('Unexpected token < in JSON'))).toBe('bad_response');
    expect(classifySourceError(new Error('DefiPlaza stats API returned 404'))).toBe('http_status');
    expect(classifySourceError(new Error('boom'))).toBe('error');
  });
});

describe('venue status', () => {
  test('CaviarNine (incl. its LSU Pool) is exit-only and Weft is unverified', () => {
    expect(venueStatus('caviarnine')?.status).toBe('exit-only');
    expect(venueStatus('CaviarNine')?.status).toBe('exit-only');
    expect(venueStatus('weft')?.status).toBe('unverified');
    expect(isDiscoverable('caviarnine')).toBe(false);
    expect(isDiscoverable('weft')).toBe(false);
  });

  test('live venues stay discoverable', () => {
    for (const p of ['ociswap', 'radix', 'defiplaza']) expect(isDiscoverable(p)).toBe(true);
  });

  test('every entry cites a public https source', () => {
    for (const p of ['caviarnine', 'weft']) {
      expect(venueStatus(p)!.source).toMatch(/^https:\/\//);
    }
  });

  test('splitDiscoverable keeps live venues and drops CaviarNine pools, the LSU Pool and Weft', () => {
    const scanned = [
      { address: 'a', protocol: 'ociswap' },
      { address: 'b', protocol: 'radix' },
      { address: 'c', protocol: 'caviarnine' }, // DEX pool
      { address: 'd', protocol: 'caviarnine' }, // LSU Pool (LSULP) row
      { address: 'e', protocol: 'weft' },
    ];
    const { discoverable, excluded } = splitDiscoverable(scanned);
    expect(discoverable.map((p) => p.address)).toEqual(['a', 'b']);
    expect(excluded.map((p) => p.address)).toEqual(['c', 'd', 'e']);
  });
});
