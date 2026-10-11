"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useValidators } from "@/lib/hooks/use-validators";
import { Card, CardContent } from "@/components/ui/card";
import { DataSourceBanner } from "@/components/data-source-banner";
import type { ValidatorRow } from "@/lib/types";

/**
 * The validator board — what every validator ACTUALLY paid its stakers,
 * measured from the ledger (Δredemption), next to the fee it claims.
 *
 * Rendering contract (mirrors the server's semantics, and the reason this
 * page exists): realizedApyPct === 0 is a REAL measurement — the validator
 * kept everything — and renders as a flagged "0.000%". null means "could not
 * measure" and renders as an em dash. Confusing the two either hides a trap
 * or slanders a new validator.
 *
 * Second contract (2026-08-23): a zero-payer at a VISIBLE 100% fee is a
 * disclosed product (lottery / fund / treasury node) whose stakers opted in
 * — it renders labeled, in amber. The red flag is reserved for the anomaly:
 * a validator claiming a sub-100% fee while paying nothing. Pooling the two
 * overstates the scandal ~38× by stake and misleads users in exactly the
 * way this board exists to prevent.
 */

type Filter = "active" | "zero-payers" | "all";

function fmtStake(xrd: number): string {
  if (xrd >= 1e6) return `${(xrd / 1e6).toFixed(1)}M`;
  if (xrd >= 1e3) return `${(xrd / 1e3).toFixed(0)}k`;
  return xrd.toFixed(0);
}

function ApyCell({ row }: { row: ValidatorRow }) {
  if (row.realizedApyPct === null) {
    return <span className="text-muted-foreground" title="Not measurable over this window (new validator or missing history)">—</span>;
  }
  if (row.paysNothing) {
    if (row.zeroDisclosedByFee) {
      return (
        <span
          className="font-semibold text-amber-500"
          title="Pays stakers nothing at a visible 100% fee — rewards are redistributed as a different product (lottery, fund, treasury). Disclosed, not hidden."
        >
          0.000%
        </span>
      );
    }
    return (
      <span
        className="font-semibold text-red-500"
        title="Measured over the window: stakers received nothing, while the fee claims they should"
      >
        0.000%
      </span>
    );
  }
  return <span className="font-medium text-emerald-500">{row.realizedApyPct.toFixed(3)}%</span>;
}

function FeeCell({ row }: { row: ValidatorRow }) {
  if (row.effectiveFeePct === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={row.feeFieldsDisagree ? "text-amber-500" : undefined}>
      {row.effectiveFeePct.toFixed(row.effectiveFeePct % 1 === 0 ? 0 : 2)}%
      {row.feeFieldsDisagree && (
        <span
          className="ml-1 inline-flex align-middle"
          title={`Displayed fee field reads ${row.staleFeePct}% but ${row.effectiveFeePct}% is in force — the on-ledger display field updates lazily and can be stale forever`}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-label="fee fields disagree" />
        </span>
      )}
    </span>
  );
}

export default function ValidatorsPage() {
  const { data: board, isLoading, dataSource } = useValidators();
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    if (!board) return [];
    const q = query.trim().toLowerCase();
    return board.rows.filter((r) => {
      if (filter === "active" && !r.activeInEpoch) return false;
      if (filter === "zero-payers" && !(r.paysNothing && r.activeInEpoch)) return false;
      if (q && !(r.name ?? "").toLowerCase().includes(q) && !r.address.includes(q)) return false;
      return true;
    });
  }, [board, filter, query]);

  return (
    <div className="space-y-4 pb-20">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5" />
        <h1 className="text-xl font-semibold">Validators — measured, not claimed</h1>
      </div>

      <DataSourceBanner
        source={dataSource}
        message="Do not choose a validator from sample or stale numbers."
      />

      {board && (
        <Card className={board.activeAnomalousZeroCount > 0 ? "border-red-500/40" : undefined}>
          <CardContent className="pt-6">
            <p className="text-sm">
              <span className="font-semibold text-red-500">
                {board.activeAnomalousZeroCount} of {board.activeCount} active validators
              </span>{" "}
              — holding{" "}
              <span className="font-semibold">
                {fmtStake(board.activeAnomalousZeroStakeXrd)} XRD
              </span>{" "}
              of other people&apos;s stake — paid their stakers{" "}
              <span className="font-semibold">nothing</span> over the last{" "}
              {Math.round(board.windowDays)} days while advertising a fee below 100%.
            </p>
            {board.activeDisclosedZeroCount > 0 && (
              <p className="mt-2 text-sm text-muted-foreground">
                A further{" "}
                <span className="font-medium text-amber-500">
                  {board.activeDisclosedZeroCount} validators
                </span>{" "}
                ({fmtStake(board.activeDisclosedZeroStakeXrd)} XRD) run a{" "}
                <span className="font-medium">visible 100% fee</span> — lottery, fund and
                treasury nodes that redistribute rewards as a different product. Their stakers
                opted in; that is disclosure, not theft.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              APY here is measured from each validator&apos;s LSU redemption rate at two ledger
              states — what stakers actually received — not the fee the validator advertises. A
              validator can display a 0% fee and keep everything; the drift cannot lie.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["active", "Active set"],
            ["zero-payers", "Zero-payers"],
            ["all", "All registered"],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === value
                ? "border-primary bg-primary/10 font-medium"
                : "border-border text-muted-foreground"
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or address…"
          className="ml-auto w-56 rounded-md border border-border bg-background px-3 py-1 text-xs"
        />
      </div>

      {isLoading && !board ? (
        <Card className="animate-pulse">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="h-4 w-40 rounded bg-muted" />
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-full rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Validator</th>
                <th className="px-3 py-2 text-right font-medium" title="Measured Δredemption, annualized">
                  Paid (APY)
                </th>
                <th className="px-3 py-2 text-right font-medium" title="effective_fee_factor — the fee actually in force">
                  Real fee
                </th>
                <th className="px-3 py-2 text-right font-medium">Stake</th>
                <th className="px-3 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.address} className="border-b border-border/50 last:border-0">
                  <td className="max-w-[16rem] truncate px-3 py-2" title={r.address}>
                    {r.name ?? `${r.address.slice(0, 20)}…`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <ApyCell row={r} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <FeeCell row={r} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtStake(r.stakeXrd)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {r.activeInEpoch ? (
                      r.paysNothing ? (
                        r.zeroDisclosedByFee ? (
                          <span
                            className="text-amber-500"
                            title="Visible 100% fee — rewards go to prizes / fund / treasury by design"
                          >
                            100% fee — by design
                          </span>
                        ) : (
                          <span className="text-red-500">keeps everything</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">active</span>
                      )
                    ) : (
                      <span className="text-muted-foreground/60" title="Outside the active set — cannot earn emissions">
                        inactive
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No validators match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {board && (
        <p className="text-xs text-muted-foreground">
          Window: {Math.round(board.windowDays)} days, measured{" "}
          {new Date(board.measuredAt).toLocaleString()}. &ldquo;—&rdquo; means the validator could
          not be measured over the window (typically too new), which is different from 0.000%.
        </p>
      )}
    </div>
  );
}
