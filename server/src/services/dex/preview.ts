/// Manifest preview — the non-custodial sign-gate.
///
/// Dry-runs a manifest via the Gateway (no signature, no key, no submission) and
/// summarizes the caller account's NET movement, so the UI can show "you send X,
/// you receive Y" and refuse to hand a failing manifest to the wallet. This is
/// the safety layer that replaces the old speculative preview decoder: the
/// numbers are what the ledger would actually do, not what we guessed.

import type { GatewayClient, PreviewResponse } from '../gateway.js';
import { toScaled, fromScaled } from './decimal.js';

export { toScaled, fromScaled } from './decimal.js';

export interface AccountMovement {
  resource: string;
  /// Signed decimal string. Negative = leaves the account, positive = received.
  amount: string;
}

export interface PreviewResult {
  ok: boolean; // receipt.status === 'Succeeded'
  status: string;
  error?: string;
  feeXrd?: string;
  movements: AccountMovement[];
}

export async function previewManifest(
  gw: GatewayClient,
  manifest: string,
  account: string,
): Promise<PreviewResult> {
  const epoch = await gw.getCurrentEpoch();
  const res = await gw.previewTransaction(manifest, epoch);
  return summarizePreview(res, account);
}

/// Pure summarizer (unit-testable without the network).
export function summarizePreview(res: PreviewResponse, account: string): PreviewResult {
  const status = res.receipt?.status ?? 'Unknown';
  const ok = status === 'Succeeded';
  return {
    ok,
    status,
    error: ok ? undefined : (res.receipt?.error_message ?? status),
    feeXrd: res.receipt?.fee_summary ? sumXrdFee(res.receipt.fee_summary) : undefined,
    movements: accountMovements(res, account),
  };
}

/// Net per-resource change for `account`, summed across all instructions.
function accountMovements(res: PreviewResponse, account: string): AccountMovement[] {
  const totals = new Map<string, bigint>();
  for (const group of res.resource_changes ?? []) {
    for (const c of group.resource_changes ?? []) {
      if (c.component_entity?.entity_address !== account) continue;
      totals.set(c.resource_address, (totals.get(c.resource_address) ?? 0n) + toScaled(c.amount));
    }
  }
  return [...totals.entries()]
    .filter(([, v]) => v !== 0n)
    .map(([resource, v]) => ({ resource, amount: fromScaled(v) }));
}

function sumXrdFee(fee: Record<string, string>): string {
  let total = 0n;
  for (const [k, v] of Object.entries(fee)) {
    if (/^xrd_total_.*_cost$/.test(k)) total += toScaled(v);
  }
  return fromScaled(total);
}

/// Fail-closed fill check for an LSULP exit (CaviarNine LSU pool `remove_liquidity`).
///
/// The pool pays out in the one validator LSU the caller names. If its main vault
/// for that LSU is short, the call does NOT panic: it part-fills and hands the
/// unfilled LSULP back, and the dry-run still reports `Succeeded`. So `ok` alone
/// is not a safe sign gate for this exit. The account's NET LSULP movement must
/// equal exactly `-amount`; anything less means LSULP came back and the exit only
/// partly happened, so the preview is turned into a refusal. Funds are not at risk
/// in the part-fill case; the refusal exists so the user is never asked to sign
/// something that does less than they asked for. A preview that already failed is
/// returned unchanged.
export function refuseLsulpPartFill(
  preview: PreviewResult,
  lsulpResource: string,
  amount: string,
): PreviewResult {
  if (!preview.ok) return preview;
  const net = preview.movements.find((m) => m.resource === lsulpResource);
  const spent = net ? -toScaled(net.amount) : 0n;
  const requested = toScaled(amount);
  if (spent >= requested) return preview;
  const returned = fromScaled(requested - spent);
  return {
    ...preview,
    ok: false,
    status: 'Refused',
    error:
      `The LSU pool cannot fill this exit in full: ${returned} of the ${amount} LSULP would come back to you ` +
      `unredeemed. Nothing was signed. Try a smaller amount or exit in several parts.`,
  };
}
