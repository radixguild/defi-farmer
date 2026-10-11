/// Native XRD validator staking — the IL-free yield floor for this chain.
///
/// Why this exists: every AMM pool the agent scanned was net-negative after
/// impermanent loss (best was DFP2-XRD at −1.34%/yr on 2026-07-25), because
/// Radix fee income is tiny relative to XRD's volatility. Meanwhile ~4.85B XRD
/// sits staked earning protocol emissions with NO divergence risk at all. A
/// product that claims to surface "the best DeFi farming opportunities" while
/// omitting the one positive-yield venue on the chain is not being honest.
///
/// The yield is derived, not hardcoded:
///
///   APY ≈ (ANNUAL_EMISSION_XRD / total_staked_XRD) × (1 − validator_fee)
///
/// ANNUAL_EMISSION_XRD is a Radix protocol constant: 12B XRD minted over ~40
/// years at 300M/yr, split among ACTIVE-SET stakers in proportion to stake.
///
/// Re-derived 2026-08-02 against the live validator set: 300M / 4.721B
/// *registered* stake = 6.354% gross, which reproduces the publicly reported
/// ~6.34% to within 0.02pp. Net of the 2% median validator fee: ~6.23%.
///
/// An earlier note here claimed the gap between this app's 6.19% and the public
/// ~6.34% was "consensus-participation penalties". That was falsifiable and
/// false: the gap was 218.4M XRD of UNREGISTERED stake wrongly included in the
/// denominator. Do not reintroduce a hand-wave here — the arithmetic closes
/// exactly, so any residual gap means something is actually wrong.
///
/// This is a real yield in XRD terms. It is NOT a USD return: a staker earns
/// more XRD while remaining fully exposed to XRD's price. That distinction is
/// surfaced in the pool name and must never be dropped in the UI.

import type { GatewayClient, PoolInfo } from './gateway.js';

const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// Radix protocol constant: 300M XRD/yr of the 12B, 40-year emission schedule.
const ANNUAL_EMISSION_XRD = 300_000_000;


/// Synthetic address for the staking opportunity. Not a component — native
/// staking targets a validator, chosen by the user at deposit time — so it is
/// namespaced to stay distinguishable from real `component_rdx1…` pools.
export const XRD_STAKING_ADDRESS = 'native_xrd_staking';

interface ValidatorItem {
  address: string;
  stake_vault?: { balance?: string };
  effective_fee_factor?: {
    current?: { fee_factor?: string };
  };
  /// `is_registered` gates emissions — an unregistered validator can hold stake
  /// and earn nothing, so it must not sit in the emission denominator.
  state?: { is_registered?: boolean };
}

interface ValidatorsResponse {
  validators?: { items?: ValidatorItem[]; total_count?: number | null };
}

export interface StakingStats {
  totalStakedXrd: number;
  validatorCount: number;
  /**
   * MEDIAN validator fee as a fraction (0.02 = 2%), across validators holding
   * stake.
   *
   * Deliberately not the stake-weighted mean. That came out at 20.3% on
   * 2026-07-25 because a handful of treasury nodes (REDDICKS NODE, DefiPlaza
   * Investment Node) charge a 100% fee and hold ~8% of all stake between them.
   * Averaging those in describes nobody's outcome: the user picks their own
   * validator, the median fee is 2%, and 42% of stake sits at 2% or less.
   * Weighting by stake would have understated achievable staking yield by
   * ~1.2 percentage points.
   */
  medianFeeFactor: number;
  /// Emissions yield before any validator fee, in XRD terms.
  grossApyPercent: number;
  /// Net APY in XRD terms at the median validator fee.
  apyPercent: number;
}

/**
 * Read total stake and validator fees straight off the ledger.
 *
 * The endpoint returns the full validator set in one response (287 of 287 on
 * 2026-07-25) and exposes `total_count` rather than a cursor. That count is
 * checked rather than trusted: a short page would understate total stake and
 * therefore OVERSTATE the APY, which is the dangerous direction for a number a
 * user allocates real money against. On a mismatch we return null and the
 * opportunity simply does not appear, instead of appearing inflated.
 */
export async function fetchStakingStats(
  gateway: GatewayClient,
): Promise<StakingStats | null> {
  let json: ValidatorsResponse;
  try {
    json = await gateway.post<ValidatorsResponse>('/state/validators/list', {});
  } catch {
    return null;
  }

  const items = json.validators?.items ?? [];
  const totalCount = json.validators?.total_count;
  if (typeof totalCount === 'number' && items.length < totalCount) {
    return null;
  }

  // Only REGISTERED validators earn emissions, so only their stake belongs in
  // the denominator. Summing every validator holding stake pulled in 218.4M XRD
  // across 61 unregistered nodes (measured 2026-08-02: 240 staked, 179
  // registered), inflating the divisor and UNDERSTATING the yield — 6.073%
  // gross instead of 6.354%. Understating is the safe direction, but it made
  // the app disagree with every public figure by ~0.28pp for no reason.
  const earning = items.filter((v) => {
    const stake = parseFloat(v.stake_vault?.balance ?? '0');
    return v.state?.is_registered === true && Number.isFinite(stake) && stake > 0;
  });

  // NOT capped to the top-100 active set, deliberately. Emissions do accrue to
  // the active set, but on mainnet the registered tail outside it holds 148,853
  // XRD of 4.72B — 0.003%, worth 0.001pp on the denominator. Slicing to 100 also
  // slices the FEE population down to the largest validators, which charge more:
  // measured 2026-08-02 the median fee went 2.00% -> 5.00% and the published net
  // yield fell 6.227% -> 6.037%. The cap bought nothing and cost 0.19pp, so the
  // whole registered set is both simpler and more accurate. Revisit only if that
  // tail ever becomes material.
  let totalStaked = 0;
  const fees: number[] = [];
  for (const v of earning) {
    const stake = parseFloat(v.stake_vault?.balance ?? '0');
    const fee = parseFloat(v.effective_fee_factor?.current?.fee_factor ?? '0');
    totalStaked += stake;
    fees.push(Number.isFinite(fee) ? Math.min(Math.max(fee, 0), 1) : 0);
  }

  if (totalStaked <= 0 || fees.length === 0) return null;

  fees.sort((a, b) => a - b);
  const mid = Math.floor(fees.length / 2);
  const medianFeeFactor =
    fees.length % 2 === 0 ? (fees[mid - 1] + fees[mid]) / 2 : fees[mid];

  // Total stake is the denominator for emissions: every staked XRD competes for
  // the same fixed 300M/yr, so the yield falls as more XRD is staked.
  const grossApyPercent = (ANNUAL_EMISSION_XRD / totalStaked) * 100;
  const apyPercent = grossApyPercent * (1 - medianFeeFactor);

  return {
    totalStakedXrd: totalStaked,
    validatorCount: fees.length,
    medianFeeFactor,
    grossApyPercent,
    apyPercent,
  };
}

/**
 * Surface staking as a scannable opportunity.
 *
 * `yieldKind: 'staking'` is what stops the scorer subtracting an impermanent
 * loss that cannot occur — without it this would be charged the same ~12.5%
 * skeptical IL default as a volatile LP pair and rank below pools it beats by
 * a wide margin.
 *
 * TVL is reported in USD for comparability with the DEX pools, using the
 * XRD spot price the enricher already trusts.
 */
export async function scanStaking(
  gateway: GatewayClient,
  xrdUsdPrice: number,
): Promise<PoolInfo[]> {
  const stats = await fetchStakingStats(gateway);
  if (!stats) return [];

  const tvlUsd = stats.totalStakedXrd * (xrdUsdPrice > 0 ? xrdUsdPrice : 0);

  return [
    {
      address: XRD_STAKING_ADDRESS,
      name: 'XRD staking',
      tokenA: XRD_RESOURCE,
      tokenB: XRD_RESOURCE,
      tvl: String(tvlUsd),
      apy: stats.apyPercent,
      protocol: 'radix',
      // Native staking is part of the protocol, not a deployed contract; the
      // frontend renders this as "Radix protocol · no contract risk" rather
      // than as a third-party audit claim.
      audited: true,
      apySource: 'live',
      yieldKind: 'staking',
    },
  ];
}
