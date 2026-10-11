/// Non-custodial liquidity manifest builders for real DEX components.
///
/// Each builder produces a Radix Transaction Manifest the USER signs in their own
/// wallet — funds go straight to the pool, never through defi-farmer. The
/// interfaces match what was verified against live mainnet (docs/DEX-INTEGRATION.md);
/// every built manifest is preview-gated (dex/preview.ts) before it reaches a wallet.
///
/// Optional platform fee is spliced BEFORE the deposit_batch sweep → a treasury
/// component (docs/MONETIZATION.md). Off by default (Phase 0 is free); structured
/// as a per-call param so enabling it later is config, not a rewrite.

import type { ResolvedPool } from './pool-resolver.js';
import {
  rtm, manifest, assertAmount, assertAddress, i32Arg, quantaPositionsArg, optionalLockFee,
} from './rtm.js';
import { mulDecimal, toScaled } from './decimal.js';
import { distributeQuanta, netAfterFee } from './concentrated.js';

export interface FeeConfig {
  /// Fraction, e.g. '0.0015' for 0.15%. '0' / absent → no fee.
  rate: string;
  /// Treasury component (non-custodial pass-through via try_deposit_or_abort).
  component: string;
}

export interface BuildOpts {
  /// Network fee lock. Omitted by default, because the wallet locks the fee
  /// itself. Set only for a manifest that bypasses the wallet (rtm.ts optionalLockFee).
  lockFee?: string;
  fee?: FeeConfig;
}

function feeEnabled(fee?: FeeConfig): fee is FeeConfig {
  return !!fee && !!fee.component && toScaled(fee.rate || '0') > 0n;
}

/// Withdraw `amount` of `token`; if a fee is enabled, take rate·amount to the
/// treasury; take the remainder into `bucket`. Fee-out-of-input, so the pool
/// receives amount·(1−rate) and the preview shows an explicit treasury outflow.
/// Exported for the single-sided venue builders (venue-manifests.ts), which
/// deposit plain XRD and reuse the exact same fee-splice semantics.
export function withdrawWithFee(
  account: string, token: string, amount: string, bucket: string,
  fee: FeeConfig | undefined, feeBucket: string,
): string[] {
  const lines = [rtm.withdraw(account, token, amount)];
  if (feeEnabled(fee)) {
    const feeAmount = mulDecimal(amount, fee.rate);
    if (toScaled(feeAmount) > 0n) {
      lines.push(rtm.takeFrom(token, feeAmount, feeBucket));
      lines.push(rtm.depositFee(fee.component, feeBucket));
    }
  }
  lines.push(rtm.takeAll(token, bucket));
  return lines;
}

/// Ociswap BasicPool / CaviarNine WeightedPool — two-sided, fungible LP.
/// add_liquidity(x_bucket, y_bucket). Bucket order is the resolver's x/y; the
/// build endpoint preview-retries with swapped order if a pool disagrees.
export function buildTwoSidedDeposit(
  account: string, pool: ResolvedPool, amountX: string, amountY: string, opts: BuildOpts = {},
): string {
  if (pool.kind !== 'ociswap_basic' && pool.kind !== 'caviarnine_weighted') {
    throw new Error(`buildTwoSidedDeposit: unexpected kind ${pool.kind}`);
  }
  assertAmount(amountX, 'amountX');
  assertAmount(amountY, 'amountY');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, pool.tokenX, amountX, 'bucket_x', opts.fee, 'fee_x'),
    ...withdrawWithFee(account, pool.tokenY, amountY, 'bucket_y', opts.fee, 'fee_y'),
    `CALL_METHOD Address("${assertAddress(pool.address, 'pool')}") "add_liquidity" Bucket("bucket_x") Bucket("bucket_y");`,
    rtm.depositBatch(account),
  );
}

/// DefiPlaza PlazaPair — single-sided, via the PlazaDex router.
/// add_liquidity(input, Option<co_liquidity>, Option<base_token>). Pass Some(co)
/// when the added side is in shortage (else the pool panics); always pass
/// Some(base) so a quote-token deposit is routed correctly.
export function buildDefiplazaDeposit(
  account: string, pool: ResolvedPool, inputToken: string, amount: string,
  coAmount: string | undefined, opts: BuildOpts = {},
): string {
  if (pool.kind !== 'defiplaza_pair' || !pool.router) throw new Error('buildDefiplazaDeposit: not a PlazaPair');
  assertAmount(amount, 'amount');
  assertAddress(inputToken, 'inputToken');
  const base = pool.tokenX; // base_address
  const lines = [
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, inputToken, amount, 'bucket_in', opts.fee, 'fee_in'),
  ];
  let coArg = 'Enum<0u8>()'; // None
  if (coAmount !== undefined) {
    assertAmount(coAmount, 'coAmount');
    const other = inputToken === base ? pool.tokenY : pool.tokenX;
    lines.push(rtm.withdraw(account, other, coAmount), rtm.takeAll(other, 'bucket_co'));
    coArg = 'Enum<1u8>(Bucket("bucket_co"))'; // Some(co)
  }
  lines.push(
    `CALL_METHOD Address("${assertAddress(pool.router, 'router')}") "add_liquidity" Bucket("bucket_in") ${coArg} Enum<1u8>(Address("${assertAddress(base, 'base')}"));`,
    rtm.depositBatch(account),
  );
  return manifest(...lines);
}

/// Ociswap PrecisionPool — concentrated, two-sided over a tick range, NFT receipt.
/// add_liquidity(left_tick, right_tick, x_bucket, y_bucket); the pool takes the
/// price-correct ratio inside [left,right] and returns change. `leftTick < rightTick`;
/// amounts may be '0' for a single-sided range (entirely above/below current price).
export function buildPrecisionDeposit(
  account: string, pool: ResolvedPool, leftTick: number, rightTick: number,
  amountX: string, amountY: string, opts: BuildOpts = {},
): string {
  if (pool.kind !== 'ociswap_precision') throw new Error(`buildPrecisionDeposit: unexpected kind ${pool.kind}`);
  assertAmount(amountX, 'amountX');
  assertAmount(amountY, 'amountY');
  if (!Number.isInteger(leftTick) || !Number.isInteger(rightTick) || leftTick >= rightTick) {
    throw new Error(`buildPrecisionDeposit: need integer leftTick < rightTick (${leftTick}, ${rightTick})`);
  }
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, pool.tokenX, amountX, 'bucket_x', opts.fee, 'fee_x'),
    ...withdrawWithFee(account, pool.tokenY, amountY, 'bucket_y', opts.fee, 'fee_y'),
    `CALL_METHOD Address("${assertAddress(pool.address, 'pool')}") "add_liquidity" ${i32Arg(leftTick, 'leftTick')} ${i32Arg(rightTick, 'rightTick')} Bucket("bucket_x") Bucket("bucket_y");`,
    rtm.depositBatch(account),
  );
}

/// CaviarNine QuantaSwap — concentrated, bin-distributed, NFT receipt.
/// add_liquidity(x_bucket, y_bucket, positions). `bins` are the on-grid bins to seed
/// (from concentrated.ts range helpers); the per-bin x/y split is computed here from
/// the POST-fee amounts so the positions sum to exactly the deposited buckets.
export function buildQuantaSwapDeposit(
  account: string, pool: ResolvedPool, bins: number[],
  amountX: string, amountY: string, opts: BuildOpts = {},
): string {
  if (pool.kind !== 'caviarnine_quantaswap') throw new Error(`buildQuantaSwapDeposit: unexpected kind ${pool.kind}`);
  if (pool.activeBin === undefined) throw new Error('buildQuantaSwapDeposit: pool.activeBin unknown (resolve first)');
  assertAmount(amountX, 'amountX');
  assertAmount(amountY, 'amountY');
  const rate = feeEnabled(opts.fee) ? opts.fee.rate : undefined;
  const positions = distributeQuanta(bins, pool.activeBin, netAfterFee(amountX, rate), netAfterFee(amountY, rate));
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, pool.tokenX, amountX, 'bucket_x', opts.fee, 'fee_x'),
    ...withdrawWithFee(account, pool.tokenY, amountY, 'bucket_y', opts.fee, 'fee_y'),
    `CALL_METHOD Address("${assertAddress(pool.address, 'pool')}") "add_liquidity" Bucket("bucket_x") Bucket("bucket_y") ${quantaPositionsArg(positions)};`,
    rtm.depositBatch(account),
  );
}

/// Ociswap PrecisionPool / CaviarNine QuantaSwap — remove, NFT receipt.
/// withdraw the position NFT (integer id for Ociswap, ruid for QuantaSwap) →
/// remove_liquidity(lp_nft) → (x, y). Same shape for both blueprints.
export function buildNftWithdraw(
  account: string, pool: ResolvedPool, localId: string, opts: BuildOpts = {},
): string {
  if (pool.lp.kind !== 'nft') throw new Error('buildNftWithdraw: LP is not an NFT');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdrawNonFungible(account, pool.lp.resource, localId),
    rtm.takeAll(pool.lp.resource, 'bucket_lp'),
    `CALL_METHOD Address("${assertAddress(pool.address, 'pool')}") "remove_liquidity" Bucket("bucket_lp");`,
    rtm.depositBatch(account),
  );
}

/// Ociswap BasicPool / CaviarNine WeightedPool — remove, fungible LP.
export function buildFungibleWithdraw(
  account: string, pool: ResolvedPool, lpAmount: string, opts: BuildOpts = {},
): string {
  if (pool.lp.kind !== 'fungible') throw new Error('buildFungibleWithdraw: LP is not fungible');
  assertAmount(lpAmount, 'lpAmount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdraw(account, pool.lp.resource, lpAmount),
    rtm.takeAll(pool.lp.resource, 'bucket_lp'),
    `CALL_METHOD Address("${assertAddress(pool.address, 'pool')}") "remove_liquidity" Bucket("bucket_lp");`,
    rtm.depositBatch(account),
  );
}

/// DefiPlaza PlazaPair — remove, via the router (which infers base/quote from the
/// LP token). `lpToken` is the pool's base-LP or quote-LP resource.
export function buildDefiplazaWithdraw(
  account: string, pool: ResolvedPool, lpToken: string, lpAmount: string, opts: BuildOpts = {},
): string {
  if (pool.kind !== 'defiplaza_pair' || !pool.router) throw new Error('buildDefiplazaWithdraw: not a PlazaPair');
  assertAmount(lpAmount, 'lpAmount');
  assertAddress(lpToken, 'lpToken');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdraw(account, lpToken, lpAmount),
    rtm.takeAll(lpToken, 'bucket_lp'),
    `CALL_METHOD Address("${assertAddress(pool.router, 'router')}") "remove_liquidity" Bucket("bucket_lp");`,
    rtm.depositBatch(account),
  );
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

export interface DepositRequest {
  account: string;
  pool: ResolvedPool;
  amountX?: string; // two-sided (Basic/Weighted) + concentrated (Precision/QuantaSwap)
  amountY?: string;
  inputToken?: string; // defiplaza single-sided
  inputAmount?: string;
  coAmount?: string;
  leftTick?: number; // ociswap_precision range (from concentrated.ts)
  rightTick?: number;
  bins?: number[]; // caviarnine_quantaswap range (from concentrated.ts)
  opts?: BuildOpts;
}

export function buildDeposit(r: DepositRequest): string {
  switch (r.pool.kind) {
    case 'ociswap_basic':
    case 'caviarnine_weighted':
      if (!r.amountX || !r.amountY) throw new Error('two-sided deposit needs amountX and amountY');
      return buildTwoSidedDeposit(r.account, r.pool, r.amountX, r.amountY, r.opts);
    case 'defiplaza_pair':
      if (!r.inputToken || !r.inputAmount) throw new Error('DefiPlaza deposit needs inputToken and inputAmount');
      return buildDefiplazaDeposit(r.account, r.pool, r.inputToken, r.inputAmount, r.coAmount, r.opts);
    case 'ociswap_precision':
      if (r.leftTick === undefined || r.rightTick === undefined || r.amountX === undefined || r.amountY === undefined) {
        throw new Error('precision deposit needs leftTick, rightTick, amountX, amountY (compute the range via concentrated.ts)');
      }
      return buildPrecisionDeposit(r.account, r.pool, r.leftTick, r.rightTick, r.amountX, r.amountY, r.opts);
    case 'caviarnine_quantaswap':
      if (!r.bins || r.bins.length === 0 || r.amountX === undefined || r.amountY === undefined) {
        throw new Error('quantaswap deposit needs bins, amountX, amountY (compute the range via concentrated.ts)');
      }
      return buildQuantaSwapDeposit(r.account, r.pool, r.bins, r.amountX, r.amountY, r.opts);
    default:
      throw new Error(`unsupported pool kind: ${r.pool.kind}`);
  }
}
