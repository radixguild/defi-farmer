"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useOpportunities, usePositions, useAgentStatus } from "@/lib/hooks";
import { useWallet } from "@/lib/hooks/use-wallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HealthDot } from "@/components/health-dot";
import { RiskMeter } from "@/components/risk-meter";
import { ConnectWalletButton } from "@/components/connect-wallet-button";
import {
  apyTone,
  formatApy,
  headlineApy,
  isIlFree,
  profitable,
  yieldKindLabel,
} from "@/lib/yield";
import { Opportunity, Position } from "@/lib/types";

function getHealthStatus(position: Position): "healthy" | "warning" | "critical" {
  if (position.status === "exit_signal") return "critical";
  const pnlPct = ((position.current_value_xrd - position.deposited_xrd) / position.deposited_xrd) * 100;
  if (pnlPct < -10) return "critical";
  if (position.apy_7d_ma < 0) return "critical";
  // APY declining > 10% would be warning — approximate with low APY
  if (position.apy_7d_ma < 5) return "warning";
  return "healthy";
}

function formatXrd(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** "2m ago" / "3h ago" / "—". Coarse on purpose: the scan cadence is hourly. */
function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 0) return "just now";
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function SkeletonCard() {
  return (
    <Card className="animate-pulse">
      <CardHeader>
        <div className="h-4 w-24 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="h-8 w-32 rounded bg-muted" />
          <div className="h-4 w-20 rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The synthetic address the staking scanner emits — mirrors the server's
 * exported `XRD_STAKING_ADDRESS`. It is the ONLY venue whose figure is derived
 * rather than measured, so it is the only correct discriminator here.
 * `yield_kind` cannot do this job: LSULP is also 'staking' but IS realized.
 */
const NATIVE_XRD_STAKING_ADDRESS = "native_xrd_staking";

/**
 * The label under a headline figure — it must name both the IL treatment AND
 * where the number came from, because the three IL-free venues do not agree on
 * the second part.
 *
 * "net APY after IL" is only true where impermanent loss exists. Staking and
 * lending are IL-free by construction, so stamping the LP caption on them
 * implied an adjustment that never happened.
 *
 * But "realized" is wrong for NATIVE staking specifically: that figure is a
 * forward projection from a protocol constant (300M XRD/yr ÷ registered stake),
 * not a measurement of anything that already happened. LSULP and Weft genuinely
 * are realized — both derive from a redemption ratio over a trailing 30 days.
 * Calling a projection "realized" is the same class of error as calling a gross
 * figure net.
 *
 * Splitting on `yield_kind` was the first attempt and was WRONG: LSULP carries
 * yield_kind 'staking' too, so it inherited "projected" despite its row being
 * literally named "(realized, trailing 30d)". Only the native venue is derived.
 */
function yieldCaption(opp: Opportunity): string {
  if (!isIlFree(opp)) return "net APY after IL";
  return opp.pool_address === NATIVE_XRD_STAKING_ADDRESS
    ? "projected APY · no IL exposure"
    : "realized APY · no IL exposure";
}

/**
 * Dashboard header.
 *
 * Deliberately not a pitch. This page used to open with "Earn up to X% APY on
 * Radix" plus a self-custody tagline — marketing copy on a tool whose whole
 * value is that it does not oversell. The status line is the honest equivalent:
 * what is being tracked, how fresh it is, and whether the agent is alive.
 */
function DashboardHeader({
  count,
  lastScan,
  running,
  halted,
  connected,
}: {
  count: number;
  lastScan: number | null;
  running: boolean;
  halted: boolean;
  connected: boolean;
}) {
  const state = halted ? "halted" : running ? "running" : "stopped";
  const tone = halted
    ? "text-loss-red"
    : running
    ? "text-profit-green"
    : "text-muted-foreground";

  return (
    <div className="flex flex-wrap items-start justify-between gap-4 w-full">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Yield dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Tracking {count} {count === 1 ? "venue" : "venues"} on Radix · updated{" "}
          {timeAgo(lastScan)} · agent <span className={tone}>{state}</span>
        </p>
      </div>
      {!connected && <ConnectWalletButton />}
    </div>
  );
}

/** One number plus its label. Dense by design — this is a readout, not a pitch. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card className="h-full">
      <CardContent className="pt-5 pb-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span className={`text-2xl font-bold tracking-tight ${tone ?? ""}`}>
            {value}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Market summary.
 *
 * "Profitable now" is the number that matters and is usually small — on Radix
 * today only the IL-free venues clear zero. Showing it as `n of total` keeps
 * that honest without needing a sentence about it.
 */
function MarketSummary({ opportunities }: { opportunities: Opportunity[] }) {
  const total = opportunities.length;
  const winners = profitable(opportunities);
  const best = total ? Math.max(...opportunities.map(headlineApy)) : 0;
  const worst = total ? Math.min(...opportunities.map(headlineApy)) : 0;

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-stretch">
        <Stat label="Venues tracked" value={String(total)} />
        <Stat
          label="Profitable now"
          value={`${winners.length} of ${total}`}
          tone={winners.length ? "text-profit-green" : "text-muted-foreground"}
        />
        <Stat
          label="Best net yield"
          value={formatApy(best)}
          tone={apyTone(best)}
        />
        <Stat label="Worst" value={formatApy(worst)} tone={apyTone(worst)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Yields are net of expected impermanent loss and can be negative.
      </p>
    </div>
  );
}

function VenueCard({ opp }: { opp: Opportunity }) {
  return (
    <Link href={`/opportunity/${encodeURIComponent(opp.pool_address)}`}>
      <Card className="h-full hover:border-foreground/20 transition-colors cursor-pointer">
        <CardContent className="pt-5 pb-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {opp.pool_name}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
                {yieldKindLabel(opp.yield_kind)}
              </span>
            </div>
            <span className={`text-2xl font-bold ${apyTone(headlineApy(opp))}`}>
              {formatApy(headlineApy(opp))}
            </span>
            <span className="text-xs text-muted-foreground">
              {yieldCaption(opp)}
            </span>
            <RiskMeter ilRiskScore={opp.il_risk_score} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Top venues by risk-adjusted rank, whatever their sign.
 *
 * The negatives stay on screen deliberately: a venue projected to lose money is
 * still worth tracking, and hiding it would recreate the "only show green
 * numbers" behaviour this app exists to avoid.
 */
function TopVenues({ opportunities }: { opportunities: Opportunity[] }) {
  const winners = profitable(opportunities);
  const losers = opportunities.length - winners.length;

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Best risk-adjusted</h2>
        <Link
          href="/discover"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {opportunities.slice(0, 3).map((opp) => (
          <VenueCard key={opp.pool_address} opp={opp} />
        ))}
      </div>
      {losers > 0 && (
        <p className="text-sm text-muted-foreground">
          {losers} of {opportunities.length} tracked{" "}
          {losers === 1 ? "venue is" : "venues are"} projected to lose money after
          impermanent loss.{" "}
          <Link href="/discover" className="underline hover:text-foreground">
            Browse all
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function PositionCard({ position }: { position: Position }) {
  const pnl = position.current_value_xrd - position.deposited_xrd;
  const pnlPct = (pnl / position.deposited_xrd) * 100;
  const health = getHealthStatus(position);

  return (
    <Link href="/positions">
      <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{position.pool_name}</CardTitle>
            <HealthDot status={health} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Value</span>
              <span className="text-lg font-semibold">
                {formatXrd(position.current_value_xrd)} XRD
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">P&L</span>
              <span
                className={`text-sm font-medium ${
                  pnl >= 0 ? "text-profit-green" : "text-loss-red"
                }`}
              >
                {pnl >= 0 ? "+" : ""}
                {formatXrd(pnl)} XRD ({pnlPct >= 0 ? "+" : ""}
                {pnlPct.toFixed(1)}%)
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function PortfolioSection({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return (
      <div className="w-full flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Your positions</h2>
        <p className="text-sm text-muted-foreground">
          No open positions.{" "}
          <Link href="/discover" className="underline hover:text-foreground">
            Browse venues
          </Link>{" "}
          to open one.
        </p>
      </div>
    );
  }

  const totalPnl = positions.reduce(
    (sum, p) => sum + (p.current_value_xrd - p.deposited_xrd),
    0,
  );
  const totalValue = positions.reduce((sum, p) => sum + p.current_value_xrd, 0);

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your positions</h2>
        <Link
          href="/positions"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          Manage <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Stat label="Positions" value={String(positions.length)} />
        <Stat label="Value" value={`${formatXrd(totalValue)} XRD`} />
        <Stat
          label="P&L"
          value={`${totalPnl >= 0 ? "+" : ""}${formatXrd(totalPnl)} XRD`}
          tone={totalPnl >= 0 ? "text-profit-green" : "text-loss-red"}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {positions.map((position) => (
          <PositionCard key={position.id} position={position} />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const { connected } = useWallet();
  // Pull the full set, not three: the summary counts are only honest over
  // everything that is tracked.
  const { data: opportunities, isLoading: oppsLoading } = useOpportunities(50);
  const { data: positions, isLoading: posLoading } = usePositions();
  const { data: status } = useAgentStatus();

  const isLoading = oppsLoading || (connected && posLoading);

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center p-6 md:p-12">
        <div className="w-full max-w-4xl grid grid-cols-2 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </main>
    );
  }

  const opps = opportunities ?? [];

  return (
    <main className="flex min-h-screen flex-col items-center p-6 md:p-12">
      <div className="w-full max-w-4xl flex flex-col gap-8">
        <DashboardHeader
          count={opps.length}
          lastScan={status?.lastScan ?? null}
          running={status?.running ?? false}
          halted={status?.halted ?? false}
          connected={connected}
        />
        {connected && <PortfolioSection positions={positions ?? []} />}
        {opps.length > 0 && (
          <>
            <MarketSummary opportunities={opps} />
            <TopVenues opportunities={opps} />
          </>
        )}
        {opps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No venue data yet. The agent scans hourly — check back shortly.
          </p>
        )}
      </div>
    </main>
  );
}
