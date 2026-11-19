"use client";

import { Sprout } from "lucide-react";
import { useYields } from "@/lib/hooks/use-yields";
import { Card, CardContent } from "@/components/ui/card";
import { DataSourceBanner } from "@/components/data-source-banner";
import type { YieldAssetRow, YieldRowData } from "@/lib/types";

/**
 * Radix-wide yield view: where the yield is, in XRD, and how deep the exit is.
 * Design: docs/design/radix-yield-view.md.
 *
 * Rendering contract: every null is "—" (unavailable), never 0. The three
 * return types (staking APY, fee APR, ALR) are three separate tables, each
 * sorted by exit depth, and are never ranked against each other.
 */

const FLAG_LABEL: Record<string, { text: string; tone: string; title: string }> = {
  bridge: { text: "bridge", tone: "text-amber-500", title: "Depends on an external bridge. Redeemability is unverified." },
  off_peg: { text: "off peg", tone: "text-red-500", title: "A stablecoin priced more than 5% away from $1." },
  meme: { text: "meme", tone: "text-muted-foreground", title: "Meme token: price risk dominates any yield." },
  price_disagree: { text: "prices disagree", tone: "text-amber-500", title: "Astrolescent and Ociswap differ by more than 5%. Both are shown; neither is trusted alone." },
  below_floor: { text: "below floor", tone: "text-muted-foreground", title: "Aggregate TVL under $1,000 or no 7-day volume: no rows shown." },
  no_price: { text: "no price", tone: "text-muted-foreground", title: "Astrolescent has no price for this resource." },
  outlier: { text: "outlier", tone: "text-amber-500", title: "ALR at or beyond ±100% a year. Per-side ALR swings with pool imbalance; read both sides." },
};

function fmtXrd(v: number | null): string {
  if (v === null) return "—";
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(v < 10 ? 4 : 0);
}

function fmtPct(v: number | null, digits = 2): string {
  return v === null ? "—" : `${v.toFixed(digits)}%`;
}

function fmtSigned(v: number | null, unit: string): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}${unit}`;
}

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1">
      {flags.map((f) => {
        const l = FLAG_LABEL[f] ?? { text: f, tone: "text-muted-foreground", title: f };
        return (
          <span key={f} className={`rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium ${l.tone}`} title={l.title}>
            {l.text}
          </span>
        );
      })}
    </span>
  );
}

function ReturnTable({ title, note, rows, returnLabel }: { title: string; note: string; rows: YieldRowData[]; returnLabel: string }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rows right now.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Pool</th>
                <th className="px-3 py-2 text-right font-medium">{returnLabel}</th>
                <th className="px-3 py-2 text-right font-medium" title="Change vs the daily snapshot 7 days earlier, in percentage points">7d Δ</th>
                <th className="px-3 py-2 text-right font-medium" title="Exit depth: pool (or side) size in XRD. Sorted by this.">Depth (XRD)</th>
                <th className="px-3 py-2 text-right font-medium">7d volume (XRD)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <span className="text-xs text-muted-foreground">{r.venue}</span>{" "}
                    <span className="font-medium">{r.label}</span>
                    <Flags flags={r.flags} />
                  </td>
                  <td className={`px-3 py-2 text-right font-medium ${r.returnPct < 0 ? "text-red-500" : ""}`}>{fmtPct(r.returnPct)}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtSigned(r.returnChange7dPp, "pp")}</td>
                  <td className="px-3 py-2 text-right">
                    {fmtXrd(r.depthXrd)}
                    {r.depthChange7dPct !== null && (
                      <span className="ml-1 text-[10px] text-muted-foreground" title="Depth change vs 7 days earlier">
                        ({fmtSigned(r.depthChange7dPct, "%")})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right" title={r.volume7dXrd === null && r.venue === "DefiPlaza" ? "Not reported by DefiPlaza's API" : undefined}>
                    {fmtXrd(r.volume7dXrd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AssetTable({ assets }: { assets: YieldAssetRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Asset</th>
            <th className="px-3 py-2 text-right font-medium" title="Astrolescent tokenPriceXRD (rule 1)">Price (XRD)</th>
            <th className="px-3 py-2 text-right font-medium" title="Ociswap price.xrd from the deepest XRD pool (cross-check)">Ociswap (XRD)</th>
            <th className="px-3 py-2 text-right font-medium">7d Δ</th>
            <th className="px-3 py-2 text-right font-medium" title="Price in XRD × DefiLlama XRD/USD">USD</th>
            <th className="px-3 py-2 text-right font-medium">7d volume (XRD)</th>
            <th className="px-3 py-2 text-right font-medium" title="Astrolescent aggregate TVL in USD: the input to the $1,000 liquidity floor">Agg. TVL (USD)</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.resource} className="border-b last:border-0">
              <td className="px-3 py-2">
                <span className="font-medium" title={a.resource}>{a.symbol}</span>
                {a.bridgeRoute && <span className="ml-1 text-xs text-muted-foreground">({a.bridgeRoute})</span>}
                <Flags flags={a.flags} />
              </td>
              <td className="px-3 py-2 text-right">{fmtXrd(a.priceXrd)}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">
                {fmtXrd(a.priceXrdOciswap)}
                {a.divergencePct !== null && <span className="ml-1 text-[10px]">({fmtSigned(a.divergencePct, "%")})</span>}
              </td>
              <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtSigned(a.priceChange7dPct, "%")}</td>
              <td className="px-3 py-2 text-right">{a.priceUsd === null ? "—" : `$${a.priceUsd < 1 ? a.priceUsd.toPrecision(3) : a.priceUsd.toFixed(2)}`}</td>
              <td className="px-3 py-2 text-right">{fmtXrd(a.volume7dXrd)}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">
                {a.aggregateTvlUsd === null ? "—" : `$${Math.round(a.aggregateTvlUsd).toLocaleString()}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function YieldsPage() {
  const { data: view, dataSource } = useYields();
  const b = view?.banner;

  return (
    <div className="space-y-6 pb-20">
      <div className="flex items-center gap-2">
        <Sprout className="h-5 w-5" />
        <h1 className="text-xl font-semibold">Radix yields, in XRD</h1>
      </div>

      <DataSourceBanner source={dataSource} message="Do not act on sample or stale numbers." />

      {view && (
        <Card>
          <CardContent className="pt-6 space-y-2 text-sm">
            <p>
              XRD <span className="font-semibold">{b?.xrdUsd === null || b?.xrdUsd === undefined ? "—" : `$${b.xrdUsd.toPrecision(3)}`}</span>
              {" · "}Radix chain TVL{" "}
              <span className="font-semibold">
                {b?.chainTvlUsd == null ? "—" : `$${Math.round(b.chainTvlUsd).toLocaleString()}`}
              </span>
              {b?.chainTvlXrd != null && <span className="text-muted-foreground"> ({fmtXrd(b.chainTvlXrd)} XRD)</span>}
              <span className="text-xs text-muted-foreground"> · DefiLlama</span>
            </p>
            {b?.note && (
              <p className="text-muted-foreground">
                {b.note}{" "}
                {b.noteSource && (
                  <a href={b.noteSource} target="_blank" rel="noopener noreferrer" className="underline">
                    Source
                  </a>
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Read-only. Nothing on this page signs or moves funds.
              {view.generatedAt && ` Updated ${new Date(view.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`}
            </p>
          </CardContent>
        </Card>
      )}

      {view && (
        <>
          <ReturnTable
            title="Staking APY"
            note="Native XRD staking, from the Gateway, net of the median validator fee. No impermanent loss; exit takes the network unstake delay."
            rows={view.sections.staking}
            returnLabel="Staking APY"
          />
          <ReturnTable
            title="Fee APR (impermanent loss not included)"
            note="Ociswap 7-day fee income in XRD. IL is NOT subtracted, so this is not comparable with ALR below."
            rows={view.sections.feeApr}
            returnLabel="Fee APR"
          />
          <ReturnTable
            title="ALR (impermanent loss included)"
            note="DefiPlaza Annualized Liquidity Return per side: the return versus holding that side's token, including IL. Can be negative."
            rows={view.sections.alr}
            returnLabel="ALR"
          />

          <p className="text-xs text-muted-foreground">
            Pool floor: {view.excluded.rowsBelowDepthFloor} row(s) left out because their exit depth is under $1,000
            {view.excluded.depthFloorXrd !== null && ` (${fmtXrd(view.excluded.depthFloorXrd)} XRD at today's price)`}.
            {view.excluded.rowsDepthUnknown > 0 && ` ${view.excluded.rowsDepthUnknown} row(s) shown with depth unavailable.`}
          </p>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Watchlist assets</h2>
            <AssetTable assets={view.assets} />
            {view.excluded.belowFloorAssets.length > 0 && (
              <p className="text-xs text-muted-foreground">Below the liquidity floor: {view.excluded.belowFloorAssets.join(", ")}.</p>
            )}
          </section>

          {view.kickers.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Validator kickers (unverified)</h2>
              <ul className="space-y-1 text-sm">
                {view.kickers.map((k) => (
                  <li key={k.venue}>
                    <span className="font-medium">{k.venue}</span>: {k.advertised}. Paid in: {k.paidIn}.{" "}
                    <span className="text-xs text-muted-foreground">
                      As advertised by the venue on {k.checked}, not checked in the dApp.{" "}
                      <a href={k.source} target="_blank" rel="noopener noreferrer" className="underline">
                        Source
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view.rules.length > 0 && (
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">How this page is built</h2>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {view.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
