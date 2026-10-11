/// CaviarNine LSU Pool (LSULP) — the largest single DeFi venue on Radix, and
/// IL-free.
///
/// LSULP is a liquid wrapper over staked XRD: holders receive a token whose XRD
/// redemption value only rises, as the pool's underlying LSUs accrue staking
/// emissions. There is no second asset, so there is no impermanent loss.
///
/// No vendor API is involved. CaviarNine's public API is effectively gone
/// (api.caviarnine.com 502s, api-core's v1 prefix 403s, and www.caviarnine.com
/// is now a holding page), and the one reachable stats path exposes no APY —
/// on one sibling product it reports a TVL of ~$1.8 TRILLION, so it could not
/// be trusted anyway. Everything below is derived from the ledger.
///
/// The yield is the realized drift of the redemption ratio:
///     R = dex_valuation_xrd / LSULP.total_supply
/// measured across a fixed trailing window (see realized-yield.ts). Verified
/// 2026-07-25: R rose 1.211729595689 -> 1.217646064316 over 30.0000 days,
/// giving 6.1052%/yr — which independently brackets the ~6.06% native staking
/// rate computed from validator state in staking.ts. Two unrelated derivations
/// agreeing is the strongest evidence available that both are right.
///
/// As with native staking, this yield is denominated in XRD. The holder earns
/// more XRD and keeps full XRD price exposure; it is not a USD return.

import type { GatewayClient, PoolInfo } from './gateway.js';
import {
  REALIZED_WINDOW_DAYS,
  annualizedYieldPct,
  fieldByName,
  parseDecimal,
  parseLedgerState,
  windowStartIso,
  withinBand,
} from './realized-yield.js';

export const LSU_POOL_COMPONENT =
  'component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp';
export const LSULP_RESOURCE =
  'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf';

/// A liquid wrapper over ~6% native staking cannot legitimately read far from
/// it. Anything outside this band means the derivation broke, so publish nothing.
const MIN_PLAUSIBLE_APY = 3;
const MAX_PLAUSIBLE_APY = 10;

interface EntityDetailsResponse {
  ledger_state?: unknown;
  items?: Array<{
    address?: string;
    details?: {
      blueprint_name?: string;
      total_supply?: string;
      state?: { fields?: unknown };
    };
  }>;
}

interface PoolReading {
  dexValuationXrd: number;
  lsulpSupply: number;
  /// Present only on the "now" read — used to bind-check the resource pairing.
  liquidityTokenResource?: string;
}

function readPool(json: EntityDetailsResponse): PoolReading | null {
  const items = json.items;
  if (!Array.isArray(items)) return null;

  let dexValuationXrd = NaN;
  let lsulpSupply = NaN;
  let liquidityTokenResource: string | undefined;

  for (const item of items) {
    if (item.address === LSU_POOL_COMPONENT) {
      const fields = item.details?.state?.fields;
      dexValuationXrd = parseDecimal(fieldByName(fields, 'dex_valuation_xrd')?.value);
      const bind = fieldByName(fields, 'liquidity_token_resource_manager')?.value;
      if (typeof bind === 'string') liquidityTokenResource = bind;
    } else if (item.address === LSULP_RESOURCE) {
      lsulpSupply = parseDecimal(item.details?.total_supply);
    }
  }

  if (!Number.isFinite(dexValuationXrd) || dexValuationXrd <= 0) return null;
  if (!Number.isFinite(lsulpSupply) || lsulpSupply <= 0) return null;
  return { dexValuationXrd, lsulpSupply, liquidityTokenResource };
}

export interface LsuPoolStats {
  apyPercent: number;
  /// Total XRD backing the pool — the TVL basis.
  dexValuationXrd: number;
  redemptionRateNow: number;
  windowDays: number;
}

/**
 * Measure the LSU Pool's realized yield, or return null.
 *
 * Both addresses go in ONE request per snapshot deliberately: split across two
 * calls they resolve at two different ledger states, and the ratio would
 * silently mix them.
 */
export async function fetchLsuPoolStats(
  gateway: GatewayClient,
): Promise<LsuPoolStats | null> {
  const addresses = [LSU_POOL_COMPONENT, LSULP_RESOURCE];

  let nowJson: EntityDetailsResponse;
  let pastJson: EntityDetailsResponse;
  try {
    nowJson = await gateway.post<EntityDetailsResponse>('/state/entity/details', {
      addresses,
    });
    const nowState = parseLedgerState(nowJson);
    if (!nowState) return null;
    pastJson = await gateway.post<EntityDetailsResponse>('/state/entity/details', {
      addresses,
      at_ledger_state: { timestamp: windowStartIso(nowState.timestampMs) },
    });
  } catch {
    return null;
  }

  const now = parseLedgerState(nowJson);
  const past = parseLedgerState(pastJson);
  if (!now || !past) return null;

  const nowReading = readPool(nowJson);
  const pastReading = readPool(pastJson);
  if (!nowReading || !pastReading) return null;

  // Bind-check every scan: the component must still point at the resource we
  // are using as the denominator. If a redeploy ever moves it, this catches the
  // mismatch before the ratio quietly becomes meaningless.
  if (
    nowReading.liquidityTokenResource &&
    nowReading.liquidityTokenResource !== LSULP_RESOURCE
  ) {
    console.error(
      `[lsu-pool] liquidity token resource moved to ${nowReading.liquidityTokenResource} — refusing to publish`,
    );
    return null;
  }

  const rNow = nowReading.dexValuationXrd / nowReading.lsulpSupply;
  const rPast = pastReading.dexValuationXrd / pastReading.lsulpSupply;

  const apyPercent = annualizedYieldPct(rNow, rPast, now, past);
  if (apyPercent === null) return null;
  if (!withinBand(apyPercent, MIN_PLAUSIBLE_APY, MAX_PLAUSIBLE_APY)) {
    console.error(
      `[lsu-pool] realized APY ${apyPercent.toFixed(2)}% outside the ${MIN_PLAUSIBLE_APY}-${MAX_PLAUSIBLE_APY}% plausible band — refusing to publish`,
    );
    return null;
  }

  return {
    apyPercent,
    dexValuationXrd: nowReading.dexValuationXrd,
    redemptionRateNow: rNow,
    windowDays: (now.timestampMs - past.timestampMs) / 86_400_000,
  };
}

/**
 * Surface the LSU Pool as a scannable opportunity.
 *
 * `yieldKind: 'staking'` is load-bearing. DefiLlama files this venue under
 * "Dexs", but it holds a single asset with no paired reserve — treating it as
 * an AMM pool would charge it the ~12.5% skeptical IL default and bury a
 * positive, IL-free yield beneath LP pools it comfortably beats.
 */
export async function scanLsuPool(
  gateway: GatewayClient,
  xrdUsdPrice: number,
): Promise<PoolInfo[]> {
  const stats = await fetchLsuPoolStats(gateway);
  if (!stats) return [];

  const tvlUsd = stats.dexValuationXrd * (xrdUsdPrice > 0 ? xrdUsdPrice : 0);

  return [
    {
      address: LSU_POOL_COMPONENT,
      // The window is in the name because the figure depends on it.
      name: `LSULP liquid staking (realized, trailing ${REALIZED_WINDOW_DAYS}d)`,
      tokenA: LSULP_RESOURCE,
      tokenB: LSULP_RESOURCE,
      tvl: String(tvlUsd),
      apy: stats.apyPercent,
      protocol: 'caviarnine',
      // We have not verified an audit for CaviarNine; the UI renders this as
      // "Audit unverified" rather than asserting one either way.
      audited: false,
      apySource: 'live',
      // Already a realized measurement over a 30-day window — the scorer must
      // not re-average it across its 7-day snapshots or the served number stops
      // matching the window this row is named for.
      apyWindowDays: stats.windowDays,
      yieldKind: 'staking',
    },
  ];
}
