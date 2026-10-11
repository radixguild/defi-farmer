/// Non-custodial deposit AND exit manifest builders for the SINGLE-SIDED venues
/// that do not fit the two-sided LP pool-resolver: native XRD validator staking,
/// CaviarNine LSULP liquid staking, and Weft V2 lending supply.
///
/// Each builder produces a Radix Transaction Manifest the USER signs in their own
/// wallet — funds go straight to the venue, never through defi-farmer. Interfaces
/// were verified against live mainnet (committed-tx evidence, 2026-08-11 for the
/// deposit half, 2026-08-13 for the exit half — real txids cited per builder);
/// every built manifest is preview-gated (dex/preview.ts) before it reaches a
/// wallet, exactly like the LP builders. The optional platform fee reuses the
/// SAME fee-out-of-input splice as the LP builders (withdrawWithFee), and the
/// network fee follows the same rule as theirs: no `lock_fee` unless the caller
/// asks for one (rtm.ts optionalLockFee — the wallet locks the fee itself).
///
/// This module is PURE — no network, no clock. Everything an exit needs to be
/// resolved from the ledger (a validator's stake-unit / claim-NFT resources, the
/// Weft deposit-unit resource, a claim's readiness) lives in venue-exit.ts, so
/// the manifest shapes stay unit-testable without a Gateway.
///
/// EXITS TAKE NO PLATFORM FEE. The LP withdraw builders (manifests.ts) do not
/// splice one either, and taxing an exit is the one place a "trivially
/// strippable" fee turns into a reason not to use the app at all.

import { rtm, manifest, assertAddress, assertAmount, optionalLockFee } from './rtm.js';
import { withdrawWithFee, type BuildOpts } from './manifests.js';
import { XRD_STAKING_ADDRESS } from '../staking.js';
import { WEFT_V2_LENDING_COMPONENT } from '../weft.js';
import { LSU_POOL_COMPONENT, LSULP_RESOURCE } from '../lsu-pool.js';

const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// The single-sided venue kinds, distinct from the LP PoolKind space. They are
/// dispatched from the opportunity's synthetic address (see detectVenue), never
/// from a pool blueprint.
export type VenueKind = 'native_stake' | 'weft_lending' | 'lsulp';

/// The `weft-v2:` opportunity id prefix (weft.ts sets address:`weft-v2:${XRD}`).
const WEFT_ID_PREFIX = 'weft-v2:';

/// Classify an opportunity address into a single-sided venue, or null if it is a
/// normal LP pool (→ the existing pool-resolver path). Pure; no network.
export function detectVenue(address: string): VenueKind | null {
  if (address === XRD_STAKING_ADDRESS) return 'native_stake';
  if (address.startsWith(WEFT_ID_PREFIX)) return 'weft_lending';
  if (address === LSU_POOL_COMPONENT) return 'lsulp';
  return null;
}

/// Native validator staking: withdraw XRD → validator.stake(bucket) → the
/// validator's Liquid Stake Unit (LSU) sweeps back via deposit_batch.
/// `validator` is a validator_rdx1… Component (the board's top realized payer).
/// Verified shape (3 committed mainnet txs): a single Bucket arg, no proof.
export function buildStakeDeposit(
  account: string, validator: string, amount: string, opts: BuildOpts = {},
): string {
  assertAmount(amount, 'amount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, XRD_RESOURCE, amount, 'bucket_xrd', opts.fee, 'fee_xrd'),
    `CALL_METHOD Address("${assertAddress(validator, 'validator')}") "stake" Bucket("bucket_xrd");`,
    rtm.depositBatch(account),
  );
}

/// Weft V2 lending supply: withdraw XRD → LendingPool.deposit(Array<Bucket>[xrd])
/// → w2-XRD deposit units sweep back. The method is public/permissionless and
/// multi-asset (Array<Bucket>); a single-asset supply passes exactly one bucket.
export function buildWeftSupplyDeposit(
  account: string, amount: string, opts: BuildOpts = {},
): string {
  assertAmount(amount, 'amount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, XRD_RESOURCE, amount, 'bucket_xrd', opts.fee, 'fee_xrd'),
    `CALL_METHOD Address("${assertAddress(WEFT_V2_LENDING_COMPONENT, 'weft')}") "deposit" Array<Bucket>(Bucket("bucket_xrd"));`,
    rtm.depositBatch(account),
  );
}

/// CaviarNine LSULP: the LSU Pool's add_liquidity takes an LSU bucket, NOT XRD —
/// so an XRD deposit is two legs in one signed tx: stake XRD at `validator` to
/// mint that validator's LSU, then add_liquidity(lsu_bucket, None) to mint LSULP
/// (+ an LSUCR receipt NFT). Both sweep back via deposit_batch. `lsuResource` is
/// the chosen validator's state.stake_unit_resource_address (board `lsuOf`).
/// The pool only accepts LSUs from validators it recognizes; a non-accepted
/// validator fails the Gateway preview (the sign-gate), never a wallet.
export function buildLsulpDeposit(
  account: string, validator: string, lsuResource: string, amount: string, opts: BuildOpts = {},
): string {
  assertAmount(amount, 'amount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    ...withdrawWithFee(account, XRD_RESOURCE, amount, 'bucket_xrd', opts.fee, 'fee_xrd'),
    // leg 1: XRD → LSU (the LSU lands on the worktop)
    `CALL_METHOD Address("${assertAddress(validator, 'validator')}") "stake" Bucket("bucket_xrd");`,
    rtm.takeAll(lsuResource, 'bucket_lsu'),
    // leg 2: LSU → LSULP (+ receipt NFT). Enum<0u8>() = None credit_proof (fresh deposit).
    `CALL_METHOD Address("${assertAddress(LSU_POOL_COMPONENT, 'lsu_pool')}") "add_liquidity" Bucket("bucket_lsu") Enum<0u8>();`,
    rtm.depositBatch(account),
  );
}

// ─── exits ────────────────────────────────────────────────────────────────────

/// The protocol's unstake unbonding delay, MEASURED on mainnet 2026-08-13 rather
/// than recalled from docs: a real `validator.unstake` committed in epoch 334597
/// (`txid_rdx1cevm52auajdrxjf4uvzgn3cfcgrpded9flq5q25s5przyawggm0setkcm0`) minted
/// a Stake Claim whose `claim_epoch` is 336613 → exactly 2016 epochs. Mainnet
/// epochs run 300 s (cross-checked over an 18,990-epoch span between two sampled
/// ledger timestamps → 300.0 s/epoch), so 2016 × 300 s = 7 days to the second.
export const UNBONDING_EPOCHS = 2016;
export const EPOCH_SECONDS = 300;
export const UNBONDING_DAYS = (UNBONDING_EPOCHS * EPOCH_SECONDS) / 86_400;

/// Copy the UI MUST show beside any unstake. The failure this prevents is a user
/// signing an unstake believing it returns XRD: it does not — it burns the stake
/// units and mints a Stake Claim NFT that is worth nothing until a SECOND
/// transaction is signed a week later. Kept next to the builder so the manifest
/// and the sentence describing it cannot drift apart.
export const UNSTAKE_NOTICE =
  `Unstaking is two-phase. This transaction converts your stake units into a Stake Claim NFT — ` +
  `it does NOT return XRD. The XRD becomes claimable after the protocol's ${UNBONDING_EPOCHS}-epoch ` +
  `unbonding delay (~${UNBONDING_DAYS} days), and you must sign a second "claim" transaction then. ` +
  `Your XRD earns no staking rewards while it is unbonding, and the delay cannot be shortened or cancelled.`;

/// LSULP → LSU is instant and needs no unbonding, but it does NOT end in XRD.
export const LSULP_TO_LSU_NOTICE =
  `This returns liquid stake units (LSU), not XRD. LSUs keep earning validator rewards. ` +
  `To reach XRD you must then unstake them, which starts the ~${UNBONDING_DAYS}-day unbonding delay.`;

/// Weft supply is withdrawable on demand only while the pool has idle liquidity.
export const WEFT_WITHDRAW_NOTICE =
  `Weft repays supply withdrawals out of the pool's un-borrowed liquidity. If utilization is at its ` +
  `cap the withdrawal fails in dry-run and nothing is signed — reduce the amount or wait for repayments.`;

/// Native validator UNSTAKE (phase 1 of 2). Spends the validator's STAKE UNIT
/// resource — never XRD — and returns a Stake Claim NFT, not XRD.
/// `lsuResource` MUST be the validator's own `state.stake_unit_resource_address`
/// (resolved on-ledger by venue-exit.ts, never trusted from the caller).
/// Verified shape against the real committed mainnet unstake
/// `txid_rdx1x289695nz6st7yf64memuzldez7nvnqpdkk0u2tv3usjjc52j58sz2gs3w`:
///   withdraw(LSU) → TAKE_ALL → validator.unstake(bucket) → deposit_batch.
export function buildStakeUnstake(
  account: string, validator: string, lsuResource: string, amount: string, opts: BuildOpts = {},
): string {
  assertPositiveAmount(amount, 'amount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdraw(account, lsuResource, amount),
    rtm.takeAll(lsuResource, 'bucket_lsu'),
    `CALL_METHOD Address("${assertAddress(validator, 'validator')}") "unstake" Bucket("bucket_lsu");`,
    rtm.depositBatch(account),
  );
}

/// Native validator CLAIM (phase 2 of 2). Burns the Stake Claim NFT and returns
/// the unbonded XRD. Only executable at/after the NFT's `claim_epoch` — the
/// caller is expected to gate on venue-exit.ts's readiness read, and the Gateway
/// preview refuses it early regardless.
/// `claimNftResource` MUST be the validator's own `state.claim_token_resource_address`.
/// Local ids are RUIDs (`{16hex-16hex-16hex-16hex}`) — assertNfLocalId already
/// accepts that form, which Ociswap's integer ids do not share.
/// Verified against the real committed mainnet claim
/// `txid_rdx1zzg00z2mx4nayxqtrakd473mj4xfhl6dfkue8uahswm5vxhyuthqwgc24d`:
///   withdraw_non_fungibles(claim) → TAKE_ALL → validator.claim_xrd(bucket) → deposit_batch.
export function buildStakeClaim(
  account: string, validator: string, claimNftResource: string, localId: string, opts: BuildOpts = {},
): string {
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdrawNonFungible(account, claimNftResource, localId),
    rtm.takeAll(claimNftResource, 'bucket_claim'),
    `CALL_METHOD Address("${assertAddress(validator, 'validator')}") "claim_xrd" Bucket("bucket_claim");`,
    rtm.depositBatch(account),
  );
}

/// Weft V2 lending WITHDRAW — the exact mirror of the supply builder: spend the
/// pool's deposit units (w2-XRD), receive the underlying. Single-phase, no
/// unbonding. `depositUnitResource` is the pool's own `deposit_unit_res_address`
/// (resolved on-ledger by venue-exit.ts from the same V2 KVS weft.ts reads).
/// Verified against the real committed mainnet withdrawals
/// `txid_rdx1rh2cuswe5y8wn2wu8qu22sqxr52ks457pm6vzwvc63h77lrnvrtqul2hdy` and
/// `txid_rdx12e2gtpkxjlw8d77qra8ssws9u3aavkq5dpzsze7vflkwwrz77tfqm080xj`:
///   withdraw(w2) → TAKE → LendingPool.withdraw(Array<Bucket>) → deposit_batch.
export function buildWeftSupplyWithdraw(
  account: string, depositUnitResource: string, amount: string, opts: BuildOpts = {},
): string {
  assertPositiveAmount(amount, 'amount');
  return manifest(
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdraw(account, depositUnitResource, amount),
    rtm.takeAll(depositUnitResource, 'bucket_w2'),
    `CALL_METHOD Address("${assertAddress(WEFT_V2_LENDING_COMPONENT, 'weft')}") "withdraw" Array<Bucket>(Bucket("bucket_w2"));`,
    rtm.depositBatch(account),
  );
}

/// CaviarNine LSULP exit. The pool's `remove_liquidity` takes THREE args, not one
/// (this is the shape a naive mirror of `add_liquidity` gets wrong):
///   remove_liquidity(lsulp: Bucket, target_lsu: ResourceAddress, Option<..> = None)
/// The caller CHOOSES which validator's LSU to be paid in — the pool does not
/// hand back "your" LSU — so `targetLsuResource` must be an LSU the pool actually
/// holds enough of, else the dry-run fails (the sign-gate).
///
/// `unstakeValidator` selects the exit's terminus:
///   - undefined → stop at the LSU (instant, still earning, NOT XRD).
///   - set       → chain `validator.unstake` in the SAME signed transaction, which
///                 starts the ~7-day unbonding and returns a Stake Claim NFT.
/// It MUST be the validator that issued `targetLsuResource`; venue-exit.ts derives
/// the pair from validator state so the two can never be mismatched here.
/// Verified against three real committed mainnet exits, all of which chain the
/// unstake exactly this way, e.g.
/// `txid_rdx1cevm52auajdrxjf4uvzgn3cfcgrpded9flq5q25s5przyawggm0setkcm0`.
export function buildLsulpWithdraw(
  account: string, amount: string, targetLsuResource: string,
  unstakeValidator?: string, opts: BuildOpts = {},
): string {
  assertPositiveAmount(amount, 'amount');
  assertAddress(targetLsuResource, 'targetLsuResource');
  const lines = [
    ...optionalLockFee(account, opts.lockFee),
    rtm.withdraw(account, LSULP_RESOURCE, amount),
    rtm.takeAll(LSULP_RESOURCE, 'bucket_lsulp'),
    // Enum<0u8>() = None. Every observed real exit passes None here; the
    // credit-receipt (LSUCR) discount path is NOT verified against mainnet.
    `CALL_METHOD Address("${assertAddress(LSU_POOL_COMPONENT, 'lsu_pool')}") "remove_liquidity" Bucket("bucket_lsulp") Address("${targetLsuResource}") Enum<0u8>();`,
  ];
  if (unstakeValidator !== undefined) {
    lines.push(
      rtm.takeAll(targetLsuResource, 'bucket_lsu'),
      `CALL_METHOD Address("${assertAddress(unstakeValidator, 'unstakeValidator')}") "unstake" Bucket("bucket_lsu");`,
    );
  }
  lines.push(rtm.depositBatch(account));
  return manifest(...lines);
}

/// Exits additionally reject ZERO, which `assertAmount` alone accepts.
/// This is a case the sign-gate structurally cannot catch: unstaking 0 units is
/// a perfectly valid manifest that previews `Succeeded`, so the user would sign
/// and pay a network fee to move nothing. Same family as the "preview cannot
/// catch a valid-but-wrong range" gotcha in docs/DEX-INTEGRATION.md.
function assertPositiveAmount(s: string, label: string): string {
  assertAmount(s, label);
  if (/^0(\.0+)?$/.test(s)) throw new Error(`Invalid ${label}: must be greater than zero`);
  return s;
}
