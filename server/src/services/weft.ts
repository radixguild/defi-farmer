/// Weft Finance V2 — single-asset lending, IL-free.
///
/// There is no Weft REST API. `api.weft.finance` answers only
/// `{"message":"Weft API"}` and every path under it 404s; their own web app is
/// a client-rendered bundle that talks exclusively to the Radix Gateway. So
/// this reads the ledger, exactly as their app does.
///
/// Supply yield is the realized drift of each pool's deposit-unit redemption
/// value across a fixed trailing window (realized-yield.ts). Note the
/// inversion: Weft stores `unit_ratio` as units-per-underlying, so it FALLS as
/// interest accrues and the redemption value is its reciprocal.
///
/// The stored `interest_rate` field is deliberately NOT used. It is a lagging
/// spot BORROW rate, refreshed only when the pool is transacted against, and
/// the naive supply model built from it (rate x utilization x (1 - fee))
/// overstates: measured 2026-07-25 it claims 7.85% for XRD where the realized
/// 30-day figure is 4.67%, and 186.6% for hUSDC against a realized 37.8%.
///
/// Of the 11 pools, only XRD survives the gates below. That is the honest
/// output, not a bug: eight pools hold literal dust (xwBTC holds 0.0008 units),
/// and hUSDC's headline 37.8% comes with 93% utilization against a 95% cap —
/// a yield that exists because suppliers may not be able to withdraw. Listing
/// it as a top opportunity would be actively harmful.

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

export const WEFT_V2_LENDING_COMPONENT =
  'component_rdx1czmr02yl4da709ceftnm9dnmag7rthu0tu78wmtsn5us9j02d9d0xn';

const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// Weft V1 runs in parallel with its own components and receipt tokens. Reading
/// a V1 pool alongside V2 would silently blend two different markets, so the V2
/// key-value store is resolved from the V2 component and never hardcoded.

/// LSULP's lending pool is dropped by resource address. Its lending leg alone
/// reads ~0.003%, but an LSULP supplier ALSO earns the ~6% appreciation of
/// LSULP itself, which is invisible here because the pool's totals are
/// denominated in LSULP units that are themselves appreciating. Publishing
/// "LSULP 0.00%" beside "LSULP liquid staking 6.10%" would falsely imply that
/// lending it forfeits the staking yield. Combining the legs needs an
/// LSULP->XRD price path we have not verified, so the row is omitted instead.
const LSULP_RESOURCE =
  'resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf';

/// Suppliers to a pool this close to its utilization cap may be unable to
/// withdraw on demand. hUSDC sat at 93.3% against a 95% cap on 2026-07-25 while
/// showing the highest realized yield of any pool — a liquidity trap wearing
/// the costume of a top opportunity.
const MAX_SAFE_UTILIZATION = 0.85;

/// Below this the pool is not investable and its yield is noise.
const MIN_TVL_USD = 50_000;
const MIN_APY_PCT = 0.5;

/// Lending competes with ~6% staking; a double-digit supply yield on a small
/// pool signals distress rather than opportunity.
const MAX_PLAUSIBLE_APY = 15;

interface EntityDetailsResponse {
  items?: Array<{ details?: { state?: { fields?: unknown } } }>;
}

interface KvsDataResponse {
  ledger_state?: unknown;
  entries?: Array<{
    key?: { raw_hex?: string; programmatic_json?: { value?: string } };
    value?: { programmatic_json?: { fields?: unknown } };
  }>;
}

interface KvsKeysResponse {
  items?: Array<{ key?: { raw_hex?: string; programmatic_json?: { value?: string } } }>;
}

interface PoolReading {
  resource: string;
  unitRatio: number;
  supplied: number;
  borrowed: number;
}

function readPools(json: KvsDataResponse): Map<string, PoolReading> {
  const out = new Map<string, PoolReading>();
  for (const entry of json.entries ?? []) {
    const resource = entry.key?.programmatic_json?.value;
    const fields = entry.value?.programmatic_json?.fields;
    if (typeof resource !== 'string' || !fields) continue;

    // Matched by field_name throughout — programmatic-JSON field order is not
    // contractual, so positional access would silently read the wrong number.
    const deposit = fieldByName(fields, 'deposit_state');
    const loan = fieldByName(fields, 'loan_state');
    if (!deposit || !loan) continue;

    const unitRatio = parseDecimal(fieldByName(deposit.fields, 'unit_ratio')?.value);
    const supplied = parseDecimal(fieldByName(deposit.fields, 'total')?.value);
    const borrowed = parseDecimal(fieldByName(loan.fields, 'total')?.value);
    if (!Number.isFinite(unitRatio) || unitRatio <= 0) continue;
    if (!Number.isFinite(supplied) || supplied <= 0) continue;

    out.set(resource, {
      resource,
      unitRatio,
      supplied,
      borrowed: Number.isFinite(borrowed) ? borrowed : 0,
    });
  }
  return out;
}

export interface WeftPoolStats {
  resource: string;
  apyPercent: number;
  suppliedUnits: number;
  utilization: number;
}

/**
 * Measure realized supply yield for Weft V2's XRD pool, or return null.
 *
 * Scoped to XRD deliberately. Only XRD has both meaningful depth and a
 * meaningful yield, and it is the one pool whose units are denominated in an
 * asset we can price confidently — the others would need per-asset USD prices
 * this app does not otherwise fetch.
 */
export async function fetchWeftXrdStats(
  gateway: GatewayClient,
): Promise<WeftPoolStats | null> {
  try {
    // 1. Resolve the V2 key-value store from the component rather than
    //    hardcoding it, so a redeploy cannot leave us reading a stale market.
    const component = await gateway.post<EntityDetailsResponse>(
      '/state/entity/details',
      { addresses: [WEFT_V2_LENDING_COMPONENT] },
    );
    const kvsAddress = fieldByName(
      component.items?.[0]?.details?.state?.fields,
      'resource_pools',
    )?.value;
    if (typeof kvsAddress !== 'string' || !kvsAddress.startsWith('internal_keyvaluestore_')) {
      return null;
    }

    // 2. Find the XRD entry's key. Keys are opaque hex; the resource address
    //    lives in the decoded programmatic JSON.
    const keys = await gateway.post<KvsKeysResponse>('/state/key-value-store/keys', {
      key_value_store_address: kvsAddress,
    });
    const xrdKey = (keys.items ?? []).find(
      (i) => i.key?.programmatic_json?.value === XRD_RESOURCE,
    )?.key?.raw_hex;
    if (!xrdKey) return null;

    // 3+4. Current and historical readings of that entry.
    const nowJson = await gateway.post<KvsDataResponse>('/state/key-value-store/data', {
      key_value_store_address: kvsAddress,
      keys: [{ key_hex: xrdKey }],
    });
    const now = parseLedgerState(nowJson);
    if (!now) return null;

    const pastJson = await gateway.post<KvsDataResponse>('/state/key-value-store/data', {
      key_value_store_address: kvsAddress,
      keys: [{ key_hex: xrdKey }],
      at_ledger_state: { timestamp: windowStartIso(now.timestampMs) },
    });
    const past = parseLedgerState(pastJson);
    if (!past) return null;

    const nowPool = readPools(nowJson).get(XRD_RESOURCE);
    const pastPool = readPools(pastJson).get(XRD_RESOURCE);
    if (!nowPool || !pastPool) return null;

    // Guard the drop rule even though XRD is the only resource requested.
    if (nowPool.resource === LSULP_RESOURCE) return null;

    // unit_ratio is units-per-underlying and FALLS as interest accrues, so the
    // redemption value is its reciprocal. Feeding the raw ratio in would invert
    // the result; the monotonicity gate would then reject it rather than
    // publish a negative yield.
    const apyPercent = annualizedYieldPct(
      1 / nowPool.unitRatio,
      1 / pastPool.unitRatio,
      now,
      past,
    );
    if (apyPercent === null) return null;

    const utilization = nowPool.supplied > 0 ? nowPool.borrowed / nowPool.supplied : 1;

    return {
      resource: XRD_RESOURCE,
      apyPercent,
      suppliedUnits: nowPool.supplied,
      utilization,
    };
  } catch {
    return null;
  }
}

export async function scanWeftLending(
  gateway: GatewayClient,
  xrdUsdPrice: number,
): Promise<PoolInfo[]> {
  const stats = await fetchWeftXrdStats(gateway);
  if (!stats) return [];

  if (!withinBand(stats.apyPercent, MIN_APY_PCT, MAX_PLAUSIBLE_APY)) {
    console.error(
      `[weft] XRD realized APY ${stats.apyPercent.toFixed(2)}% outside the ${MIN_APY_PCT}-${MAX_PLAUSIBLE_APY}% band — refusing to publish`,
    );
    return [];
  }

  if (stats.utilization >= MAX_SAFE_UTILIZATION) {
    console.error(
      `[weft] XRD utilization ${(stats.utilization * 100).toFixed(1)}% at or above the ${MAX_SAFE_UTILIZATION * 100}% safety cap — withdrawals may not be honoured, refusing to publish`,
    );
    return [];
  }

  const tvlUsd = stats.suppliedUnits * (xrdUsdPrice > 0 ? xrdUsdPrice : 0);
  if (!(tvlUsd >= MIN_TVL_USD)) {
    // Also catches an unavailable XRD price, where TVL computes to 0 — without
    // a price we cannot show this alongside USD-denominated pools.
    return [];
  }

  return [
    {
      address: `weft-v2:${XRD_RESOURCE}`,
      name: `XRD lending (realized, trailing ${REALIZED_WINDOW_DAYS}d)`,
      tokenA: XRD_RESOURCE,
      tokenB: XRD_RESOURCE,
      tvl: String(tvlUsd),
      apy: stats.apyPercent,
      protocol: 'weft',
      audited: false,
      apySource: 'live',
      // Already a realized measurement over a 30-day window — see the note in
      // scorer.computeApyMa7d. Re-averaging published 4.40% against a true
      // trailing-30d 3.89%. Safe to declare as the constant: annualizedYieldPct
      // returns null below MIN_WINDOW_DAYS, so a published figure is always
      // measured over at least 28 days.
      apyWindowDays: REALIZED_WINDOW_DAYS,
      yieldKind: 'lending',
    },
  ];
}
