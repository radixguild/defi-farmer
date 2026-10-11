"use client";

/**
 * The unbonding queue: Stake Claim NFTs and whether they can be claimed yet.
 *
 * WHY THIS IS NOT OPTIONAL. A claim is spent by its NFT local id, and nothing
 * else in this app knows those ids — so without this list the claim builder is
 * unreachable. That makes it the safety half of offering an unstake at all:
 * shipping "start a 7-day unbond" without "finish it" would strand the user
 * mid-exit, which is why the server shipped both legs together and why the UI
 * must too.
 *
 * It also renders for claims this app never created. The endpoint reads the
 * ledger, so an unstake done months ago in the Radix Wallet appears here and can
 * be claimed here.
 */

import { Clock, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { StakeClaim } from "@/lib/api/dex";

function formatXrd(raw: string): string {
  const n = parseFloat(raw);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : raw;
}

/**
 * "~2.8 days" beats "812 epochs" for a human, but the epoch count is the real
 * unit and stays visible: epochs are ~300 s on average, not guaranteed, so a
 * day figure is an estimate and is labelled as one.
 */
function waitCopy(claim: StakeClaim): string {
  const days = (claim.epochsRemaining * 300) / 86_400;
  const rounded = days >= 1 ? `~${days.toFixed(1)} days` : "under a day";
  return `${claim.epochsRemaining.toLocaleString()} epochs left (${rounded})`;
}

export function ClaimsSection({
  claims,
  onClaim,
  actionsDisabled,
  actionsDisabledReason,
}: {
  claims: StakeClaim[];
  onClaim: (claim: StakeClaim) => void;
  actionsDisabled: boolean;
  actionsDisabledReason: string;
}) {
  if (claims.length === 0) return null;

  const ready = claims.filter((c) => c.ready);
  const waiting = claims.filter((c) => !c.ready);
  const readyXrd = ready.reduce((sum, c) => sum + (parseFloat(c.claimAmountXrd) || 0), 0);

  return (
    <section className="mb-8">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">Unbonding</h2>
        <span className="text-xs text-muted-foreground">
          {ready.length > 0
            ? `${formatXrd(String(readyXrd))} XRD ready to claim`
            : `${waiting.length} claim${waiting.length === 1 ? "" : "s"} still locked`}
        </span>
      </div>

      <div className="space-y-2">
        {[...ready, ...waiting].map((claim) => (
          <Card key={`${claim.claimNftResource}:${claim.localId}`}>
            <CardContent className="flex flex-wrap items-center gap-4 py-4">
              {claim.ready ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}

              <div className="min-w-0 flex-1">
                <p className="font-medium tabular-nums">
                  {formatXrd(claim.claimAmountXrd)} XRD
                </p>
                <p className="truncate text-xs text-muted-foreground" title={claim.validator}>
                  {claim.ready ? (
                    "Ready to claim now"
                  ) : (
                    <>
                      {waitCopy(claim)}
                      {claim.readyAtEstimate &&
                        ` · est. ${new Date(claim.readyAtEstimate).toLocaleDateString()}`}
                    </>
                  )}
                </p>
              </div>

              <Button
                size="sm"
                variant={claim.ready ? "default" : "outline"}
                disabled={!claim.ready || actionsDisabled}
                onClick={() => onClaim(claim)}
                title={
                  actionsDisabled
                    ? actionsDisabledReason
                    : claim.ready
                      ? "Build the claim transaction"
                      : // The server refuses an early claim with the real numbers
                        // rather than the engine's EpochUnlockHasNotOccurredYet,
                        // but there is no reason to let the user spend a click
                        // finding that out.
                        `Locked until epoch ${claim.claimEpoch.toLocaleString()}`
                }
              >
                Claim
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        The amount was fixed when you unstaked — it does not accrue while unbonding. Claims
        made outside this app appear here too; the list is read from the ledger.
      </p>
    </section>
  );
}
