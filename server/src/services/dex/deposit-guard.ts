/// Deposit amount guard: every amount a user asks to deposit must (1) fit the
/// token's divisibility and (2) meet the minimum deposit. Deposits only: no
/// exit / withdraw path calls this module.
///
/// (1) Divisibility. A Radix fungible resource has a fixed divisibility d
/// (0..18): its amounts are whole multiples of 10^-d. The request validator
/// (rtm.ts assertAmount) accepts up to 18 decimal places for every token, so an
/// amount finer than the token allows used to reach the manifest and fail only
/// inside the Gateway dry-run, as a raw ledger error. This guard reads d from the
/// ledger and refuses such an amount with a plain 400. It never rounds: rounding
/// would build a manifest for an amount the user did not type.
///
/// (2) Minimum. MIN_DEPOSIT_XRD is checked twice:
///   - on the request: every XRD leg that is not zero must be >= the minimum,
///     and a deposit must have at least one such leg;
///   - on the dry-run: the XRD the account actually sends (net of any change the
///     pool hands back) must be >= the minimum. The request check alone is not
///     enough for ratio pools, which take only what the other leg matches.
/// The minimum is set in XRD because XRD is the only token whose value the
/// server can state without a price feed. A deposit that sends no XRD (a pair
/// without XRD, or a one-sided deposit of the other token) is refused until a
/// minimum for those is chosen (a product choice the code cannot derive).

import type { GatewayClient } from '../gateway.js';
import type { PreviewResult } from './preview.js';
import { toScaled, fromScaled } from './decimal.js';

export const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
/// XRD is fixed at 18 by the protocol; no ledger read is needed for it.
const XRD_DIVISIBILITY = 18;

/// The smallest deposit, in XRD. 10 XRD is the floor the advisor already uses
/// as its dust threshold for a position move (allocator.ts minRotationAmount,
/// rotation.ts "Minimum XRD to bother rotating"). The value is a product choice.
export const MIN_DEPOSIT_XRD = '10';

/// Caller-facing refusal. build-service maps it to DexBuildError (HTTP 400).
export class DepositAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepositAmountError';
  }
}

export interface DepositLeg {
  resource: string;
  /// Already shape-checked by rtm.ts assertAmount (plain decimal, <= 18 dp).
  amount: string;
  label: string;
}

/// Decimal places that carry value: trailing zeros do not count ('1.50' -> 1).
export function decimalPlaces(amount: string): number {
  const frac = amount.split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

/// Pure check (unit-tested). Throws DepositAmountError, never rounds.
export function assertFitsDivisibility(leg: DepositLeg, divisibility: number): void {
  const places = decimalPlaces(leg.amount);
  if (places > divisibility) {
    const unit = divisibility === 0 ? 'whole units only' : `at most ${divisibility} decimal places`;
    throw new DepositAmountError(
      `${leg.label} ${leg.amount} is finer than this token allows (${unit}); nothing was rounded, please re-enter it`,
    );
  }
}

/// Divisibility never changes once a resource exists, so a read is cached for
/// the life of the process.
const divisibilityCache = new Map<string, number>();
export function _clearDivisibilityCache(): void {
  divisibilityCache.clear();
}

/// Read each resource's divisibility from the ledger (one batched, read-only
/// Gateway call for the ones not cached). FAIL CLOSED: a resource whose
/// divisibility cannot be read, or that is not fungible, refuses the deposit.
export async function readDivisibility(
  gw: GatewayClient, resources: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const r of new Set(resources)) {
    if (r === XRD_RESOURCE) out.set(r, XRD_DIVISIBILITY);
    else if (divisibilityCache.has(r)) out.set(r, divisibilityCache.get(r) as number);
    else missing.push(r);
  }
  if (missing.length === 0) return out;
  let items: Awaited<ReturnType<GatewayClient['entityDetailsGlobal']>>['items'];
  try {
    items = (await gw.entityDetailsGlobal(missing)).items ?? [];
  } catch {
    throw new DepositAmountError('could not read the token divisibility from the ledger; try again shortly');
  }
  for (const r of missing) {
    const d = items.find((i) => i.address === r)?.details;
    const div = d?.divisibility;
    if (d?.type !== 'FungibleResource' || !Number.isInteger(div) || (div as number) < 0 || (div as number) > 18) {
      throw new DepositAmountError('could not read the token divisibility from the ledger; deposit refused');
    }
    divisibilityCache.set(r, div as number);
    out.set(r, div as number);
  }
  return out;
}

/// Pure request-level minimum (unit-tested). Returns the refusal text or undefined.
export function minimumDepositRefusal(legs: DepositLeg[], min: string = MIN_DEPOSIT_XRD): string | undefined {
  const xrdLegs = legs.filter((l) => l.resource === XRD_RESOURCE && toScaled(l.amount) > 0n);
  if (xrdLegs.length === 0) {
    return `the minimum deposit is ${min} XRD, and this deposit sends no XRD`;
  }
  for (const l of xrdLegs) {
    if (toScaled(l.amount) < toScaled(min)) {
      return `the minimum deposit is ${min} XRD (${l.label} is ${l.amount})`;
    }
  }
  return undefined;
}

/// Both amount checks for one deposit. Zero legs (a one-sided concentrated
/// deposit) carry nothing, so only non-zero legs are read and checked.
export async function checkDepositAmounts(gw: GatewayClient, legs: DepositLeg[]): Promise<void> {
  const live = legs.filter((l) => toScaled(l.amount) > 0n);
  if (live.length === 0) throw new DepositAmountError('deposit amount must be greater than zero');
  const below = minimumDepositRefusal(live);
  if (below) throw new DepositAmountError(below);
  const div = await readDivisibility(gw, live.map((l) => l.resource));
  for (const l of live) assertFitsDivisibility(l, div.get(l.resource) as number);
}

/// Dry-run minimum: the account's net XRD outflow must reach the minimum. A
/// preview that already failed is returned unchanged (its own error stands).
export function refuseBelowMinimum(preview: PreviewResult, min: string = MIN_DEPOSIT_XRD): PreviewResult {
  if (!preview.ok) return preview;
  const net = preview.movements.find((m) => m.resource === XRD_RESOURCE);
  const sent = net ? -toScaled(net.amount) : 0n;
  if (sent >= toScaled(min)) return preview;
  return {
    ...preview,
    ok: false,
    status: 'Refused',
    error:
      `The minimum deposit is ${min} XRD. After the pool takes its ratio, this deposit would send ` +
      `${fromScaled(sent > 0n ? sent : 0n)} XRD. Nothing was signed. Raise the amounts and try again.`,
  };
}
