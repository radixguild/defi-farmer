/// Verified position recording (PHASE-3.1-DESIGN D5).
///
/// The client claims only (intent_hash, pool_address). Everything that lands
/// in the DB is taken from the Gateway's committed-details for that hash —
/// fail-closed:
///   1. Transaction is CommittedSuccess.
///   2. The claimed pool AND the session's account are affected entities.
///   3. The session's account RECEIVED the position: a receipt NFT
///      (Precision/QuantaSwap — that resource + local id build the withdraw
///      manifest), or, when no NFT was minted, the pool's fungible LP
///      (Basic/Weighted pool unit; DefiPlaza base-/quote-LP) — identified via
///      runtime pool resolution so an arbitrary inflow can't pose as the LP.
///   4. The deposited token/amount = the account's largest fungible outflow.
/// Duplicate intent hashes return the existing row (idempotent).

import { getDb } from '../db/schema.js';
import type { CommittedTx } from './gateway.js';
import type { LpModel } from './dex/pool-resolver.js';

const INTENT_HASH_RE = /^txid_(rdx|tdx_2_)1[a-z0-9]{20,90}$/;
const POOL_ADDRESS_RE = /^(component|pool)_(rdx|tdx_2_)1[a-z0-9]{20,80}$/;

export interface RecordedPosition {
  id: number;
  pool_address: string;
  protocol: string;
  receipt_resource: string | null;
  receipt_id: string | null;
  /// Fungible-LP positions only: the LP amount received (raw Gateway decimal
  /// string — what buildFungibleWithdraw/buildDefiplazaWithdraw consume).
  lp_amount: string | null;
  token_a: string;
  deposited_amount: string;
  intent_hash: string;
}

export type RecordResult =
  | { ok: true; created: boolean; position: RecordedPosition }
  | { ok: false; status: number; error: string };

type FetchCommitted = (intentHash: string) => Promise<CommittedTx>;
type ExistingRow = RecordedPosition & { user_address: string | null };

/// The idempotent result for an intent_hash that is already recorded: the same
/// account gets its row back (created:false); a different account gets a 409 and
/// never sees someone else's row.
function idempotentExisting(row: ExistingRow, userAddress: string): RecordResult {
  if (row.user_address !== userAddress) {
    return { ok: false, status: 409, error: 'Transaction already recorded' };
  }
  return { ok: true, created: false, position: row };
}
/// Runtime pool resolution (dex/pool-resolver.ts) — only invoked on the
/// fungible-LP fallback, so the NFT path never gains a Gateway call.
export type ResolveLp = (poolAddress: string) => Promise<{ lp: LpModel; protocol: string }>;

export type CloseResult =
  | { ok: true; alreadyClosed: boolean; position: { id: number; status: string } }
  | { ok: false; status: number; error: string };

/// Verified close (the exit half of D5). Until this existed, nothing ever
/// wrote status='closed' — an exited position stayed in the portfolio total
/// forever, so "manage" could begin but never end.
///
/// Same trust model as recordDeposit: the caller claims only (id, intent_hash);
/// everything asserted comes from the Gateway's committed-details. Fail-closed:
///   1. Row exists, belongs to the caller, and is 'active'.
///   2. Transaction is CommittedSuccess.
///   3. It touches BOTH the position's pool and the row owner's account.
///   4. The owner's account genuinely gave the position back: an outflow of
///      the recorded LP resource, or the recorded receipt NFT leaving the
///      account. Any committed tx that merely touches the pool (a fresh
///      deposit, someone else's withdraw batched with a transfer to you)
///      does NOT close the row.
/// Re-closing with the SAME hash is idempotent; a different hash on a closed
/// row is a 409, because two exits of one position is a bookkeeping error
/// someone needs to see.
export async function closePosition(
  fetchCommitted: FetchCommitted,
  input: { positionId: unknown; intentHash: unknown; userAddress: string | null; isOperator: boolean },
): Promise<CloseResult> {
  const { positionId, intentHash, userAddress, isOperator } = input;

  const id = typeof positionId === 'number' ? positionId : parseInt(String(positionId), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, error: 'Invalid position id' };
  }
  if (typeof intentHash !== 'string' || !INTENT_HASH_RE.test(intentHash)) {
    return { ok: false, status: 400, error: 'Invalid intent_hash' };
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as
    | (ExistingRow & { status: string; close_intent_hash: string | null })
    | undefined;
  if (!row) return { ok: false, status: 404, error: 'Position not found' };

  // Ownership: the session that recorded it, or the operator. Verification
  // below runs against the ROW's owner either way — the operator credential
  // widens who may ask, never whose account the evidence must involve.
  const owner = row.user_address;
  if (!isOperator && (!userAddress || owner !== userAddress)) {
    return { ok: false, status: 403, error: 'Not your position' };
  }
  if (!owner) {
    // NULL-owner (agent-era) rows have no account to verify the withdraw
    // against; closing one unverified would be exactly the hole D5 closed.
    return { ok: false, status: 409, error: 'Position has no owner account to verify against' };
  }

  if (row.status !== 'active') {
    if (row.close_intent_hash === intentHash) {
      return { ok: true, alreadyClosed: true, position: { id, status: row.status } };
    }
    return { ok: false, status: 409, error: `Position is already ${row.status}` };
  }

  let tx: CommittedTx;
  try {
    tx = await fetchCommitted(intentHash);
  } catch {
    return { ok: false, status: 502, error: 'Gateway lookup failed — try again' };
  }
  if (tx.status !== 'CommittedSuccess') {
    return { ok: false, status: 409, error: `Transaction not committed (status: ${tx.status})` };
  }
  if (!tx.affectedEntities.includes(row.pool_address)) {
    return { ok: false, status: 400, error: 'Transaction does not touch this position\'s pool' };
  }
  if (!tx.affectedEntities.includes(owner)) {
    return { ok: false, status: 403, error: 'Transaction does not involve the position\'s account' };
  }

  // The position came BACK OUT of the owner's account.
  const gaveBack = row.receipt_id
    ? tx.nonFungible.some(
        (c) =>
          c.entity === owner &&
          c.resource === row.receipt_resource &&
          c.removed.some((rid) => rid.replace(/#/g, '') === row.receipt_id),
      )
    : tx.fungible.some(
        (c) =>
          c.entity === owner &&
          c.resource === row.receipt_resource &&
          c.change.startsWith('-'),
      );
  if (!gaveBack) {
    return {
      ok: false,
      status: 400,
      error: 'Transaction does not return this position (no receipt/LP outflow from the owner account)',
    };
  }

  // Guarded UPDATE: status='active' in the WHERE makes the close race-safe —
  // two concurrent closes serialize on SQLite's writer lock and the loser
  // matches zero rows, then reads the winner's outcome.
  const res = db
    .prepare(
      `UPDATE positions SET status = 'closed', close_intent_hash = ?,
         closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'active'`,
    )
    .run(intentHash, id);
  if (res.changes === 0) {
    const now = db.prepare('SELECT status, close_intent_hash FROM positions WHERE id = ?').get(id) as
      | { status: string; close_intent_hash: string | null }
      | undefined;
    if (now?.close_intent_hash === intentHash) {
      return { ok: true, alreadyClosed: true, position: { id, status: now.status } };
    }
    return { ok: false, status: 409, error: `Position is already ${now?.status ?? 'gone'}` };
  }

  return { ok: true, alreadyClosed: false, position: { id, status: 'closed' } };
}

export async function recordDeposit(
  fetchCommitted: FetchCommitted,
  input: { intentHash: unknown; poolAddress: unknown; userAddress: string },
  resolveLp: ResolveLp,
): Promise<RecordResult> {
  const { intentHash, poolAddress, userAddress } = input;

  if (typeof intentHash !== 'string' || !INTENT_HASH_RE.test(intentHash)) {
    return { ok: false, status: 400, error: 'Invalid intent_hash' };
  }
  if (typeof poolAddress !== 'string' || !POOL_ADDRESS_RE.test(poolAddress)) {
    return { ok: false, status: 400, error: 'Invalid pool_address' };
  }

  const db = getDb();

  // Idempotent: the unique partial index on positions.intent_hash makes this
  // race-safe; the pre-check just gives a friendly 200.
  const existing = db
    .prepare('SELECT * FROM positions WHERE intent_hash = ?')
    .get(intentHash) as ExistingRow | undefined;
  if (existing) return idempotentExisting(existing, userAddress);

  let tx: CommittedTx;
  try {
    tx = await fetchCommitted(intentHash);
  } catch {
    return { ok: false, status: 502, error: 'Gateway lookup failed — try again' };
  }

  if (tx.status !== 'CommittedSuccess') {
    return { ok: false, status: 409, error: `Transaction not committed (status: ${tx.status})` };
  }
  if (!tx.affectedEntities.includes(poolAddress)) {
    return { ok: false, status: 400, error: 'Transaction does not touch the claimed pool' };
  }
  if (!tx.affectedEntities.includes(userAddress)) {
    return { ok: false, status: 403, error: 'Transaction does not involve your account' };
  }

  // The position the account received.
  const receipt = tx.nonFungible.find((c) => c.entity === userAddress && c.added.length > 0);
  let receiptResource: string | null = null;
  let receiptId: string | null = null;
  let lpAmount: string | null = null;
  let resolvedProtocol: string | null = null;

  if (receipt) {
    receiptResource = receipt.resource;
    // Local ids arrive as "#42#" (Ociswap integer) or "{…}" (QuantaSwap ruid) —
    // integers are stored bare (assertNfLocalId normalizes them back to #n#),
    // ruids keep their braces (accepted verbatim).
    receiptId = receipt.added[0].replace(/#/g, '');
  } else {
    let resolved: { lp: LpModel; protocol: string };
    try {
      resolved = await resolveLp(poolAddress);
    } catch {
      return { ok: false, status: 502, error: 'Pool resolution failed — try again' };
    }
    if (resolved.lp.kind === 'nft') {
      return { ok: false, status: 400, error: 'No receipt NFT was minted to your account in this transaction' };
    }
    const lpResources =
      resolved.lp.kind === 'defiplaza'
        ? [resolved.lp.baseLp, resolved.lp.quoteLp]
        : [resolved.lp.resource];
    // Largest LP inflow = the position. A DefiPlaza co-liquidity add can mint
    // both sides' LPs — the co side stays in the user's wallet untracked.
    // Amounts are kept as the raw Gateway decimal string: the withdraw
    // builders' assertAmount rejects float-mangled forms (e.g. "1e-7").
    const lpInflows = tx.fungible
      .filter(
        (c) =>
          c.entity === userAddress &&
          lpResources.includes(c.resource) &&
          !c.change.startsWith('-') &&
          parseFloat(c.change) > 0,
      )
      .sort((a, b) => parseFloat(b.change) - parseFloat(a.change));
    if (lpInflows.length === 0) {
      return { ok: false, status: 400, error: 'No receipt NFT or LP tokens were received by your account in this transaction' };
    }
    receiptResource = lpInflows[0].resource;
    lpAmount = lpInflows[0].change;
    resolvedProtocol = resolved.protocol;
  }

  // Deposited token = the account's largest fungible outflow (fees are XRD
  // dust next to a deposit; if the deposit itself is XRD the summed outflow
  // is still the dominant one).
  const outflows = tx.fungible
    .filter((c) => c.entity === userAddress && c.change.startsWith('-'))
    .map((c) => ({ resource: c.resource, amount: Math.abs(parseFloat(c.change)) }))
    .sort((a, b) => b.amount - a.amount);
  if (outflows.length === 0) {
    return { ok: false, status: 400, error: 'No deposit outflow found for your account' };
  }
  const deposit = outflows[0];

  // Protocol: the resolver's (real blueprint) when we resolved for the LP
  // fallback; otherwise our own scan data — 'unknown' is fine, display-only.
  const known = resolvedProtocol
    ? undefined
    : (db
        .prepare('SELECT protocol FROM pool_snapshots WHERE pool_address = ? ORDER BY scanned_at DESC LIMIT 1')
        .get(poolAddress) as { protocol: string } | undefined);
  const protocol = resolvedProtocol ?? known?.protocol ?? 'unknown';

  let result: { lastInsertRowid: number | bigint };
  try {
    result = db
      .prepare(
        `INSERT INTO positions
           (protocol, pool_address, receipt_id, receipt_resource, lp_amount, token_a,
            deposited_amount, status, user_address, intent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        protocol,
        poolAddress,
        receiptId,
        receiptResource,
        lpAmount,
        deposit.resource,
        String(deposit.amount),
        userAddress,
        intentHash,
      );
  } catch (err) {
    // Concurrent duplicate: the pre-check SELECT and this INSERT straddle the
    // Gateway + resolver awaits, so two requests for the same NEW intent_hash
    // can both pass the pre-check. The UNIQUE partial index (idx_positions_intent)
    // makes the loser throw here — recover the winner's row and return it
    // idempotently (the header's race-safe promise). Rethrow anything else.
    const row = db
      .prepare('SELECT * FROM positions WHERE intent_hash = ?')
      .get(intentHash) as ExistingRow | undefined;
    if (row) return idempotentExisting(row, userAddress);
    throw err;
  }

  return {
    ok: true,
    created: true,
    position: {
      id: Number(result.lastInsertRowid),
      pool_address: poolAddress,
      protocol,
      receipt_resource: receiptResource,
      receipt_id: receiptId,
      lp_amount: lpAmount,
      token_a: deposit.resource,
      deposited_amount: String(deposit.amount),
      intent_hash: intentHash,
    },
  };
}
