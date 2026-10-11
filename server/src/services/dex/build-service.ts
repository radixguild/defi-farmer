/// The non-custodial deposit/withdraw endpoint's orchestration:
/// resolve the pool → refresh its moving params → derive the tick/bin range →
/// build the manifest → dry-run it through the Gateway (the sign-gate). Returns
/// the manifest + the real preview so the UI shows "you send X, receive Y" and
/// refuses to hand a failing manifest to the wallet. Money moves only when the
/// USER signs; defi-farmer never touches funds. (docs/DEX-INTEGRATION.md.)

import { CONFIG } from '../../config.js';
import type { GatewayClient } from '../gateway.js';
import {
  resolvePool, refreshDynamic, type ResolvedPool, type PoolKind,
} from './pool-resolver.js';
import {
  buildDeposit, buildTwoSidedDeposit, buildFungibleWithdraw, buildDefiplazaWithdraw, buildNftWithdraw,
  type DepositRequest, type BuildOpts, type FeeConfig,
} from './manifests.js';
import {
  ociTickFromPriceSqrt, ociTickRangeByWidth, ociTickRangeByPrice,
  cavBinRangeByWidth, cavBinRangeByPrice,
} from './concentrated.js';
import { optimizeRange, type RangeChoice } from '../range-optimizer.js';
import { previewManifest, type PreviewResult } from './preview.js';
import { assertAddress, assertAmount } from './rtm.js';
import { toScaled } from './decimal.js';
import {
  detectVenue, buildStakeDeposit, buildWeftSupplyDeposit, buildLsulpDeposit,
  buildStakeUnstake, buildStakeClaim, buildWeftSupplyWithdraw, buildLsulpWithdraw,
  UNSTAKE_NOTICE, LSULP_TO_LSU_NOTICE, WEFT_WITHDRAW_NOTICE,
  type VenueKind,
} from './venue-manifests.js';
import {
  resolveValidatorExitResources, resolveWeftDepositUnit, readStakeClaim, claimCopy,
  VenueExitError, type StakeClaim,
} from './venue-exit.js';
import { getValidatorBoard, type ValidatorRow } from '../validator-board.js';
import { XRD_STAKING_ADDRESS } from '../staking.js';

const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// Caller-facing validation failure → HTTP 400 (distinct from Gateway/internal → 500).
export class DexBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DexBuildError';
  }
}

/// A concentrated range: a formula-free WIDTH (below/above grid steps), an
/// explicit PRICE band, or a symmetric MULTIPLE (range = [1/m, m] × current
/// price — the range optimizer's output plugs straight in). Width is preferred
/// over price (no dependence on the price base).
export interface RangeSpec {
  below?: number;
  above?: number;
  loPrice?: string;
  hiPrice?: string;
  multiple?: number;
}

export interface DexBuildRequest {
  /// 'claim' is the second leg of a native unstake — see the venue exit section.
  action: 'deposit' | 'withdraw' | 'claim';
  account: string;
  poolAddress: string;
  // single-sided venue exits:
  /// Native staking: which validator to unstake from / claim at. Its stake-unit
  /// and claim-NFT resources are resolved from ITS OWN state, never from here.
  validator?: string;
  /// LSULP exit terminus. 'lsu' (default) stops at liquid stake units — instant,
  /// still earning. 'xrd' chains the unstake, starting the ~7-day unbonding.
  exitTo?: 'lsu' | 'xrd';
  // deposit — two-sided (Basic/Weighted) + concentrated (Precision/QuantaSwap):
  amountX?: string;
  amountY?: string;
  range?: RangeSpec; // concentrated only
  // deposit — DefiPlaza single-sided:
  inputToken?: string;
  inputAmount?: string;
  coAmount?: string;
  // withdraw:
  lpAmount?: string; // fungible LP (Basic/Weighted) + DefiPlaza
  lpToken?: string; // DefiPlaza base/quote LP resource
  localId?: string; // NFT receipt (Precision/QuantaSwap)
}

export interface DexBuildResult {
  manifest: string;
  preview: PreviewResult;
  pool: {
    address: string;
    kind: PoolKind | VenueKind;
    protocol: string;
    tokenX: string;
    tokenY: string;
    concentrated: boolean;
  };
  /// The concentrated range that was built (for the UI to echo back).
  range?: { left: number; right: number } | { bins: number[] };
  /// DefiPlaza single-sided add rejected for lack of counter-liquidity — the UI
  /// must collect `otherToken` and re-request with `coAmount`.
  needsCoLiquidity?: { otherToken: string };
  /// Plain-language warning the UI MUST render beside the preview. Set on every
  /// exit whose result is not "you get your XRD now" — above all an unstake,
  /// which returns a claim receipt and locks the XRD for ~7 days.
  notice?: string;
  /// Populated on action:'claim' — what the claim is worth and when it unlocks.
  claim?: StakeClaim;
}

// ─── pure helpers (unit-tested without the network) ────────────────────────────

/// Validate + parse a USER-supplied positive decimal string (≤18 dp, no exponent)
/// → number, for tick/bin math.
export function posNum(s: string | undefined, label: string): number {
  if (s === undefined) throw new DexBuildError(`missing ${label}`);
  assertAmountOr400(s, label);
  const n = Number(s);
  if (!(n > 0) || !Number.isFinite(n)) throw new DexBuildError(`${label} must be a positive number`);
  return n;
}

/// Parse a Gateway-sourced positive PreciseDecimal (price_sqrt/lower_limit have up
/// to 36 dp — assertAmount's 18-dp cap would wrongly reject them). Only used in
/// read-only price math, never interpolated into a manifest.
function gwFloat(s: string | undefined, label: string): number {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) throw new DexBuildError(`invalid ${label}`);
  const n = Number(s);
  if (!(n > 0) || !Number.isFinite(n)) throw new DexBuildError(`${label} must be positive`);
  return n;
}

function assertAddressOr400(s: string | undefined, label: string): string {
  try {
    return assertAddress(s as string, label);
  } catch {
    throw new DexBuildError(`invalid ${label}`);
  }
}

function assertAmountOr400(s: string | undefined, label: string): string {
  try {
    return assertAmount(s as string, label);
  } catch {
    throw new DexBuildError(`invalid ${label}`);
  }
}

/// Pure fee resolution (unit-tested). Fails SAFE (no fee) on misconfig so a bad
/// env can never break deposits — it just disables the fee.
export function resolveFee(rate: string, component: string): FeeConfig | undefined {
  if (!rate || !component) return undefined;
  // The fee target MUST be a treasury COMPONENT (try_deposit_or_abort), never a
  // bare account — MONETIZATION.md. assertAddress alone accepts account_ too.
  if (!component.startsWith('component_')) {
    console.warn('[dex] PLATFORM_FEE_COMPONENT is not a component_ address — fee disabled (fail-safe)');
    return undefined;
  }
  try {
    assertAmount(rate, 'PLATFORM_FEE_RATE');
    assertAddress(component, 'PLATFORM_FEE_COMPONENT');
  } catch {
    console.warn('[dex] invalid PLATFORM_FEE_* config — fee disabled (fail-safe)');
    return undefined;
  }
  if (toScaled(rate) <= 0n) return undefined;
  return { rate, component };
}

/// The platform fee, from server config only (never caller-supplied).
export function serverFee(): FeeConfig | undefined {
  return resolveFee(CONFIG.PLATFORM_FEE_RATE, CONFIG.PLATFORM_FEE_COMPONENT);
}

/// DefiPlaza's "in shortage: requires counter liquidity" panic (pair.rs). Detected
/// from the preview error so the flow can ask the UI for the other token.
export function isShortagePanic(error: string | undefined): boolean {
  return !!error && /counter liquidity|in shortage/i.test(error);
}

/// Derive the on-grid tick range (Precision) or bin list (QuantaSwap) from the
/// request's RangeSpec + the pool's live params. Throws DexBuildError on bad input.
/// Convert a symmetric width multiple m into per-side grid steps: the range
/// [1/m, m] spans ln(m) of log-price each side; one Ociswap tick = ln(1.0001),
/// one QuantaSwap bin = ln(1.0005), and the grids move in tickSpacing/binSpan
/// units. Always at least 1 step so a tiny multiple still yields a real range.
export function multipleToSteps(multiple: number, logStep: number, gridSpan: number): number {
  if (!Number.isFinite(multiple) || multiple <= 1 || multiple > 100) {
    throw new DexBuildError(`range multiple must be in (1, 100] (got ${multiple})`);
  }
  return Math.max(1, Math.round(Math.log(multiple) / (logStep * gridSpan)));
}

export function deriveRange(
  pool: ResolvedPool, spec: RangeSpec | undefined,
): { left: number; right: number } | { bins: number[] } {
  if (!spec) throw new DexBuildError('concentrated deposit requires a range: {below,above}, {loPrice,hiPrice} or {multiple}');
  const specWithMultiple =
    spec.multiple !== undefined && spec.below === undefined && spec.above === undefined && spec.loPrice === undefined
      ? withMultipleAsWidth(pool, spec)
      : spec;
  return deriveRangeInner(pool, specWithMultiple);
}

function withMultipleAsWidth(pool: ResolvedPool, spec: RangeSpec): RangeSpec {
  const m = spec.multiple as number;
  if (pool.kind === 'ociswap_precision') {
    if (!pool.tickSpacing) throw new DexBuildError('pool missing tick_spacing');
    const steps = multipleToSteps(m, Math.log(1.0001), pool.tickSpacing);
    return { below: steps, above: steps };
  }
  if (pool.kind === 'caviarnine_quantaswap') {
    if (pool.binSpan === undefined) throw new DexBuildError('pool missing bin_span');
    const steps = multipleToSteps(m, Math.log(1.0005), pool.binSpan);
    return { below: steps, above: steps };
  }
  throw new DexBuildError(`range multiple not supported for kind ${pool.kind}`);
}

function deriveRangeInner(
  pool: ResolvedPool, spec: RangeSpec,
): { left: number; right: number } | { bins: number[] } {
  const hasPrice = spec.loPrice !== undefined && spec.hiPrice !== undefined;
  const hasWidth = spec.below !== undefined && spec.above !== undefined;
  try {
    if (pool.kind === 'ociswap_precision') {
      if (!pool.tickSpacing) throw new DexBuildError('pool missing tick_spacing');
      if (hasPrice) {
        return ociTickRangeByPrice(posNum(spec.loPrice, 'loPrice'), posNum(spec.hiPrice, 'hiPrice'), pool.tickSpacing);
      }
      if (hasWidth) {
        const cur = pool.priceSqrt
          ? ociTickFromPriceSqrt(gwFloat(pool.priceSqrt, 'price_sqrt'))
          : pool.activeTick;
        if (cur === undefined) throw new DexBuildError('pool has no current price to center on');
        return ociTickRangeByWidth(Math.round(cur), pool.tickSpacing, spec.below as number, spec.above as number);
      }
    } else if (pool.kind === 'caviarnine_quantaswap') {
      if (pool.activeBin === undefined || pool.binSpan === undefined) {
        throw new DexBuildError('pool missing active_bin/bin_span');
      }
      const anchor = {
        activeBin: pool.activeBin,
        binSpan: pool.binSpan,
        lowerLimit: pool.lowerLimit ? gwFloat(pool.lowerLimit, 'lower_limit') : undefined,
      };
      if (hasPrice) {
        if (anchor.lowerLimit === undefined) throw new DexBuildError('price range needs lower_limit; use a {below,above} width range');
        return { bins: cavBinRangeByPrice(posNum(spec.loPrice, 'loPrice'), posNum(spec.hiPrice, 'hiPrice'), anchor) };
      }
      if (hasWidth) return { bins: cavBinRangeByWidth(anchor, spec.below as number, spec.above as number) };
    }
  } catch (err) {
    if (err instanceof DexBuildError) throw err;
    throw new DexBuildError(`invalid range: ${(err as Error).message}`);
  }
  throw new DexBuildError('range must be {below,above}, {loPrice,hiPrice} or {multiple}');
}

// ─── pool info (drives the deposit form + range selector) ─────────────────────

export interface PoolInfoDeps {
  /// Injected in tests; defaults live in the API handler (price feed + DB).
  pairRisk?: (tokenX: string, tokenY: string) => Promise<{ relAnnualVol: number } | null>;
  /// The pool's current full-range fee APR % (gross), for the optimizer.
  baseFeeApr?: number;
}

export interface PoolInfoResult {
  address: string;
  kind: PoolKind | VenueKind;
  protocol: string;
  concentrated: boolean;
  tokenX: string;
  tokenY: string;
  /// 'fungible' | 'nft' | 'defiplaza' — which withdraw inputs a position needs.
  lpKind: ResolvedPool['lp']['kind'];
  shortage?: ResolvedPool['shortage'];
  /// Concentrated pools with live pair risk only: the optimizer's pick.
  suggestion?: RangeChoice;
  relAnnualVol?: number;
}

/// Resolve a pool for the deposit UI: identity + which inputs the form needs +
/// (concentrated, live-risk) the optimizer's suggested width. Never throws for
/// unsupported blueprints — the UI shows "unsupported", the builder refuses.
export async function poolInfo(
  gw: GatewayClient,
  address: string,
  deps: PoolInfoDeps = {},
): Promise<PoolInfoResult> {
  // Single-sided venues (native staking, LSULP, Weft lending) carry a synthetic
  // address the LP pool-resolver would reject — dispatch them before assertAddress.
  const venue = detectVenue(address);
  if (venue) return venuePoolInfo(address, venue);
  assertAddressOr400(address, 'address');
  let pool = await resolvePool(gw, address);
  const out: PoolInfoResult = {
    address: pool.address,
    kind: pool.kind,
    protocol: pool.protocol,
    concentrated: pool.concentrated,
    tokenX: pool.tokenX,
    tokenY: pool.tokenY,
    lpKind: pool.lp.kind,
  };
  if (pool.kind === 'unsupported') return out;
  pool = await refreshDynamic(gw, pool);
  out.shortage = pool.shortage;

  if (pool.concentrated && deps.pairRisk) {
    try {
      const risk = await deps.pairRisk(pool.tokenX, pool.tokenY);
      if (risk) {
        out.relAnnualVol = risk.relAnnualVol;
        out.suggestion = optimizeRange({
          baseFeeApr: deps.baseFeeApr ?? 0,
          relAnnualVol: risk.relAnnualVol,
        });
      }
    } catch {
      // no suggestion — the UI falls back to a manual width
    }
  }
  return out;
}

// ─── orchestration ─────────────────────────────────────────────────────────────

function requireAmounts(req: DexBuildRequest): void {
  if (req.amountX === undefined || req.amountY === undefined) {
    throw new DexBuildError('deposit needs amountX and amountY');
  }
  assertAmountOr400(req.amountX, 'amountX');
  assertAmountOr400(req.amountY, 'amountY');
}

function buildWithdraw(pool: ResolvedPool, req: DexBuildRequest, opts: BuildOpts): string {
  switch (pool.lp.kind) {
    case 'fungible':
      if (req.lpAmount === undefined) throw new DexBuildError('fungible withdraw needs lpAmount');
      return buildFungibleWithdraw(req.account, pool, req.lpAmount, opts);
    case 'defiplaza':
      if (!req.lpToken || req.lpAmount === undefined) throw new DexBuildError('DefiPlaza withdraw needs lpToken and lpAmount');
      // The LP must be one of THIS pair's two pool units, resolved from chain —
      // a shape-valid foreign resource is a caller error, not a manifest.
      if (req.lpToken !== pool.lp.baseLp && req.lpToken !== pool.lp.quoteLp) {
        throw new DexBuildError("lpToken is not this pair's base or quote LP");
      }
      return buildDefiplazaWithdraw(req.account, pool, req.lpToken, req.lpAmount, opts);
    case 'nft':
      if (!req.localId) throw new DexBuildError('NFT withdraw needs localId');
      return buildNftWithdraw(req.account, pool, req.localId, opts);
    default:
      throw new DexBuildError('pool LP model not withdrawable');
  }
}

export async function buildAndPreview(gw: GatewayClient, req: DexBuildRequest): Promise<DexBuildResult> {
  if (req.action !== 'deposit' && req.action !== 'withdraw' && req.action !== 'claim') {
    throw new DexBuildError("action must be 'deposit', 'withdraw' or 'claim'");
  }
  assertAddressOr400(req.account, 'account');

  // Single-sided venues bypass the LP pool-resolver entirely, on the way in and
  // on the way out.
  const venue = detectVenue(req.poolAddress);
  if (venue) {
    if (req.action === 'deposit') return buildVenueDepositAndPreview(gw, req, venue);
    return buildVenueExitAndPreview(gw, req, venue);
  }

  assertAddressOr400(req.poolAddress, 'poolAddress');
  if (req.action === 'claim') throw new DexBuildError("action 'claim' applies to native staking only");

  let pool = await resolvePool(gw, req.poolAddress);
  if (pool.kind === 'unsupported') {
    // A lookalike (known blueprint name, unverified package) is refused with
    // its own wording so the caller is not told the blueprint itself is unknown.
    const why = pool.unsupportedReason === 'unpinned_package' ? ' (package not on the verified allowlist)' : '';
    throw new DexBuildError(`unsupported pool blueprint: ${pool.blueprintName || 'unknown'}${why}`);
  }
  pool = await refreshDynamic(gw, pool); // fresh activeTick/activeBin/priceSqrt/shortage

  const fee = serverFee();
  const opts: BuildOpts = fee ? { fee } : {};
  const poolInfo = {
    address: pool.address, kind: pool.kind, protocol: pool.protocol,
    tokenX: pool.tokenX, tokenY: pool.tokenY, concentrated: pool.concentrated,
  };

  if (req.action === 'withdraw') {
    let manifest: string;
    try {
      manifest = buildWithdraw(pool, req, opts);
    } catch (err) {
      // builder assertions (bad lpAmount/lpToken/localId) are caller-input → 400
      if (err instanceof DexBuildError) throw err;
      throw new DexBuildError((err as Error).message);
    }
    return { manifest, preview: await previewManifest(gw, manifest, req.account), pool: poolInfo };
  }

  // deposit
  const dr: DepositRequest = { account: req.account, pool, opts };
  let range: DexBuildResult['range'];
  switch (pool.kind) {
    case 'ociswap_basic':
    case 'caviarnine_weighted':
      requireAmounts(req);
      dr.amountX = req.amountX;
      dr.amountY = req.amountY;
      break;
    case 'ociswap_precision': {
      requireAmounts(req);
      const r = deriveRange(pool, req.range) as { left: number; right: number };
      dr.leftTick = r.left;
      dr.rightTick = r.right;
      dr.amountX = req.amountX;
      dr.amountY = req.amountY;
      range = r;
      break;
    }
    case 'caviarnine_quantaswap': {
      requireAmounts(req);
      const r = deriveRange(pool, req.range) as { bins: number[] };
      dr.bins = r.bins;
      dr.amountX = req.amountX;
      dr.amountY = req.amountY;
      range = r;
      break;
    }
    case 'defiplaza_pair':
      if (!req.inputToken || req.inputAmount === undefined) {
        throw new DexBuildError('DefiPlaza deposit needs inputToken and inputAmount');
      }
      assertAddressOr400(req.inputToken, 'inputToken');
      if (req.inputToken !== pool.tokenX && req.inputToken !== pool.tokenY) {
        throw new DexBuildError("inputToken is not this pair's base or quote token");
      }
      assertAmountOr400(req.inputAmount, 'inputAmount');
      if (req.coAmount !== undefined) assertAmountOr400(req.coAmount, 'coAmount');
      dr.inputToken = req.inputToken;
      dr.inputAmount = req.inputAmount;
      dr.coAmount = req.coAmount;
      break;
    default:
      throw new DexBuildError(`unsupported pool kind: ${pool.kind}`);
  }

  let manifest: string;
  try {
    manifest = buildDeposit(dr);
  } catch (err) {
    // builder assertions (bad address/amount/tick) are caller-input errors
    throw new DexBuildError((err as Error).message);
  }
  let preview = await previewManifest(gw, manifest, req.account);

  // CaviarNine WeightedPool's x/y order isn't exposed as plain x/y — the resolver
  // uses the native pool's vault order, which may not match add_liquidity(x,y). If
  // the first preview fails, retry with the token/amount order swapped (same
  // economic deposit, opposite arg order) and take it if it succeeds.
  if (!preview.ok && pool.kind === 'caviarnine_weighted') {
    const swapped = buildTwoSidedDeposit(
      req.account, { ...pool, tokenX: pool.tokenY, tokenY: pool.tokenX },
      req.amountY as string, req.amountX as string, opts,
    );
    const swappedPreview = await previewManifest(gw, swapped, req.account);
    if (swappedPreview.ok) {
      manifest = swapped;
      preview = swappedPreview;
    }
  }

  // DefiPlaza single-sided add can fail for lack of counter-liquidity even at
  // Equilibrium — the preview is the oracle (not state.shortage). Signal the UI.
  if (
    pool.kind === 'defiplaza_pair' && !preview.ok && req.coAmount === undefined &&
    isShortagePanic(preview.error)
  ) {
    const otherToken = req.inputToken === pool.tokenX ? pool.tokenY : pool.tokenX;
    return { manifest, preview, pool: poolInfo, needsCoLiquidity: { otherToken } };
  }
  return { manifest, preview, pool: poolInfo, range };
}

// ─── single-sided venues (native staking · LSULP · Weft lending) ──────────────

const VENUE_PROTOCOL: Record<VenueKind, string> = {
  native_stake: 'radix',
  lsulp: 'caviarnine',
  weft_lending: 'weft',
};

/// Deposit-form shape for a single-sided venue: one XRD amount, no range, no
/// second leg. tokenX = tokenY = XRD so the existing UI plumbing stays happy.
function venuePoolInfo(address: string, venue: VenueKind): PoolInfoResult {
  return {
    address,
    kind: venue,
    protocol: VENUE_PROTOCOL[venue],
    concentrated: false,
    tokenX: XRD_RESOURCE,
    tokenY: XRD_RESOURCE,
    lpKind: 'fungible',
  };
}

/// The native-staking default validator: the board's top REALIZED payer that is
/// active and actually paying, falling back to the top row. Never a zero-payer or
/// an inactive validator if a paying one exists. (rows are pre-sorted by realized
/// APY desc, so `find` yields the best paying one.)
export function pickTopValidator(rows: ValidatorRow[]): ValidatorRow | undefined {
  const paying = rows.find(
    (r) => r.realizedApyPct !== null && r.activeInEpoch && !r.paysNothing,
  );
  return paying ?? rows[0];
}

/// The LSULP-mint validator. The LSU Pool's token-validator PANICS unless the LSU
/// is from an ACTIVE-SET validator ("LSU must be for an active validator", verified
/// against mainnet 2026-08-11), so this deliberately ignores realized APY and picks
/// the highest-STAKE active validator — guaranteed in the active set, and it must
/// also be paying (a 100%-fee active node would mint a non-accruing LSU).
export function pickLsulpValidator(rows: ValidatorRow[]): ValidatorRow | undefined {
  const eligible = rows
    .filter((r) => r.activeInEpoch && !r.paysNothing)
    .sort((a, b) => b.stakeXrd - a.stakeXrd);
  return eligible[0] ?? rows.filter((r) => r.activeInEpoch).sort((a, b) => b.stakeXrd - a.stakeXrd)[0];
}

/// The chosen validator's Liquid Stake Unit resource (state.stake_unit_resource_address),
/// needed to bucket the LSU between the stake and add_liquidity legs of an LSULP deposit.
async function resolveValidatorLsu(gw: GatewayClient, validator: string): Promise<string> {
  const resp = await gw.post<{
    items?: Array<{ details?: { state?: { stake_unit_resource_address?: string } } }>;
  }>('/state/entity/details', { addresses: [validator], aggregation_level: 'Global' });
  const lsu = resp.items?.[0]?.details?.state?.stake_unit_resource_address;
  if (!lsu) throw new DexBuildError('could not resolve the validator LSU resource');
  return lsu;
}

async function buildVenueDepositAndPreview(
  gw: GatewayClient, req: DexBuildRequest, venue: VenueKind,
): Promise<DexBuildResult> {
  // Single-sided venues take one XRD amount, carried in amountX (the UI sends it there).
  const amount = req.amountX;
  if (amount === undefined) throw new DexBuildError('deposit needs an amount');
  assertAmountOr400(amount, 'amount');

  const fee = serverFee();
  const opts: BuildOpts = fee ? { fee } : {};
  const poolInfoOut = venuePoolInfo(req.poolAddress, venue);

  let manifest: string;
  try {
    if (venue === 'weft_lending') {
      manifest = buildWeftSupplyDeposit(req.account, amount, opts);
    } else {
      // native_stake + lsulp both need a validator, but different ones: native
      // wants the top realized payer; LSULP requires an active-set validator the
      // LSU Pool will accept (highest-stake active).
      const board = await getValidatorBoard(gw);
      if (venue === 'native_stake') {
        const validator = pickTopValidator(board.rows);
        if (!validator) throw new DexBuildError('no eligible validator available');
        manifest = buildStakeDeposit(req.account, validator.address, amount, opts);
      } else {
        const validator = pickLsulpValidator(board.rows);
        if (!validator) throw new DexBuildError('no active validator available for LSULP');
        const lsu = await resolveValidatorLsu(gw, validator.address);
        manifest = buildLsulpDeposit(req.account, validator.address, lsu, amount, opts);
      }
    }
  } catch (err) {
    if (err instanceof DexBuildError) throw err;
    throw new DexBuildError((err as Error).message);
  }

  const preview = await previewManifest(gw, manifest, req.account);
  return { manifest, preview, pool: poolInfoOut };
}

// ─── single-sided venue EXITS ─────────────────────────────────────────────────
//
// Shapes and evidence live in venue-manifests.ts; ledger resolution in
// venue-exit.ts. Three things make an exit different from a deposit and are the
// reason this is a separate function rather than a flag on the deposit path:
//
//  1. A deposit spends XRD. An exit spends a POSITION token — the validator's
//     stake unit, Weft's w2-XRD, or LSULP — so the amount is denominated in
//     units, not XRD, and the resource must be resolved from the issuer.
//  2. Native unstake does not return money. It returns a receipt that is worth
//     XRD only after ~7 epochs-days and a SECOND signature (action:'claim').
//  3. Exits are never fee-spliced.

/// The unit amount an exit spends, carried in `lpAmount` like every other
/// withdraw in this service.
function requireUnitAmount(req: DexBuildRequest): string {
  if (req.lpAmount === undefined) {
    throw new DexBuildError('exit needs lpAmount (the position units to spend)');
  }
  return assertAmountOr400(req.lpAmount, 'lpAmount');
}

function requireValidator(req: DexBuildRequest): string {
  if (!req.validator) throw new DexBuildError('native staking needs a validator address');
  const v = assertAddressOr400(req.validator, 'validator');
  if (!v.startsWith('validator_')) throw new DexBuildError('validator must be a validator_ address');
  return v;
}

/// rtm.ts's assert* family (assertAddress/assertAmount, and venue-manifests.ts's
/// assertPositiveAmount) are the only things this path expects to fail on caller
/// input, and they always throw a plain `Error` — never one of JS's own runtime
/// exception types. A TypeError (a bug reaching into `undefined`), or a raw
/// network TypeError from `fetch` itself (gateway.ts only prefixes WITH
/// "Gateway " the failures it recognizes as HTTP-status errors, not connection
/// failures), is not something the caller triggered. Relabeling either as a 400
/// would both mislead the caller ("fix your input") and leak an internal
/// message that was never meant to be caller-facing.
function isKnownInputValidationError(err: unknown): boolean {
  return err instanceof Error && err.constructor === Error;
}

async function buildVenueExitAndPreview(
  gw: GatewayClient, req: DexBuildRequest, venue: VenueKind,
): Promise<DexBuildResult> {
  const poolInfoOut = venuePoolInfo(req.poolAddress, venue);
  const out = (manifest: string, notice?: string, claim?: StakeClaim) =>
    previewManifest(gw, manifest, req.account).then((preview) => ({
      manifest, preview, pool: poolInfoOut, notice, claim,
    }));

  try {
    if (req.action === 'claim') {
      if (venue !== 'native_stake') {
        throw new DexBuildError(
          `${venue} has no claim leg — claims belong to native staking (poolAddress '${XRD_STAKING_ADDRESS}')`,
        );
      }
      const validator = requireValidator(req);
      if (!req.localId) throw new DexBuildError('claim needs localId (the Stake Claim NFT id)');
      const { claimNftResource } = await resolveValidatorExitResources(gw, validator);
      const claim = await readStakeClaim(gw, validator, claimNftResource, req.localId);
      // Refuse early with the real numbers. The preview would reject it too, but
      // "claim_epoch has not been reached" is not an answer a user can act on;
      // "4,213 XRD, 812 epochs away, ~2.8 days" is.
      if (!claim.ready) throw new DexBuildError(claimCopy(claim));
      return await out(
        buildStakeClaim(req.account, validator, claimNftResource, req.localId),
        claimCopy(claim),
        claim,
      );
    }

    if (venue === 'native_stake') {
      const validator = requireValidator(req);
      const amount = requireUnitAmount(req);
      const { lsuResource } = await resolveValidatorExitResources(gw, validator);
      return await out(
        buildStakeUnstake(req.account, validator, lsuResource, amount),
        UNSTAKE_NOTICE,
      );
    }

    if (venue === 'weft_lending') {
      const amount = requireUnitAmount(req);
      const depositUnit = await resolveWeftDepositUnit(gw);
      return await out(
        buildWeftSupplyWithdraw(req.account, depositUnit, amount),
        WEFT_WITHDRAW_NOTICE,
      );
    }

    // lsulp
    const amount = requireUnitAmount(req);
    const exitTo = req.exitTo ?? 'lsu';
    if (exitTo !== 'lsu' && exitTo !== 'xrd') throw new DexBuildError("exitTo must be 'lsu' or 'xrd'");
    // The pool pays out in a validator LSU the CALLER names, and it must be one
    // the pool holds enough of. Reusing the deposit's picker keeps entry and exit
    // pointed at the same (highest-stake, active, paying) validator; if the pool
    // is short of that LSU the dry-run fails and nothing can be signed.
    const board = await getValidatorBoard(gw);
    const validator = pickLsulpValidator(board.rows);
    if (!validator) throw new DexBuildError('no active validator available to redeem LSULP into');
    const { lsuResource } = await resolveValidatorExitResources(gw, validator.address);
    return await out(
      buildLsulpWithdraw(
        req.account, amount, lsuResource,
        exitTo === 'xrd' ? validator.address : undefined,
      ),
      exitTo === 'xrd' ? UNSTAKE_NOTICE : LSULP_TO_LSU_NOTICE,
    );
  } catch (err) {
    if (err instanceof DexBuildError) throw err;
    // A named entity that does not resolve on-ledger is caller input (400) — the
    // user picked a validator or asset that is not what they think it is. A
    // Gateway that could not be reached is NOT, and must stay a 502 instead of
    // telling the user their perfectly good request was malformed.
    if (/^Gateway /.test((err as Error).message)) throw err;
    if (err instanceof VenueExitError) throw new DexBuildError(err.message);
    // builder assertions (bad address/amount/local id) are caller input too —
    // but only the ones we actually recognize as that. Anything else (a
    // TypeError from a bug, say) is not a caller mistake and must not be
    // repackaged as one; let it propagate so the route handler's fallback
    // turns it into a plain 502 instead of leaking an internal error string
    // to the caller as if it were their own mistake.
    if (isKnownInputValidationError(err)) throw new DexBuildError((err as Error).message);
    throw err;
  }
}
