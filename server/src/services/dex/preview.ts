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
