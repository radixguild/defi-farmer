/// Account-holdings reader — what an account ACTUALLY holds, classified.
///
/// The gap this closes: positions.db only knows deposits recorded through
/// POST /api/positions, so any stake or LP that predates the app — or was made
/// from a wallet directly — is invisible, and with zero rows the allocator has
/// nothing to allocate against and weeklyReview returns before proposing
/// anything. This reads the ledger instead of the DB: every fungible the
/// account holds, classified by what it IS, with staking positions converted
/// to XRD at the validator's measured redemption rate.
///
/// Classification is per-row fail-open: a resource we cannot identify comes
/// back kind:'unknown' WITH its amount rather than being dropped or aborting
/// the scan — a holdings view that silently omits a holding is worse than one
/// that says "I don't know what this is". The Gateway calls themselves are
/// fail-closed (an error surfaces as an error, never as an empty portfolio).
///
/// Three Gateway round-trips regardless of account size:
///   1. the account's fungible balances (vault aggregation)
///   2. every held resource's metadata + total_supply in one batch
///   3. every referenced validator's XRD stake vault in one batch

import type { GatewayClient } from './gateway.js';
import { LSULP_RESOURCE } from './lsu-pool.js';
import { getWeftDepositUnitCached } from './dex/venue-exit.js';

export const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// The opportunity id a Weft XRD holding exits through — the same string
/// `detectVenue()` matches on, so `detail` can be handed straight to
/// POST /api/dex/build as its poolAddress.
export const WEFT_VENUE_ID = `weft-v2:${XRD_RESOURCE}`;

const ACCOUNT_RE = /^account_(rdx|tdx_2_)1[a-z0-9]{20,80}$/;
export function isAccountAddress(a: unknown): a is string {
  return typeof a === 'string' && ACCOUNT_RE.test(a);
}

export type HoldingKind =
  | 'xrd'
  | 'validator-stake' // a validator's LSU — detail = the validator address
  | 'lsulp'           // CaviarNine LSU Pool LP
  | 'weft-lending'    // Weft V2 deposit unit (w2-XRD) — detail = the venue id
  | 'pool-lp'         // native pool unit — detail = the pool address
  | 'unknown';

export interface Holding {
  resource: string;
  amount: string; // raw Gateway decimal string — display/precision preserved
  kind: HoldingKind;
  /// Human label from on-ledger metadata (symbol, else name, else short addr).
  label: string;
  /// validator address (validator-stake) or pool address (pool-lp).
  detail: string | null;
  /// XRD value where a redemption rate exists (XRD itself, validator LSUs).
  /// null = not convertible here — the UI must show the raw amount, not 0.
  xrdValue: number | null;
  /// staked XRD per LSU for validator-stake rows — lets a caller build an
  /// unstake without re-deriving, and makes a 1.000000 rate (never accrued)
  /// visible for what it is.
  redemptionRate: number | null;
}

export interface HoldingsResult {
  account: string;
  holdings: Holding[];
  /// Sum of the convertible rows only. Callers must not present this as total
  /// account value while any row has xrdValue:null.
  xrdValueTotal: number;
  unconvertibleCount: number;
}

// ─── Gateway response shapes (the slices we read) ─────────────────────────────

interface MetaItem {
  key: string;
  value?: { typed?: { value?: string; type?: string } };
}
interface ResourceItem {
  address: string;
  details?: { total_supply?: string };
  metadata?: { items?: MetaItem[] };
}
interface ValidatorItem {
  address: string;
  fungible_resources?: {
    items?: Array<{
      resource_address?: string;
      vaults?: { items?: Array<{ amount?: string }> };
    }>;
  };
}

function meta(items: MetaItem[] | undefined, key: string): string | undefined {
  return items?.find((m) => m.key === key)?.value?.typed?.value;
}

/// A validator entity holds several XRD vaults (stake, pending-unstake buffer,
/// locked owner stake). The stake vault dominates by orders of magnitude, so
/// max() selects it; summing would inflate the redemption rate.
function stakeVaultXrd(v: ValidatorItem): number {
  const entry = (v.fungible_resources?.items ?? []).find(
    (f) => f.resource_address === XRD_RESOURCE,
  );
  const amounts = (entry?.vaults?.items ?? [])
    .map((x) => parseFloat(x.amount ?? '0'))
    .filter((n) => Number.isFinite(n));
  return amounts.length ? Math.max(...amounts) : 0;
}

// ─── The reader ───────────────────────────────────────────────────────────────

export async function readHoldings(
  gw: GatewayClient,
  account: string,
): Promise<HoldingsResult> {
  if (!isAccountAddress(account)) {
    throw new Error('Invalid account address');
  }

  const balances = await gw.getAccountBalances(account);
  const held = balances.filter((b) => parseFloat(b.amount) > 0);

  if (held.length === 0) {
    return { account, holdings: [], xrdValueTotal: 0, unconvertibleCount: 0 };
  }

  // Batch 2: classify every held resource in one call. `validator` on stake
  // units and `pool` on native pool units are GlobalAddress metadata set by
  // the issuing component — a scam token can fake `name`, but faking these to
  // a real validator/pool means the resource still is not that validator's
  // LSU, which is why conversion keys on the VALIDATOR's own supply below.
  const resources = held.map((b) => b.resourceAddress);
  const resourceDetails = (await gw.entityDetailsGlobal(resources, {
    explicit_metadata: ['name', 'symbol', 'validator', 'pool'],
  })) as { items: ResourceItem[] };
  const byResource = new Map(resourceDetails.items.map((r) => [r.address, r]));

  // Collect validators referenced by held LSUs for batch 3.
  const validatorOf = new Map<string, string>(); // resource → validator
  for (const [addr, item] of byResource) {
    const v = meta(item.metadata?.items, 'validator');
    if (v && v.startsWith('validator_')) validatorOf.set(addr, v);
  }
  const validators = [...new Set(validatorOf.values())];
  const validatorItems = validators.length
    ? await gw.post<{ items: ValidatorItem[] }>('/state/entity/details', {
        addresses: validators,
        aggregation_level: 'Vault',
      })
    : { items: [] as ValidatorItem[] };
  const byValidator = new Map(validatorItems.items.map((v) => [v.address, v]));

  // Weft's deposit unit has no `validator`/`pool` metadata to key on and its
  // symbol (w2-XRD) is forgeable, so it is resolved from Weft's own component —
  // the same chain the exit builder walks. Cached, because it only changes on a
  // Weft redeploy and this endpoint refreshes per account view.
  //
  // FAIL-OPEN, deliberately: if Weft or the Gateway is unreachable the row falls
  // through to 'unknown' with its amount intact, exactly as it did before this
  // existed. A classification lookup must never be able to turn a balance read
  // into an error — that is the rule in this file's header, and adding a fourth
  // network dependency is precisely where it would otherwise get broken.
  let weftDepositUnit: string | null = null;
  try {
    weftDepositUnit = await getWeftDepositUnitCached(gw);
  } catch (err) {
    console.warn(
      `[holdings] Weft deposit unit unresolved — w2-XRD rows stay 'unknown': ${(err as Error).message}`,
    );
  }

  const holdings: Holding[] = held.map((b) => {
    const item = byResource.get(b.resourceAddress);
    const items = item?.metadata?.items;
    const symbol = meta(items, 'symbol');
    const name = meta(items, 'name');
    const label = symbol ?? name ?? `${b.resourceAddress.slice(0, 16)}…`;

    if (b.resourceAddress === XRD_RESOURCE) {
      return {
        resource: b.resourceAddress,
        amount: b.amount,
        kind: 'xrd' as const,
        label: 'XRD',
        detail: null,
        xrdValue: parseFloat(b.amount),
        redemptionRate: 1,
      };
    }

    if (b.resourceAddress === LSULP_RESOURCE) {
      // Convertible in principle (LSU Pool NAV), but that is a component-state
      // read this pass does not make — null keeps the total honest.
      return {
        resource: b.resourceAddress,
        amount: b.amount,
        kind: 'lsulp' as const,
        label: 'LSULP',
        detail: null,
        xrdValue: null,
        redemptionRate: null,
      };
    }

    if (weftDepositUnit && b.resourceAddress === weftDepositUnit) {
      // Redeemable for XRD at Weft's own unit_ratio, which this pass does not
      // read — null keeps the total honest rather than implying parity. Note
      // the ratio is units-per-underlying and FALLS as interest accrues; the
      // redemption value is its reciprocal — an easy gotcha.
      return {
        resource: b.resourceAddress,
        amount: b.amount,
        kind: 'weft-lending' as const,
        label: symbol ?? 'Weft V2 deposit',
        detail: WEFT_VENUE_ID,
        xrdValue: null,
        redemptionRate: null,
      };
    }

    const validator = validatorOf.get(b.resourceAddress);
    if (validator) {
      const supply = parseFloat(item?.details?.total_supply ?? '0');
      const staked = stakeVaultXrd(byValidator.get(validator) ?? { address: validator });
      const rate = supply > 0 && staked > 0 ? staked / supply : null;
      return {
        resource: b.resourceAddress,
        amount: b.amount,
        kind: 'validator-stake' as const,
        label: name ?? 'Liquid Stake Units',
        detail: validator,
        xrdValue: rate !== null ? parseFloat(b.amount) * rate : null,
        redemptionRate: rate,
      };
    }

    const pool = meta(items, 'pool');
    if (pool && (pool.startsWith('pool_') || pool.startsWith('component_'))) {
      return {
        resource: b.resourceAddress,
        amount: b.amount,
        kind: 'pool-lp' as const,
        label,
        detail: pool,
        xrdValue: null,
        redemptionRate: null,
      };
    }

    return {
      resource: b.resourceAddress,
      amount: b.amount,
      kind: 'unknown' as const,
      label,
      detail: null,
      xrdValue: null,
      redemptionRate: null,
    };
  });

  // Staking first (largest product surface), then by convertible value.
  holdings.sort((a, b) => (b.xrdValue ?? -1) - (a.xrdValue ?? -1));

  return {
    account,
    holdings,
    xrdValueTotal: holdings.reduce((s, h) => s + (h.xrdValue ?? 0), 0),
    unconvertibleCount: holdings.filter((h) => h.xrdValue === null).length,
  };
}
