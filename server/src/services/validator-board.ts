/// The validator board — every registered validator ranked by what it
/// ACTUALLY paid its stakers, measured from the ledger.
///
/// Why this exists (2026-08-09 finding): a validator's displayed fee can read
/// 0% while it takes 100% — `state.validator_fee_factor` applies lazily and is
/// never updated after a fee-change request takes effect. DefiPlaza's node
/// displayed 0%, charged 100%, and held 165M XRD of stake earning its stakers
/// nothing. ~80 of 287 validators have divergent fee fields; ~20 of the top
/// 100 measure 0.000% paid. The wallet's validator picker shows the fee a
/// validator CLAIMS. Nothing in the ecosystem shows what it PAID.
///
/// What it paid is Δredemption: a validator's LSU redeems for
/// stake_vault ÷ LSU_supply XRD, which rises by exactly the rewards reaching
/// stakers. Read it at two ledger states and annualize. Immune to every fee
/// field — including the case a point-in-time rate cannot catch: DefiPlaza's
/// rate is 1.17, because it accrued normally for months and THEN flipped.
///
/// One semantic that differs from realized-yield.ts deliberately: there,
/// ratioNow == ratioPast is treated as a broken measurement (those venues
/// always accrue). Here, an UNCHANGED rate over the window is the product's
/// headline finding — it annualizes to 0.000% and gets flagged, not nulled.
/// Only a DECREASE is a measurement error (redemption is monotonic by
/// construction).
///
/// Cost: 2 validator-list calls (the Gateway serves all ~287 in one page,
/// time-travel via at_ledger_state) + ceil(n/20)×2 batched total_supply reads.
/// ~32 Gateway round-trips per refresh, cached for REFRESH_TTL_MS.

import type { GatewayClient } from './gateway.js';
import { windowStartIso, REALIZED_WINDOW_DAYS } from './realized-yield.js';

const SUPPLY_BATCH = 20; // Gateway entity-details address cap

export interface ValidatorRow {
  address: string;
  name: string | null;
  /// Current stake, XRD (display/rank).
  stakeXrd: number;
  /// The fee that is actually in force (effective_fee_factor.current), %.
  effectiveFeePct: number | null;
  /// The lazily-applied state field, % — shown ONLY to expose divergence.
  staleFeePct: number | null;
  feeFieldsDisagree: boolean;
  /// stake_vault ÷ LSU supply, now. 1.0 = never accrued anything.
  redemptionRate: number | null;
  /// Annualized Δredemption over the window. 0 is a REAL value (paid
  /// nothing); null = could not measure (new validator, missing supply,
  /// or a rate decrease, which redemption's monotonicity forbids).
  realizedApyPct: number | null;
  /// realizedApyPct measured and < PAYS_NOTHING_BELOW_PCT.
  paysNothing: boolean;
  /// paysNothing AND the effective fee is 100% — the zero is DISCLOSED: the
  /// validator visibly takes everything and redistributes it as a different
  /// product (lottery prizes, fund returns, treasury). Its stakers opted in.
  /// The anomaly worth flagging is the complement: pays nothing at a fee
  /// that claims to leave the staker something.
  zeroDisclosedByFee: boolean;
  /// In the current active set (~top 100 by stake). An INACTIVE zero-payer
  /// is expected (it cannot propose); an ACTIVE one is keeping everything.
  activeInEpoch: boolean;
}

export interface ValidatorBoard {
  measuredAt: string; // ISO
  windowDays: number;
  rows: ValidatorRow[];
  /// Aggregates the UI leads with — ACTIVE-set zero-payers only. An inactive
  /// validator paying nothing is expected; an active one needs a look. These
  /// two are the TOTAL (disclosed + anomalous).
  activeZeroPayerCount: number;
  activeZeroPayerStakeXrd: number;
  /// The split (2026-08-23): most active zero-payers run a VISIBLE 100% fee —
  /// a different product, not a trap. Leading with the combined number
  /// overstated the anomaly ~38× by stake. The UI must lead with the
  /// anomalous pair, not the total.
  activeDisclosedZeroCount: number;
  activeDisclosedZeroStakeXrd: number;
  activeAnomalousZeroCount: number;
  activeAnomalousZeroStakeXrd: number;
  activeCount: number;
}

/// Below this measured APY a validator is keeping everything: real stakes
/// earn ~5-6.6%, so 0.01% is noise-floor, not a conservative validator.
export const PAYS_NOTHING_BELOW_PCT = 0.01;

/// At or above this effective fee, a zero payout is what the validator SAYS
/// it does (fee_factor 1.0 → 100%). Tolerance for decimal-string round-trip.
export const DISCLOSED_FULL_FEE_PCT = 100 - 1e-6;

// ─── Gateway shapes (the slices we read) ─────────────────────────────────────

interface GwValidator {
  address: string;
  /// Present (an object) only for the ~100 validators in the current active
  /// set; null for the rest. Inactive validators CANNOT earn — their 0.000%
  /// is expected, not scandalous — so the board labels the two differently.
  active_in_epoch?: object | null;
  stake_vault?: { balance?: string };
  state?: { stake_unit_resource_address?: string; validator_fee_factor?: string | number };
  effective_fee_factor?: { current?: { fee_factor?: string | number } };
  metadata?: {
    items?: Array<{ key: string; value?: { typed?: { value?: string } } }>;
  };
}
interface GwValidatorList {
  ledger_state?: { state_version?: number; proposer_round_timestamp?: string };
  validators?: { items?: GwValidator[] };
}
interface GwSupplyItem {
  address: string;
  details?: { total_supply?: string };
}

function validatorName(v: GwValidator): string | null {
  return (
    v.metadata?.items?.find((m) => m.key === 'name')?.value?.typed?.value ?? null
  );
}

function feePct(f: string | number | undefined): number | null {
  if (f === undefined || f === null) return null;
  const n = typeof f === 'number' ? f : parseFloat(f);
  return Number.isFinite(n) ? n * 100 : null;
}

async function supplies(
  gw: GatewayClient,
  resources: string[],
  atIso: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batches: string[][] = [];
  for (let i = 0; i < resources.length; i += SUPPLY_BATCH) {
    batches.push(resources.slice(i, i + SUPPLY_BATCH));
  }
  const results = await Promise.all(
    batches.map((addresses) =>
      gw
        .post<{ items?: GwSupplyItem[] }>('/state/entity/details', {
          addresses,
          aggregation_level: 'Global',
          ...(atIso ? { at_ledger_state: { timestamp: atIso } } : {}),
        })
        // A batch containing a resource that did not exist at the past state
        // 404s the WHOLE batch — degrade that batch to empty rather than
        // failing the board; its validators simply measure null.
        .catch(() => ({ items: [] as GwSupplyItem[] })),
    ),
  );
  for (const r of results) {
    for (const item of r.items ?? []) {
      const s = parseFloat(item.details?.total_supply ?? '');
      if (Number.isFinite(s) && s > 0) out.set(item.address, s);
    }
  }
  return out;
}

/// Annualize Δredemption. Equality → 0 (the finding). Decrease → null (the
/// measurement error). dt measured from what the Gateway returned, not from
/// what we asked for.
export function boardApyPct(
  rateNow: number | null,
  ratePast: number | null,
  dtDays: number,
): number | null {
  if (rateNow === null || ratePast === null) return null;
  if (!Number.isFinite(dtDays) || dtDays < 1) return null;
  if (rateNow < ratePast) return null;
  if (rateNow === ratePast) return 0;
  return (Math.pow(rateNow / ratePast, 365 / dtDays) - 1) * 100;
}

export async function fetchValidatorBoard(
  gw: GatewayClient,
  nowMs: number,
): Promise<ValidatorBoard> {
  const pastIso = windowStartIso(nowMs);

  const [nowList, pastList] = await Promise.all([
    gw.post<GwValidatorList>('/state/validators/list', {}),
    gw.post<GwValidatorList>('/state/validators/list', {
      at_ledger_state: { timestamp: pastIso },
    }),
  ]);

  const nowItems = nowList.validators?.items ?? [];
  const pastByAddr = new Map(
    (pastList.validators?.items ?? []).map((v) => [v.address, v]),
  );

  // dt from the ledger states the Gateway actually served.
  const nowTs = Date.parse(nowList.ledger_state?.proposer_round_timestamp ?? '');
  const pastTs = Date.parse(pastList.ledger_state?.proposer_round_timestamp ?? '');
  const dtDays =
    Number.isFinite(nowTs) && Number.isFinite(pastTs)
      ? (nowTs - pastTs) / 86_400_000
      : NaN;

  const lsuOf = (v: GwValidator) => v.state?.stake_unit_resource_address;
  const lsuNow = nowItems.map(lsuOf).filter((x): x is string => !!x);
  const lsuPast = [...pastByAddr.values()].map(lsuOf).filter((x): x is string => !!x);

  const [supplyNow, supplyPast] = await Promise.all([
    supplies(gw, [...new Set(lsuNow)], null),
    supplies(gw, [...new Set(lsuPast)], pastIso),
  ]);

  const rows: ValidatorRow[] = nowItems.map((v) => {
    const stakeXrd = parseFloat(v.stake_vault?.balance ?? '0') || 0;

    const rate = (item: GwValidator | undefined, supply: Map<string, number>) => {
      const res = item ? lsuOf(item) : undefined;
      const bal = parseFloat(item?.stake_vault?.balance ?? '');
      const sup = res ? supply.get(res) : undefined;
      return Number.isFinite(bal) && bal > 0 && sup ? bal / sup : null;
    };
    const rateNow = rate(v, supplyNow);
    const ratePast = rate(pastByAddr.get(v.address), supplyPast);
    const apy = boardApyPct(rateNow, ratePast, dtDays);

    const effective = feePct(v.effective_fee_factor?.current?.fee_factor);
    const stale = feePct(v.state?.validator_fee_factor);
    const paysNothing = apy !== null && apy < PAYS_NOTHING_BELOW_PCT;

    return {
      address: v.address,
      name: validatorName(v),
      stakeXrd,
      effectiveFeePct: effective,
      staleFeePct: stale,
      feeFieldsDisagree:
        effective !== null && stale !== null && Math.abs(effective - stale) > 1e-9,
      redemptionRate: rateNow,
      realizedApyPct: apy,
      paysNothing,
      zeroDisclosedByFee:
        paysNothing && effective !== null && effective >= DISCLOSED_FULL_FEE_PCT,
      activeInEpoch: v.active_in_epoch != null,
    };
  });

  // Best payers first; unmeasured sink below every measured row (including
  // the zero-payers — "we know it pays nothing" outranks "we don't know").
  rows.sort((a, b) => {
    const av = a.realizedApyPct ?? -1;
    const bv = b.realizedApyPct ?? -1;
    return bv - av || b.stakeXrd - a.stakeXrd;
  });

  const activeZero = rows.filter((r) => r.paysNothing && r.activeInEpoch);
  const disclosed = activeZero.filter((r) => r.zeroDisclosedByFee);
  const anomalous = activeZero.filter((r) => !r.zeroDisclosedByFee);
  const stakeSum = (rs: ValidatorRow[]) => rs.reduce((s, r) => s + r.stakeXrd, 0);
  return {
    measuredAt: new Date(nowMs).toISOString(),
    windowDays: Number.isFinite(dtDays) ? Math.round(dtDays * 10) / 10 : REALIZED_WINDOW_DAYS,
    rows,
    activeZeroPayerCount: activeZero.length,
    activeZeroPayerStakeXrd: stakeSum(activeZero),
    activeDisclosedZeroCount: disclosed.length,
    activeDisclosedZeroStakeXrd: stakeSum(disclosed),
    activeAnomalousZeroCount: anomalous.length,
    activeAnomalousZeroStakeXrd: stakeSum(anomalous),
    activeCount: rows.filter((r) => r.activeInEpoch).length,
  };
}

// ─── TTL cache with single-flight refresh ────────────────────────────────────

/// Redemption drifts ~0.02%/day; twice-daily is generous. The first request
/// after expiry pays the ~32 Gateway calls; everyone else reads the cache.
export const BOARD_TTL_MS = 12 * 3600_000;

let cache: { board: ValidatorBoard; fetchedAt: number } | null = null;
let inflight: Promise<ValidatorBoard> | null = null;

export function _clearBoardCache(): void {
  cache = null;
  inflight = null;
}

export async function getValidatorBoard(
  gw: GatewayClient,
  nowMs: number = Date.now(),
): Promise<ValidatorBoard> {
  if (cache && nowMs - cache.fetchedAt < BOARD_TTL_MS) return cache.board;
  if (!inflight) {
    inflight = fetchValidatorBoard(gw, nowMs)
      .then((board) => {
        cache = { board, fetchedAt: nowMs };
        return board;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
