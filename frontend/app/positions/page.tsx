"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { usePositions, useRotationPending, useHoldings, useStakeClaims } from "@/lib/hooks";
import { useWallet } from "@/lib/hooks/use-wallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HealthDot } from "@/components/health-dot";
import { SparklineChart } from "@/components/sparkline-chart";
import { DataSourceBanner } from "@/components/data-source-banner";
import { DexPreviewModal } from "@/components/dex-preview-modal";
import { ClaimsSection } from "@/components/claims-section";
import { buildDex, type DexBuildRequest, type DexBuildResult, type StakeClaim } from "@/lib/api/dex";
import { exitOptionsFor, claimRequestFor, type ExitOption } from "@/lib/venues";
import { Holding, Position, RotationEntry } from "@/lib/types";

function getHealthStatus(position: Position): "healthy" | "warning" | "critical" {
  if (position.status === "exit_signal") return "critical";
  const pnlPct = ((position.current_value_xrd - position.deposited_xrd) / position.deposited_xrd) * 100;
  if (pnlPct < -10) return "critical";
  if (position.apy_7d_ma < 5) return "warning";
  return "healthy";
}

function formatXrd(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function SkeletonCard() {
  return (
    <Card className="animate-pulse">
      <CardHeader>
        <div className="h-4 w-24 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="h-6 w-32 rounded bg-muted" />
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-10 w-full rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

function ConfirmModal({
  open,
  title,
  message,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border rounded-lg p-6 max-w-sm mx-4 shadow-lg">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-4">{message}</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function PositionCard({
  position,
  onExit,
  actionsDisabled,
  actionsDisabledReason,
}: {
  position: Position;
  onExit: () => void;
  /** True when the position list is not "live" — disables write actions. */
  actionsDisabled: boolean;
  actionsDisabledReason: string;
}) {
  const pnl = position.current_value_xrd - position.deposited_xrd;
  const pnlPct = (pnl / position.deposited_xrd) * 100;
  const health = getHealthStatus(position);
  // FEE income only. The positions API carries the pool's gross fee APY and no
  // IL estimate, so this cannot be a net projection — and on Radix today the IL
  // term is large enough to flip most pools negative. It is labelled as fees
  // rather than as earnings so it is not read as take-home yield.
  const projectedFees = (position.current_value_xrd * position.apy_7d_ma) / 100;

  // Estimated trajectory between deposit value and current value. The
  // backend doesn't yet track historical position value, so this is a
  // smoothed interpolation, NOT a real time series. Labelled "Estimated"
  // so the user doesn't read it as ground truth. Replace with real
  // historical position data once the backend ships per-position
  // value snapshots.
  const sparklineData = Array.from({ length: 7 }, (_, i) => {
    const base = position.deposited_xrd;
    const growth = (position.current_value_xrd - base) / 7;
    return base + growth * (i + 1) + (Math.sin(i) * growth * 0.3);
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{position.pool_name}</CardTitle>
          <HealthDot status={health} />
        </div>
        <span className="text-xs text-muted-foreground capitalize">
          {position.protocol}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Current Value</span>
          <span className="text-lg font-bold">
            {formatXrd(position.current_value_xrd)} XRD
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">P&L</span>
          <span
            className={`text-sm font-medium ${
              pnl >= 0 ? "text-profit-green" : "text-loss-red"
            }`}
          >
            {pnl >= 0 ? "+" : ""}{formatXrd(pnl)} XRD ({pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(1)}%)
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Projected fees (annual)
          </span>
          <span
            className={`text-sm font-medium ${
              projectedFees > 0
                ? "text-profit-green"
                : projectedFees < 0
                ? "text-loss-red"
                : "text-muted-foreground"
            }`}
            title="Fee income only — impermanent loss is not subtracted here."
          >
            {projectedFees > 0 ? "+" : ""}
            {formatXrd(projectedFees)} XRD
          </span>
        </div>
        <div className="space-y-1">
          <div className="h-12">
            <SparklineChart data={sparklineData} />
          </div>
          <p
            className="text-[10px] uppercase tracking-wider text-muted-foreground/70 text-right"
            title="Smoothed line between deposit value and current value. Backend doesn't yet track historical per-position value — read this as an approximation, not ground truth."
          >
            Estimated
          </p>
        </div>
        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            variant="destructive"
            className="flex-1"
            // Exit needs either the receipt NFT id (Precision/QuantaSwap) or
            // the fungible-LP resource + amount (Basic/Weighted/DefiPlaza).
            // Rows seeded before position tracking may have neither — keep
            // those disabled with an explanation instead of a dead-end.
            disabled={
              actionsDisabled ||
              !(position.receipt_id || (position.lp_amount && position.receipt_resource))
            }
            title={
              actionsDisabled
                ? actionsDisabledReason
                : !(position.receipt_id || (position.lp_amount && position.receipt_resource))
                  ? "This position has no receipt NFT or LP amount on record. Use the Radix Wallet directly to withdraw."
                  : undefined
            }
            onClick={onExit}
          >
            Exit Position
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RotationCard({
  rotation,
  onApprove,
  onReject,
  actionsDisabled,
  actionsDisabledReason,
}: {
  rotation: RotationEntry;
  onApprove: () => void;
  onReject: () => void;
  actionsDisabled: boolean;
  actionsDisabledReason: string;
}) {
  return (
    <Card className="border-risk-yellow/30 bg-risk-yellow/5">
      <CardContent className="pt-6 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-risk-yellow/20 text-risk-yellow">
            Pending Move
          </span>
        </div>
        <p className="text-sm">{rotation.reason}</p>
        <div className="text-xs text-muted-foreground">
          {formatXrd(rotation.amount_xrd)} XRD · {rotation.from_protocol} → {rotation.to_protocol}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={onApprove}
            disabled={actionsDisabled}
            title={actionsDisabled ? actionsDisabledReason : undefined}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={onReject}
            disabled={actionsDisabled}
            title={actionsDisabled ? actionsDisabledReason : undefined}
          >
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const KIND_LABEL: Record<Holding["kind"], string> = {
  xrd: "Liquid XRD",
  "validator-stake": "Validator stake",
  lsulp: "LSU Pool (LSULP)",
  "weft-lending": "Weft V2 lending",
  "pool-lp": "Pool LP",
  unknown: "Unrecognized",
};

/// Ledger truth beside the app's book. These rows come straight from the
/// account's vaults — including stake and LP this app never recorded — and
/// are read-only here: managing them starts in the wallet, not this page.
function HoldingsSection({
  holdings,
  onExitHolding,
  actionsDisabled,
  actionsDisabledReason,
}: {
  holdings: import("@/lib/types").HoldingsResult;
  onExitHolding: (holding: Holding, option: ExitOption) => void;
  actionsDisabled: boolean;
  actionsDisabledReason: string;
}) {
  const rows = holdings.holdings;
  if (rows.length === 0) return null;
  // Only widen the table when something in it is actually exitable — an always-on
  // empty column reads as "these can't be exited" rather than "nothing here can".
  const anyExitable = rows.some((h) => exitOptionsFor(h).length > 0);
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-semibold">On-chain holdings</h2>
        <span className="text-xs text-muted-foreground">
          {formatXrd(holdings.xrdValueTotal)} XRD priced
          {holdings.unconvertibleCount > 0 && ` · ${holdings.unconvertibleCount} unpriced`}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium" title="Converted at the measured redemption rate where one exists. '—' means unpriced, NOT zero.">
                XRD value
              </th>
              {anyExitable && <th className="px-3 py-2 text-right font-medium">Exit</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.resource} className="border-b last:border-0">
                <td className="max-w-[14rem] truncate px-3 py-2" title={h.detail ?? h.resource}>
                  {h.label}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{KIND_LABEL[h.kind]}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {parseFloat(h.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {h.xrdValue !== null ? (
                    formatXrd(h.xrdValue)
                  ) : (
                    <span className="text-muted-foreground" title="Could not be priced — this is not zero.">—</span>
                  )}
                </td>
                {anyExitable && (
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {exitOptionsFor(h).map((opt) => (
                      <Button
                        key={opt.label}
                        size="sm"
                        variant="outline"
                        className="ml-2"
                        disabled={actionsDisabled}
                        onClick={() => onExitHolding(h, opt)}
                        // The outcome, not the mechanism. An unstake previews
                        // green and still returns a receipt instead of XRD, so
                        // where it lands has to be legible before the click.
                        title={actionsDisabled ? actionsDisabledReason : opt.outcome}
                      >
                        {opt.label}
                        {opt.terminus === "unbonding" && (
                          <span className="ml-1 text-[10px] text-amber-500" aria-label="starts a ~7 day unbond">
                            ~7d
                          </span>
                        )}
                      </Button>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Read straight from the ledger for your signed-in account — including stake and LP made
        outside this app. Tracked positions below are the subset this app recorded and can close.
      </p>
    </section>
  );
}

export default function PositionsPage() {
  const { connected, accounts, sendTransaction, authed } = useWallet();
  const {
    data: positions,
    isLoading: posLoading,
    dataSource: posSource,
    error: posError,
    refetch: refetchPositions,
  } = usePositions();
  // Ledger truth for the signed-in account — includes stake/LP this app never
  // recorded. Account reads (useAccountFetch): nothing is requested until a
  // wallet is signed in, and nothing but that wallet's own rows is shown.
  const { data: holdings, dataSource: holdingsSource, refetch: refetchHoldings } =
    useHoldings();
  // The unbonding queue. Same rules as holdings: session-tier, no mock fallback.
  const {
    data: claimsResult,
    dataSource: claimsSource,
    refetch: refetchClaims,
  } = useStakeClaims();
  const {
    data: rotations,
    isLoading: rotLoading,
    dataSource: rotSource,
  } = useRotationPending();
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    action: () => void;
  } | null>(null);

  // Real-DEX withdraw sign-flow (dry-run-previewed, non-custodial).
  const [isSigning, setIsSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signSuccess, setSignSuccess] = useState<{ intentHash: string } | null>(null);
  const [dexBuild, setDexBuild] = useState<DexBuildResult | null>(null);
  const [dexBuilding, setDexBuilding] = useState(false);
  const [dexBuildError, setDexBuildError] = useState<string | null>(null);
  const [dexOpen, setDexOpen] = useState(false);
  const [dexPoolName, setDexPoolName] = useState<string | undefined>(undefined);
  // The position the open withdraw flow belongs to — so a committed exit can
  // be recorded as closed against the right row.
  const [exitingPositionId, setExitingPositionId] = useState<number | null>(null);
  const [closeNote, setCloseNote] = useState<string | null>(null);
  /// Monotonic stamp identifying the current sign flow. See startBuild().
  const buildSeq = useRef(0);

  const handleSign = async (manifest: string) => {
    if (!sendTransaction) return;
    setIsSigning(true); setSignError(null);
    try {
      // RDT's sendTransaction resolves to a neverthrow Result — wallet
      // rejections come back as isErr(), they do NOT throw. Same handling
      // as the deposit flow (opportunity/[address]/page.tsx).
      const result = await sendTransaction({ transactionManifest: manifest, version: 1 });
      const r = result as
        | { isErr?: () => boolean; value?: { transactionIntentHash?: string }; error?: { message?: string } }
        | undefined;
      if (!r) {
        throw new Error("Wallet returned no result. The transaction was not submitted.");
      }
      if (typeof r.isErr === "function" && r.isErr()) {
        throw new Error(r.error?.message ?? "Wallet rejected the transaction");
      }
      const intentHash = r.value?.transactionIntentHash;
      if (!intentHash) {
        throw new Error("Wallet returned no transaction hash. Status unknown.");
      }
      setSignSuccess({ intentHash });
      // Close the row server-side (verified against the Gateway: the tx must
      // show this position leaving the account). Without this the exit is
      // real on-chain but the book still counts the position forever.
      if (exitingPositionId !== null) {
        setCloseNote("Withdraw submitted — waiting for on-chain commit to close the position…");
        let settled = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const res = await fetch(`/api/positions/${exitingPositionId}/close`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ intent_hash: intentHash }),
            });
            if (res.ok) {
              setCloseNote("Position closed and recorded.");
              settled = true;
              refetchPositions();
              break;
            }
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            const notCommittedYet = res.status === 409 && (body?.error ?? "").includes("not committed");
            if (!notCommittedYet) {
              setCloseNote(`Withdraw succeeded on-chain, but closing the record failed: ${body?.error ?? `HTTP ${res.status}`}. The row will keep showing until closed.`);
              settled = true;
              break;
            }
          } catch {
            // Network blip — fall through to the retry wait.
          }
          await new Promise((resolve) => setTimeout(resolve, 6000));
        }
        if (!settled) {
          // Loop exhausted while the tx stayed uncommitted — not an error,
          // just slower than our patience. Idempotent re-close later is safe.
          setCloseNote("Withdraw submitted but not yet committed — the position record will close on a later visit once the transaction commits.");
        }
      } else {
        // A venue exit or claim: there is no `positions` row to close, so the
        // ledger IS the record. Re-read it rather than mutating local state —
        // an unstake moves an LSU row into the unbonding queue and a claim
        // removes one, and only the Gateway knows when that has landed.
        setCloseNote("Submitted. Your holdings will update once the transaction commits.");
        refetchHoldings();
        refetchClaims();
      }
    } catch (e) {
      setSignError(e instanceof Error ? e.message : "Signing failed");
    } finally { setIsSigning(false); }
  };

  const handleCloseSignFlow = () => {
    // Retire the in-flight build too. Without this, closing the modal mid-build
    // leaves a pending response that would populate the NEXT flow's modal.
    buildSeq.current++;
    setDexOpen(false);
    setDexBuilding(false);
    setDexBuild(null);
    setDexBuildError(null);
    setSignError(null);
    setSignSuccess(null);
    setExitingPositionId(null);
  };

  const isLoading = posLoading || rotLoading;

  // Positions are session-scoped on the server (D4): without a ROLA-verified
  // connect the API answers 401 and there is nothing to show. "signed-out" also
  // covers a session the server no longer holds (useAccountFetch drops it).
  // Connecting through the √ Connect button at the top of the page IS the
  // sign-in, so the prompt points there rather than offering a second button.
  if (!connected || !authed || posSource === "signed-out") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 gap-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Your Positions</h1>
          <p className="text-muted-foreground max-w-md">
            Sign in with your Radix Wallet to see your positions: use the Connect
            button at the top of the page. Connecting proves you own the account
            you share, and you see that account&apos;s positions and nothing else.
          </p>
        </div>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col p-6 md:p-12">
        <h1 className="text-3xl font-bold mb-8">Your Positions</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
    </main>
    );
  }

  const allPositions = positions ?? [];
  // A failed read is not "no positions": say it is unavailable and show no
  // totals rather than a confident zero.
  const positionsUnavailable = posSource === "unavailable";
  // Rotation proposals are scoped to the session's own account on the server.
  // Only ever render the fetch's own live data (in development mode the hook
  // returns sample rows whose IDs could collide with real rotation_log rows);
  // the positions dataSource says nothing about this.
  const allRotations = rotSource === "live" ? (rotations ?? []) : [];

  const totalValue = allPositions.reduce((sum, p) => sum + p.current_value_xrd, 0);
  const totalPnl = allPositions.reduce(
    (sum, p) => sum + (p.current_value_xrd - p.deposited_xrd),
    0
  );

  // State-changing actions go through the Next.js proxy
  // (app/api/[...path]/route.ts), which forwards the caller's farmer_session
  // cookie and no longer injects an operator Bearer (F10/F14/F17). Withdraw
  // builds a real-DEX manifest via the PUBLIC /api/dex/build (Gateway
  // dry-run-gated) and the user signs it in their wallet; rotation
  // approve/reject are operator-tier and act only on rows that carry the
  // session's own account.
  //
  // Every state-changing handler refuses unless `posSource === "live"`. Mock
  // data has fake position/rotation IDs that would either 404 or, worse,
  // collide with real IDs and act on the wrong row.

  const actionsDisabled = posSource !== "live";
  const actionsDisabledReason =
    posSource === "loading"
      ? "Loading position data…"
      : posSource === "stale-live"
        ? "Position data is stale — wait for a fresh refresh before signing actions."
        : "Live position data is required. Wallet actions are disabled while showing samples.";

  // Venue exits and claims are gated SEPARATELY, and deliberately not on
  // posSource. They act on ledger rows keyed by validator address and NFT local
  // id — nothing from the tracked-positions table is involved, so a blip on
  // /api/positions has no bearing on whether they are safe. The three fetches
  // are independent SWR calls, so borrowing that gate meant a transient failure
  // on one endpoint told a user looking at a real matured claim that the page
  // was "showing samples". Over-disabling is not harmless when the explanation
  // is false: this app's whole claim is that its labels mean what they say.
  // The sections themselves only render on their own live data.
  const ledgerActionsDisabled = !connected || !authed || !accounts[0]?.address || !sendTransaction;
  const ledgerActionsDisabledReason = !connected || !authed
    ? "Connect your wallet to exit a position."
    : "No account available to sign with.";

  // Exit — non-custodial: the server resolves the pool's blueprint and builds
  // the right withdraw (NFT receipt id vs fungible LP amount), Gateway-dry-run
  // gated; the user signs it in their wallet.
  const handleExit = (position: Position) => {
    if (actionsDisabled) return;
    const account = accounts[0]?.address;
    if (!account || !sendTransaction) return;
    const req: DexBuildRequest | null = position.receipt_id
      ? {
          action: "withdraw", account,
          poolAddress: position.pool_address,
          localId: position.receipt_id,
        }
      : position.lp_amount && position.receipt_resource
        ? {
            action: "withdraw", account,
            poolAddress: position.pool_address,
            lpAmount: position.lp_amount,
            lpToken: position.receipt_resource,
          }
        : null;
    if (!req) return;
    startBuild(position.pool_name, req, position.id);
  };

  /**
   * Exit a single-sided venue holding (unstake, or redeem LSULP).
   *
   * Deliberately does NOT set exitingPositionId: these are ledger rows this app
   * may never have recorded, so there is no `positions` row to close and firing
   * the close-retry loop would 404 against an id that does not exist. The
   * holdings list is re-read after signing instead — the ledger is the record.
   */
  const handleExitHolding = (holding: Holding, option: ExitOption) => {
    if (ledgerActionsDisabled) return;
    const account = accounts[0]?.address;
    if (!account || !sendTransaction) return;
    // positionId omitted: this is a ledger row this app may never have recorded,
    // so there is nothing in `positions` to close.
    startBuild(`${option.label} · ${holding.label}`, { ...option.request, account });
  };

  /** Claim a matured Stake Claim NFT. The server refuses an early claim. */
  const handleClaim = (claim: StakeClaim) => {
    if (ledgerActionsDisabled) return;
    const account = accounts[0]?.address;
    if (!account || !sendTransaction) return;
    startBuild("Claim unstaked XRD", { ...claimRequestFor(claim), account });
  };

  /**
   * The ONE way to open the sign flow, so every entry point resets the same
   * state and no two flows can interleave.
   *
   * `buildSeq` is load-bearing, not defensive tidiness. `buildDex` is not
   * cancellable and the preview modal can be closed while a build is still in
   * flight, so a slow request from an abandoned flow used to resolve into a
   * later flow's modal: the user would see "Unstake" in the title, sign, and
   * commit a tracked position's withdraw instead. Worse, `handleSign` branches
   * on `exitingPositionId`, which the second flow had already cleared — so the
   * close was never recorded and the position stayed `active` forever despite
   * being genuinely exited on-chain. Stamping each build and discarding
   * responses that are no longer current closes that whole class.
   */
  function startBuild(label: string, req: DexBuildRequest, positionId?: number) {
    const seq = ++buildSeq.current;
    setExitingPositionId(positionId ?? null);
    setCloseNote(null);
    setDexPoolName(label);
    setDexOpen(true);
    setDexBuilding(true); setDexBuildError(null);
    setDexBuild(null); setSignError(null); setSignSuccess(null);
    buildDex(req)
      .then((r) => {
        if (buildSeq.current !== seq) return; // superseded or abandoned
        setDexBuilding(false); setDexBuild(r);
      })
      .catch((e) => {
        if (buildSeq.current !== seq) return;
        setDexBuilding(false);
        setDexBuildError(e instanceof Error ? e.message : "Failed to build the transaction");
      });
  }

  const handleApproveRotation = async (rotation: RotationEntry) => {
    if (actionsDisabled) return;
    try {
      const res = await fetch(`/api/rotation/${rotation.id}/approve`, { method: "POST" });
      if (!res.ok) console.error(`[rotation/approve] HTTP ${res.status}`);
    } catch (err) {
      console.error("[rotation/approve] failed", err);
    }
  };

  const handleRejectRotation = async (rotation: RotationEntry) => {
    if (actionsDisabled) return;
    try {
      const res = await fetch(`/api/rotation/${rotation.id}/reject`, { method: "POST" });
      if (!res.ok) console.error(`[rotation/reject] HTTP ${res.status}`);
    } catch (err) {
      console.error("[rotation/reject] failed", err);
    }
  };

  return (
    <main className="flex min-h-screen flex-col p-6 md:p-12">
      <DataSourceBanner source={posSource} message={posError} className="mb-6" />

      {/* Summary Bar */}
      <div className="flex flex-col md:flex-row md:items-center gap-4 mb-8">
        <h1 className="text-3xl font-bold">Your Positions</h1>
        <div className="flex gap-6 md:ml-auto">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">Total Value</p>
            <p className="text-lg font-bold">
              {positionsUnavailable ? "—" : `${formatXrd(totalValue)} XRD`}
            </p>
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">Total P&L</p>
            {positionsUnavailable ? (
              <p className="text-lg font-bold">—</p>
            ) : (
              <p className={`text-lg font-bold ${totalPnl >= 0 ? "text-profit-green" : "text-loss-red"}`}>
                {totalPnl >= 0 ? "+" : ""}{formatXrd(totalPnl)} XRD
              </p>
            )}
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">Positions</p>
            <p className="text-lg font-bold">{positionsUnavailable ? "—" : allPositions.length}</p>
          </div>
        </div>
      </div>

      {closeNote && (
        <div className="mb-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          {closeNote}
        </div>
      )}

      {/* Ledger truth — renders only on live session data, never from samples */}
      {holdingsSource === "live" && holdings && (
        <HoldingsSection
          holdings={holdings}
          onExitHolding={handleExitHolding}
          actionsDisabled={ledgerActionsDisabled}
          actionsDisabledReason={ledgerActionsDisabledReason}
        />
      )}

      {/* The unbonding queue. Rendered above tracked positions because a matured
          claim is time-sensitive in a way a healthy position is not. */}
      {claimsSource === "live" && claimsResult && (
        <ClaimsSection
          claims={claimsResult.claims}
          onClaim={handleClaim}
          actionsDisabled={ledgerActionsDisabled}
          actionsDisabledReason={ledgerActionsDisabledReason}
        />
      )}

      {/* Pending Rotations */}
      {allRotations.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Pending Moves</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {allRotations.map((rotation) => (
              <RotationCard
                key={rotation.id}
                rotation={rotation}
                onApprove={() => handleApproveRotation(rotation)}
                onReject={() => handleRejectRotation(rotation)}
                actionsDisabled={actionsDisabled}
                actionsDisabledReason={actionsDisabledReason}
              />
            ))}
          </div>
        </section>
      )}

      {/* Position Cards */}
      {positionsUnavailable && (
        <Card>
          <CardContent className="py-10 text-center space-y-1">
            <p className="font-medium">Your tracked positions are unavailable right now</p>
            <p className="text-sm text-muted-foreground">
              Nothing is shown in their place. Try again shortly.
            </p>
          </CardContent>
        </Card>
      )}
      {!positionsUnavailable && allPositions.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="space-y-1">
              <p className="font-medium">No tracked positions</p>
              <p className="text-sm text-muted-foreground">
                Deposits made through this app appear here and can be closed from here.
              </p>
            </div>
            <Link href="/discover">
              <Button>
                <TrendingUp className="mr-2 h-4 w-4" />
                Discover Opportunities
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {allPositions.map((position) => (
          <PositionCard
            key={position.id}
            position={position}
            onExit={() => handleExit(position)}
            actionsDisabled={actionsDisabled}
            actionsDisabledReason={actionsDisabledReason}
          />
        ))}
      </div>

      {/* Confirmation Modal */}
      <ConfirmModal
        open={confirmAction !== null}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        onConfirm={() => confirmAction?.action()}
        onCancel={() => setConfirmAction(null)}
      />
      {/* Real-DEX withdraw modal — ledger dry-run gated */}
      <DexPreviewModal
        open={dexOpen}
        onClose={handleCloseSignFlow}
        build={dexBuild}
        isBuilding={dexBuilding}
        buildError={dexBuildError}
        poolName={dexPoolName}
        onSign={handleSign}
        isSigning={isSigning}
        signError={signError}
        signSuccess={signSuccess}
      />
    </main>
  );
}
