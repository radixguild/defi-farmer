"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { useOpportunities } from "@/lib/hooks";
import { Card, CardContent } from "@/components/ui/card";
import { DataSourceBanner } from "@/components/data-source-banner";
import { AuditBadge } from "@/components/audit-badge";
import {
  SORT_LABELS,
  type SortOption,
  apyTone,
  formatApy,
  formatTvl,
  grossApy,
  headlineApy,
  ilRiskLabel,
  impermanentLoss,
  isIlFree,
  isStablePair,
  profitable,
  sortOpportunities,
  yieldKindLabel,
} from "@/lib/yield";
import { Opportunity } from "@/lib/types";

type RiskFilter = "all" | "low" | "medium" | "high";
type AssetFilter = "all" | "xrd" | "stablecoins";
type YieldFilter = "all" | "il-free" | "profitable";

/** Buckets the server's il_risk_score (higher = riskier), not the composite score. */
function ilRiskBucket(score: number): "low" | "medium" | "high" {
  if (score <= 40) return "low";
  if (score <= 70) return "medium";
  return "high";
}

function isXrdPair(poolName: string): boolean {
  return poolName.toLowerCase().includes("xrd");
}

const STABLES = ["usdc", "usdt", "xusd", "husd", "dai"];

/**
 * Both legs must be stablecoins. Splits on BOTH delimiters: the server rebuilds
 * names from on-ledger symbols as "XRD-hUSDC" while Ociswap's own API uses
 * "REDDICKS/XRD". The previous version split on "/" only, so "XRD-hUSDC" stayed
 * a single token, matched "usdc" inside it, and a volatile XRD pair was filed
 * as a stablecoin pair.
 */
function isStablecoinPair(poolName: string): boolean {
  const parts = poolName.toLowerCase().split(/[/\-]/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => STABLES.some((s) => p.includes(s)));
}

function SkeletonCard() {
  return (
    <Card className="animate-pulse">
      <CardContent className="pt-6">
        <div className="space-y-3">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-8 w-16 rounded bg-muted" />
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-4 w-24 rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

function OpportunityCard({ opportunity }: { opportunity: Opportunity }) {
  const net = headlineApy(opportunity);
  const gross = grossApy(opportunity);
  const il = impermanentLoss(opportunity);
  const ilFree = isIlFree(opportunity);
  const risk = ilRiskLabel(opportunity.il_risk_score);

  return (
    <Link href={`/opportunity/${encodeURIComponent(opportunity.pool_address)}`}>
      <Card className="hover:border-foreground/20 transition-colors cursor-pointer h-full">
        <CardContent className="pt-6 flex flex-col gap-3">
          {/* gap + shrink-0 so a long name (the IL-free venues carry their
              measurement window in the title) cannot run into the protocol
              label — they collided with no space between them. */}
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium">{opportunity.pool_name}</span>
            <span className="shrink-0 text-xs text-muted-foreground capitalize">
              {opportunity.protocol}
            </span>
          </div>

          <div className="flex flex-wrap gap-1">
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {yieldKindLabel(opportunity.yield_kind)}
            </span>
            {isStablePair(opportunity) ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Stable pair
              </span>
            ) : null}
            <AuditBadge protocol={opportunity.protocol} variant="compact" />
          </div>

          {/* Net of IL — the number the user actually earns. Coloured by sign. */}
          <div className="flex flex-col gap-0.5">
            <span className={`text-3xl font-bold ${apyTone(net)}`}>
              {formatApy(net)}
            </span>
            <span className="text-xs text-muted-foreground">
              {ilFree
                ? "projected APY — single-asset, no IL to subtract"
                : "projected net APY, after impermanent loss"}
            </span>
          </div>

          {/* The arithmetic, shown so the headline is auditable. */}
          <div className="text-xs text-muted-foreground tabular-nums">
            {ilFree ? (
              <span>
                {formatApy(gross)} yield · no impermanent loss
              </span>
            ) : (
              <span>
                {formatApy(gross)} fees {formatApy(il)} est. IL
              </span>
            )}
          </div>

          <div className="flex items-center justify-between mt-auto pt-2">
            <span className={`text-xs font-medium ${risk.tone}`}>
              {risk.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatTvl(opportunity.tvl_usd)} TVL
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Shown when nothing in the index is projected to make money. This is the
 * common case on Radix right now and it must be stated plainly rather than
 * hidden behind a green number.
 */
function NoProfitableYieldNotice({ count }: { count: number }) {
  return (
    <Card className="border-risk-yellow/40 bg-risk-yellow/5 mb-6">
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-risk-yellow mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              None of the {count} pools we track is projected to profit right now
            </p>
            <p className="text-sm text-muted-foreground">
              Every pool below earns less in fees than it is expected to lose to
              impermanent loss, so its net APY is negative. That is a real
              finding about this market, not a display error — fee income on
              XRD pairs is currently far below XRD&apos;s volatility. Pools are
              ranked least-bad first. If you want yield without divergence
              risk, look at staking and lending, which carry no impermanent
              loss.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FilterBar({
  riskFilter,
  setRiskFilter,
  assetFilter,
  setAssetFilter,
  yieldFilter,
  setYieldFilter,
  sortOption,
  setSortOption,
}: {
  riskFilter: RiskFilter;
  setRiskFilter: (v: RiskFilter) => void;
  assetFilter: AssetFilter;
  setAssetFilter: (v: AssetFilter) => void;
  yieldFilter: YieldFilter;
  setYieldFilter: (v: YieldFilter) => void;
  sortOption: SortOption;
  setSortOption: (v: SortOption) => void;
}) {
  const pill = (active: boolean) =>
    `px-3 py-1 rounded-md text-sm transition-colors ${
      active
        ? "bg-foreground text-background"
        : "bg-muted text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex flex-wrap gap-4 items-center">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Show:</span>
        <div className="flex gap-1">
          {(
            [
              ["all", "All"],
              ["profitable", "Profitable only"],
              ["il-free", "No IL risk"],
            ] as [YieldFilter, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setYieldFilter(v)}
              className={pill(yieldFilter === v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">IL risk:</span>
        <div className="flex gap-1">
          {(["all", "low", "medium", "high"] as RiskFilter[]).map((v) => (
            <button
              key={v}
              onClick={() => setRiskFilter(v)}
              className={`capitalize ${pill(riskFilter === v)}`}
            >
              {v === "all" ? "All" : v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Asset:</span>
        <div className="flex gap-1">
          {(
            [
              ["all", "All"],
              ["xrd", "XRD Pairs"],
              ["stablecoins", "Stablecoins"],
            ] as [AssetFilter, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setAssetFilter(v)}
              className={pill(assetFilter === v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <span className="text-sm text-muted-foreground">Sort:</span>
        <select
          value={sortOption}
          onChange={(e) => setSortOption(e.target.value as SortOption)}
          className="rounded-md border bg-background px-3 py-1 text-sm"
        >
          {(Object.keys(SORT_LABELS) as SortOption[]).map((v) => (
            <option key={v} value={v}>
              {SORT_LABELS[v]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DiscoverContent() {
  const { data: opportunitiesRaw, isLoading, dataSource, error } =
    useOpportunities(50);

  const opportunities = useMemo(
    () => opportunitiesRaw ?? [],
    [opportunitiesRaw],
  );

  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [yieldFilter, setYieldFilter] = useState<YieldFilter>("all");
  // Default to the ranking that accounts for IL and its uncertainty.
  const [sortOption, setSortOption] = useState<SortOption>("risk-adjusted");

  const profitableCount = useMemo(
    () => profitable(opportunities).length,
    [opportunities],
  );

  const filteredAndSorted = useMemo(() => {
    let filtered = [...opportunities];

    if (yieldFilter === "profitable") {
      filtered = profitable(filtered);
    } else if (yieldFilter === "il-free") {
      filtered = filtered.filter(isIlFree);
    }

    if (riskFilter !== "all") {
      filtered = filtered.filter(
        (o) => ilRiskBucket(o.il_risk_score) === riskFilter,
      );
    }

    if (assetFilter === "xrd") {
      filtered = filtered.filter((o) => isXrdPair(o.pool_name));
    } else if (assetFilter === "stablecoins") {
      filtered = filtered.filter((o) => isStablecoinPair(o.pool_name));
    }

    return sortOpportunities(filtered, sortOption);
  }, [opportunities, riskFilter, assetFilter, yieldFilter, sortOption]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col p-6 md:p-12">
        {/* Header markup must match the loaded state exactly. When the two
            differed (mb-8 here vs mb-2 below) React logged a hydration
            mismatch on every visit, because the server renders the loading
            branch and the client re-renders the loaded one. */}
        <h1 className="text-3xl font-bold mb-2">Discover</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Every yield opportunity we can find on Radix, scored net of
          impermanent loss and ranked worst-case-first. Browse without signing
          in — connect when you&apos;re ready to deposit.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col p-6 md:p-12">
      <h1 className="text-3xl font-bold mb-2">Discover</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Every yield opportunity we can find on Radix, scored net of impermanent
        loss and ranked worst-case-first. Browse without signing in — connect
        when you&apos;re ready to deposit.
      </p>

      <DataSourceBanner source={dataSource} message={error} className="mb-6" />

      {opportunities.length > 0 && profitableCount === 0 && (
        <NoProfitableYieldNotice count={opportunities.length} />
      )}

      <FilterBar
        riskFilter={riskFilter}
        setRiskFilter={setRiskFilter}
        assetFilter={assetFilter}
        setAssetFilter={setAssetFilter}
        yieldFilter={yieldFilter}
        setYieldFilter={setYieldFilter}
        sortOption={sortOption}
        setSortOption={setSortOption}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
        {filteredAndSorted.map((opp) => (
          <OpportunityCard key={opp.pool_address} opportunity={opp} />
        ))}
      </div>

      {filteredAndSorted.length === 0 && (
        <p className="text-center text-muted-foreground py-12">
          {yieldFilter === "profitable"
            ? "No pool we track is currently projected to profit after impermanent loss. Switch to All to see the full index."
            : yieldFilter === "il-free"
            ? "No IL-free venues in the index yet."
            : "No opportunities match your filters. Try adjusting them."}
        </p>
      )}
    </main>
  );
}

export default function DiscoverPage() {
  return (
    <Suspense>
      <DiscoverContent />
    </Suspense>
  );
}
