/**
 * Pair composition — the single definition of "is this a stablecoin pair".
 *
 * This exists because the API served a `is_stable` flag derived from the
 * scorer's `classification` column, and the UI rendered it as a "Stable pair"
 * badge. Those are different questions and the answer was wrong on the pools it
 * mattered most for.
 *
 * `classification` is a ROTATION category. Its keyword list is
 * `['USDC','USDT','ETH','WBTC']` and the scorer's own comment next to it says
 * "ETH/WBTC are blue-chip, not stable" — it means "a holding we don't rotate
 * out of", not "a pair with no divergence risk". It also matches on EITHER leg,
 * so XRD-hUSDC classified as stable: a volatile asset against a stablecoin,
 * which is the MOST impermanent-loss-exposed shape there is, not the least.
 * Live on 2026-08-02 that badge appeared on xETH-XRD, hWBTC-XRD, XRD-hETH and
 * XRD-hUSDC — the four most divergent pools in the index.
 *
 * The rule below is the one the Discover page already applied correctly:
 * BOTH legs must be stablecoins.
 */

const STABLES = ['usdc', 'usdt', 'xusd', 'husd', 'dai'];

/**
 * True only when every leg of the pair is a stablecoin.
 *
 * Splits on BOTH delimiters: this server rebuilds names from on-ledger symbols
 * as "XRD-hUSDC" while Ociswap's API uses "REDDICKS/XRD". Splitting on "/" alone
 * leaves "XRD-hUSDC" as a single token that matches "usdc" as a substring — the
 * exact bug that filed a volatile XRD pair as a stablecoin pair.
 *
 * A name that does not resolve into at least two legs returns false: unknown
 * composition is not a safety claim.
 */
export function isStablecoinPair(poolName: string | null | undefined): boolean {
  if (!poolName) return false;
  const parts = poolName
    .toLowerCase()
    .split(/[/\-]/)
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => STABLES.some((s) => p.includes(s)));
}
