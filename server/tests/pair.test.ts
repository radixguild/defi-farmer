import { describe, test, expect } from 'bun:test';
import { isStablecoinPair } from '../src/services/pair';

/**
 * The "Stable pair" badge went out wrong on the four MOST divergent pools in the
 * index (xETH-XRD, hWBTC-XRD, XRD-hETH, XRD-hUSDC, live 2026-08-02) because the
 * API derived it from the scorer's `classification` column — a rotation
 * category whose keyword list is ['USDC','USDT','ETH','WBTC'] and which matches
 * on EITHER leg. These tests pin the actual question: are BOTH legs stable.
 */
describe('isStablecoinPair', () => {
  test('true only when both legs are stablecoins', () => {
    expect(isStablecoinPair('hUSDC-xUSDT')).toBe(true);
    expect(isStablecoinPair('USDC/DAI')).toBe(true);
  });

  test('a volatile asset against a stablecoin is NOT a stable pair', () => {
    // This is the most IL-exposed shape there is, not the least — it was the
    // single most damaging false positive.
    expect(isStablecoinPair('XRD-hUSDC')).toBe(false);
    expect(isStablecoinPair('XRD/USDT')).toBe(false);
  });

  test('blue-chip is not stable', () => {
    // The rotation classifier treated ETH and WBTC as "stable" holdings. They
    // are blue-chip; against XRD they are highly divergent.
    expect(isStablecoinPair('xETH-XRD')).toBe(false);
    expect(isStablecoinPair('hWBTC-XRD')).toBe(false);
    expect(isStablecoinPair('XRD-hETH')).toBe(false);
  });

  test('splits on BOTH delimiters', () => {
    // The server rebuilds names from on-ledger symbols as "XRD-hUSDC" while
    // Ociswap's API uses "REDDICKS/XRD". Splitting on "/" alone left
    // "XRD-hUSDC" as one token that matched "usdc" as a substring — which is
    // exactly how a volatile pair was filed as stable.
    expect(isStablecoinPair('XRD-hUSDC')).toBe(false);
    expect(isStablecoinPair('REDDICKS/XRD')).toBe(false);
  });

  test('unknown composition is not a safety claim', () => {
    expect(isStablecoinPair('')).toBe(false);
    expect(isStablecoinPair(null)).toBe(false);
    expect(isStablecoinPair(undefined)).toBe(false);
    // A name that does not resolve into two legs must not pass, even when it
    // contains a stablecoin substring.
    expect(isStablecoinPair('USDC')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isStablecoinPair('husdc-XUSDT')).toBe(true);
    expect(isStablecoinPair('HUSDC-xusdt')).toBe(true);
  });
});
