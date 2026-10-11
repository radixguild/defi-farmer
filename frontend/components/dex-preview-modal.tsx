"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DexBuildResult } from "@/lib/api/dex";
import { cn } from "@/lib/utils";

const XRD_RESOURCE =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

function shortAddr(resource: string): string {
  return `${resource.slice(0, 14)}…${resource.slice(-6)}`;
}

/** Best-effort display label for a resource in this pool's context. */
function resourceLabel(resource: string, poolName?: string, pool?: DexBuildResult["pool"]): string {
  if (resource === XRD_RESOURCE) return "XRD";
  if (poolName && pool) {
    const parts = poolName.split(/[-/]/);
    if (parts.length === 2) {
      if (resource === pool.tokenX) return parts[0];
      if (resource === pool.tokenY) return parts[1];
    }
  }
  return shortAddr(resource);
}

/**
 * The non-custodial sign gate for real-DEX manifests. Unlike the legacy vault
 * modal (a speculative decode), everything shown here comes from the Gateway's
 * DRY-RUN of the exact manifest: "you send / you receive" are the ledger's own
 * numbers. A failing preview cannot be signed.
 */
export function DexPreviewModal({
  open,
  onClose,
  build,
  isBuilding,
  buildError,
  poolName,
  onSign,
  isSigning,
  signError = null,
  signSuccess = null,
  onProvideCoLiquidity,
}: {
  open: boolean;
  onClose: () => void;
  build: DexBuildResult | null;
  isBuilding: boolean;
  buildError: string | null;
  /** Display name for token labels (e.g. "XRD-xUSDC"). */
  poolName?: string;
  onSign: (manifest: string) => void;
  isSigning: boolean;
  signError?: string | null;
  signSuccess?: { intentHash: string } | null;
  /** DefiPlaza only: called with the co-liquidity amount to rebuild. */
  onProvideCoLiquidity?: (coAmount: string) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [coAmount, setCoAmount] = useState("");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setShowRaw(false);
    }
  }, [open, build]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isSigning) onClose();
    }
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, isSigning]);

  if (!open) return null;

  const preview = build?.preview ?? null;
  const sends = preview?.movements.filter((m) => m.amount.startsWith("-")) ?? [];
  const receives = preview?.movements.filter((m) => !m.amount.startsWith("-")) ?? [];
  const needsCo = build?.needsCoLiquidity;
  const previewFailed = !!preview && !preview.ok;
  const canSign = !!build && !!preview?.ok && acknowledged && !isSigning;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dex-preview-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm md:items-center md:p-4"
      onClick={() => {
        if (!isSigning) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-t-2xl bg-background shadow-xl max-h-[90vh] overflow-y-auto md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between p-5 border-b">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Ledger dry-run — review before signing
            </p>
            <h2 id="dex-preview-title" className="text-xl font-semibold mt-0.5 truncate">
              {isBuilding ? "Simulating transaction…" : poolName ?? "Transaction"}
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            disabled={isSigning}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {isBuilding && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Building and dry-running against the ledger…
            </div>
          )}

          {buildError && (
            <div role="alert" className="rounded-md border border-loss-red/50 bg-loss-red/10 p-3 text-sm">
              <p className="font-medium text-loss-red">Could not build transaction</p>
              <p className="mt-0.5 text-loss-red/80 line-clamp-3">{buildError.slice(0, 240)}</p>
            </div>
          )}

          {/*
            Exit notice. The dry-run below is honest about token movement and
            still cannot say the one thing that matters most on an unstake: the
            XRD is not coming back for ~7 days and needs a second signature. So
            the server sends the sentence and it renders ABOVE the numbers,
            where it cannot be scrolled past on the way to Sign.
          */}
          {build?.notice && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                <span>{build.notice}</span>
              </p>
              {build.claim && !build.claim.ready && build.claim.readyAtEstimate && (
                <p className="mt-1.5 pl-6 text-xs text-muted-foreground">
                  Estimated unlock: {new Date(build.claim.readyAtEstimate).toLocaleString()}
                </p>
              )}
            </div>
          )}

          {/* DefiPlaza co-liquidity: the pool refused a single-sided add. */}
          {needsCo && previewFailed && onProvideCoLiquidity && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-2">
              <p className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                This pool currently needs BOTH tokens for a deposit (its
                single-sided lane is in shortage). Add an amount of{" "}
                <span className="font-medium">
                  {resourceLabel(needsCo.otherToken, poolName, build?.pool)}
                </span>{" "}
                to continue.
              </p>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min="0"
                  placeholder="0.00"
                  value={coAmount}
                  onChange={(e) => setCoAmount(e.target.value)}
                />
                <Button
                  type="button"
                  disabled={!(parseFloat(coAmount) > 0)}
                  onClick={() => onProvideCoLiquidity(coAmount)}
                >
                  Rebuild
                </Button>
              </div>
            </div>
          )}

          {previewFailed && !needsCo && (
            <div role="alert" className="rounded-md border border-loss-red/50 bg-loss-red/10 p-3 text-sm">
              <p className="font-medium text-loss-red">The ledger rejected this transaction in dry-run</p>
              <p className="mt-0.5 text-loss-red/80 line-clamp-4">
                {(preview?.error ?? preview?.status ?? "").slice(0, 280)}
              </p>
              <p className="mt-1.5 text-xs text-loss-red/70">
                Nothing was signed or submitted. Adjust the inputs and try again.
              </p>
            </div>
          )}

          {signError && (
            <div role="alert" className="rounded-md border border-loss-red/50 bg-loss-red/10 p-3 text-sm">
              <p className="font-medium text-loss-red">Wallet did not sign</p>
              <p className="mt-0.5 text-loss-red/80 line-clamp-3">{signError.slice(0, 240)}</p>
              <p className="mt-1.5 text-xs text-loss-red/70">
                Nothing was submitted on-chain. You can review and try again.
              </p>
            </div>
          )}

          {signSuccess && (
            <div role="status" className="rounded-md border border-profit-green/40 bg-profit-green/10 p-3 text-sm">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-profit-green" />
                <div>
                  <p className="font-medium text-profit-green">Transaction submitted</p>
                  <p className="mt-0.5 text-xs font-mono break-all text-profit-green/80">
                    {signSuccess.intentHash}
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Your position is recorded automatically once the network commits
                    (typically 10–30 seconds).
                  </p>
                </div>
              </div>
            </div>
          )}

          {preview?.ok && build && (
            <>
              <div className="rounded-md border bg-muted/40 divide-y">
                {sends.length > 0 && (
                  <div className="p-3">
                    <p className="text-xs uppercase text-muted-foreground mb-2">You send</p>
                    <ul className="space-y-1">
                      {sends.map((m) => (
                        <li key={m.resource} className="flex items-center justify-between text-sm">
                          <span className="font-medium">
                            {m.amount.slice(1)} {resourceLabel(m.resource, poolName, build.pool)}
                          </span>
                          <span className="text-xs text-muted-foreground">{shortAddr(m.resource)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="p-3">
                  <p className="text-xs uppercase text-muted-foreground mb-2">You receive</p>
                  {receives.length > 0 ? (
                    <ul className="space-y-1">
                      {receives.map((m) => (
                        <li key={m.resource} className="flex items-center justify-between text-sm">
                          <span className="font-medium text-profit-green">
                            +{m.amount} {resourceLabel(m.resource, poolName, build.pool)}
                          </span>
                          <span className="text-xs text-muted-foreground">{shortAddr(m.resource)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Nothing back to your account in this transaction.
                    </p>
                  )}
                </div>
                <div className="p-3 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Pool</span>
                  <span className="font-mono text-xs truncate max-w-[220px]">
                    {shortAddr(build.pool.address)}
                  </span>
                </div>
                {preview.feeXrd && (
                  <div className="p-3 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Network fee (dry-run)</span>
                    <span className="font-medium">~{parseFloat(preview.feeXrd).toFixed(2)} XRD</span>
                  </div>
                )}
              </div>

              <details
                className="rounded-md border bg-muted/20 text-xs"
                open={showRaw}
                onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}
              >
                <summary className="cursor-pointer p-3 font-medium select-none">
                  {showRaw ? "Hide" : "Show"} raw manifest
                </summary>
                <pre className="overflow-x-auto p-3 pt-0 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                  {build.manifest}
                </pre>
              </details>

              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-1"
                  disabled={isSigning}
                />
                <span>
                  I reviewed the send/receive amounts above. The Radix Wallet will
                  show its own decoded view at sign time — they should match.
                </span>
              </label>
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t p-4">
          {signSuccess ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={isSigning}>
                Cancel
              </Button>
              <Button onClick={() => build && onSign(build.manifest)} disabled={!canSign} className={cn("gap-2")}>
                {isSigning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Waiting for wallet…
                  </>
                ) : signError ? (
                  <>
                    Try again <ArrowRight className="h-4 w-4" />
                  </>
                ) : (
                  <>
                    Sign in Wallet <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
