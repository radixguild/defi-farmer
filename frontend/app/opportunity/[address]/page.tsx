"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useOpportunities, useSnapshots } from "@/lib/hooks";
import { useWallet } from "@/lib/hooks/use-wallet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RiskMeter } from "@/components/risk-meter";
import { DataSourceBanner } from "@/components/data-source-banner";
import { DexPreviewModal } from "@/components/dex-preview-modal";
import { RangeSelector } from "@/components/range-selector";
import { TrustPanel } from "@/components/trust-panel";
import {
  apyTone,
  formatApy,
  grossApy,
  headlineApy,
  impermanentLoss,
  isIlFree,
} from "@/lib/yield";
import { Opportunity } from "@/lib/types";
import {
  getPoolInfo,
  buildDex,
  DexApiError,
  type DexBuildRequest,
  type DexBuildResult,
  type DexPoolInfo,
} from "@/lib/api/dex";

type TimeRange = "7d" | "30d";

/// scanned_at arrives as SQLite's "YYYY-MM-DD HH:MM:SS", which is UTC but
/// carries no zone marker — `new Date(...)` would read it as LOCAL time and
/// shift every label by the viewer's offset (a Tokyo viewer would see 09:00Z
/// labelled 9 AM instead of 6 PM). Date-only labels mostly hid this; showing
/// the hour is what exposes it. Mirrors parseSqliteUtc on the server.
function parseScannedAt(value: string): Date {
  return new Date(/[TZ+]/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

function formatTvl(tvl: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(tvl);
}

/**
 * Divergence risk from the server's `il_risk_score` (0-100, HIGHER = riskier).
 *
 * This previously took the composite quality `score` and read it backwards for
 * the thing it claimed to describe: `score >= 80` was captioned "Low ... price
 * movement risk", but that score blends net APY, TVL stability, protocol
 * diversity and data quality, so a pool could score high for reasons entirely
 * unrelated to how volatile its pair is.
 */
function getRiskLevel(ilRiskScore: number): { level: string; color: string; description: string } {
  if (ilRiskScore <= 40) return { level: "Low", color: "bg-profit-green", description: "The two tokens in this pool tend to move together, so impermanent loss should stay small. Your deposit value is unlikely to diverge much from simply holding." };
  if (ilRiskScore <= 70) return { level: "Medium", color: "bg-risk-yellow", description: "These tokens move apart often enough to cost you. Expect some impermanent loss — the projected net APY above already subtracts it." };
  return { level: "High", color: "bg-loss-red", description: "These tokens diverge sharply, so impermanent loss is likely to be large. You could end up worse off than holding the two tokens outright." };
}

function SkeletonChart() {
  return (
    <div className="animate-pulse">
      <div className="h-64 w-full rounded bg-muted" />
    </div>
  );
}

function SkeletonDetails() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-48 rounded bg-muted" />
      <div className="h-4 w-32 rounded bg-muted" />
      <div className="h-20 w-full rounded bg-muted" />
    </div>
  );
}

export default function OpportunityDetailPage() {
  const params = useParams();
  // Opportunity ids can contain ':' (e.g. weft-v2:<resource>), which the router
  // percent-encodes in the path and does NOT decode in params — so without this
  // the id reads 'weft-v2%3A…' and never matches the opportunity list or the
  // server's venue dispatch. Decode defensively (malformed % → keep raw).
  const rawAddress = params.address as string;
  let address = rawAddress;
  try {
    address = decodeURIComponent(rawAddress);
  } catch {
    address = rawAddress;
  }
  const { connected, accounts, sendTransaction, ensureSession } = useWallet();
  const { data: snapshots, isLoading: snapshotsLoading } = useSnapshots(address);
  const { data: opportunities, isLoading: oppsLoading, dataSource: oppsSource, error: oppsError } =
    useOpportunities(50);
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  // Resolved pool identity — drives which deposit inputs the form shows.
  const [poolInfo, setPoolInfo] = useState<DexPoolInfo | null>(null);
  const [poolInfoError, setPoolInfoError] = useState<string | null>(null);
  const [amountX, setAmountX] = useState("");
  const [amountY, setAmountY] = useState("");
  // DefiPlaza single-sided: which token goes in.
  const [plazaSide, setPlazaSide] = useState<"x" | "y">("x");
  const [rangeMultiple, setRangeMultiple] = useState(1.3);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [build, setBuild] = useState<DexBuildResult | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signSuccess, setSignSuccess] = useState<{ intentHash: string } | null>(null);
  const [recordNote, setRecordNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoolInfo(null);
    setPoolInfoError(null);
    getPoolInfo(address)
      .then((info) => {
        if (cancelled) return;
        setPoolInfo(info);
        if (info.suggestion) setRangeMultiple(info.suggestion.multiple);
      })
      .catch((e) => {
        if (!cancelled) setPoolInfoError(e instanceof Error ? e.message : "Failed to resolve pool");
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const opportunity = useMemo<Opportunity | undefined>(
    () => opportunities?.find((o) => o.pool_address === address),
    [opportunities, address],
  );

  // Enriched pool names are "SYMX-SYMY" in the resolver's token order, so the
  // halves label the amountX/amountY inputs. Fallback for unenriched names.
  const [labelX, labelY] = useMemo(() => {
    const parts = (opportunity?.pool_name ?? "").split(/[-/]/);
    return parts.length === 2 ? parts : ["Token X", "Token Y"];
  }, [opportunity]);

  const chartData = useMemo(() => {
    if (!snapshots) return [];
    const hoursToShow = timeRange === "7d" ? 168 : 720;
    const data = snapshots.slice(-hoursToShow);
    return data.map((s) => ({
      // Hourly points: 7d needs the hour to distinguish same-day ticks; 30d is
      // wide enough that the date alone reads better.
      time:
        timeRange === "7d"
          ? parseScannedAt(s.scanned_at).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
            })
          : parseScannedAt(s.scanned_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
      // Defensive: a snapshot row missing apy_7d_ma must not crash the chart
      // (and take the whole deposit page with it).
      apy: Number((s.apy_7d_ma ?? 0).toFixed(2)),
    }));
  }, [snapshots, timeRange]);

  const account = accounts[0]?.address;
  // isFinite guards against `1e10` getting through the type="number" input and
  // reaching the builder's strict decimal validator late.
  const posDec = (s: string) => !!s && Number.isFinite(parseFloat(s)) && parseFloat(s) > 0;
  const kind = poolInfo?.kind;
  // Single-sided venues (native staking, LSULP, Weft lending): one XRD amount,
  // no range, no second leg. Carried in amountX for reuse of the existing plumbing.
  const isVenue = kind === "native_stake" || kind === "weft_lending" || kind === "lsulp";
  // Which amounts the form needs, per resolved kind. Concentrated pools allow
  // one empty leg — the pool takes the price-correct ratio inside the range.
  const amountsValid =
    kind === "defiplaza_pair"
      ? posDec(plazaSide === "x" ? amountX : amountY)
      : isVenue
        ? posDec(amountX)
        : kind === "ociswap_precision" || kind === "caviarnine_quantaswap"
          ? posDec(amountX) || posDec(amountY)
          : posDec(amountX) && posDec(amountY);
  const canDeposit =
    connected && !!account && !!poolInfo && kind !== "unsupported" &&
    amountsValid && oppsSource === "live";

  const depositRequest = (coAmount?: string): DexBuildRequest => {
    const base = { action: "deposit" as const, account: account!, poolAddress: address };
    if (kind === "defiplaza_pair") {
      return {
        ...base,
        inputToken: plazaSide === "x" ? poolInfo!.tokenX : poolInfo!.tokenY,
        inputAmount: plazaSide === "x" ? amountX : amountY,
        coAmount,
      };
    }
    if (kind === "ociswap_precision" || kind === "caviarnine_quantaswap") {
      return {
        ...base,
        amountX: posDec(amountX) ? amountX : "0",
        amountY: posDec(amountY) ? amountY : "0",
        range: { multiple: rangeMultiple },
      };
    }
    // Single-sided venues: one XRD amount in amountX; the server resolves the
    // validator / component and builds the stake/supply manifest.
    if (isVenue) {
      return { ...base, amountX };
    }
    return { ...base, amountX, amountY };
  };

  const runBuild = async (req: DexBuildRequest) => {
    setPreviewOpen(true);
    setIsBuilding(true);
    setBuildError(null);
    setBuild(null);
    setSignError(null);
    setSignSuccess(null);
    try {
      setBuild(await buildDex(req));
    } catch (err) {
      setBuildError(err instanceof DexApiError ? err.message : "Failed to build transaction");
    } finally {
      setIsBuilding(false);
    }
  };

  const handleDeposit = () => {
    if (!canDeposit || !account) return;
    void runBuild(depositRequest());
  };

  // DefiPlaza: the preview said the single-sided lane is in shortage — rebuild
  // with the user's co-liquidity amount for the other token.
  const handleProvideCoLiquidity = (coAmount: string) => {
    if (!account) return;
    void runBuild(depositRequest(coAmount));
  };

  const handleSign = async (manifest: string) => {
    if (!sendTransaction) return;
    setIsSigning(true);
    setSignError(null);
    try {
      // sendTransaction returns a thenable (RDT's neverthrow ResultAsync) —
      // await it so wallet rejections / RPC failures surface in the modal
      // instead of being silently swallowed.
      const result = await sendTransaction({
        transactionManifest: manifest,
        version: 1,
      });
      // RDT's SendTransactionResult is { isErr(): boolean, value?, error? }.
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
      // Record the position server-side (verified against the Gateway) so it
      // shows up under Positions. Fire-and-forget: the deposit itself is
      // already on-chain either way.
      void recordPosition(intentHash);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Wallet error";
      setSignError(message);
    } finally {
      setIsSigning(false);
    }
  };

  /**
   * Verified position recording (D5). The wallet returns as soon as the tx is
   * SUBMITTED; the recorder requires CommittedSuccess — so poll: up to 10
   * tries, 6s apart (commit is typically 5–30s). Failures never block the
   * deposit — the funds are on-chain regardless, and the same hash can be
   * recorded later (the endpoint is idempotent).
   */
  const recordPosition = async (intentHash: string) => {
    setRecordNote(null);
    const authed = await ensureSession();
    if (!authed) {
      setRecordNote(
        "Deposit submitted. Connect your wallet (the Connect button at the top of the page) to track it in your portfolio — deposit again is NOT needed.",
      );
      return;
    }
    setRecordNote("Deposit submitted — waiting for on-chain commit to record it…");
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await fetch("/api/positions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent_hash: intentHash, pool_address: address }),
        });
        if (res.ok) {
          setRecordNote("Position recorded — it's now under Positions.");
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const notCommittedYet = res.status === 409 && (body?.error ?? "").includes("not committed");
        if (!notCommittedYet) {
          setRecordNote(`Deposit submitted, but recording failed: ${body?.error ?? `HTTP ${res.status}`}`);
          return;
        }
      } catch {
        // Network blip — fall through to the retry wait.
      }
      await new Promise((r) => setTimeout(r, 6000));
    }
    setRecordNote(
      "Deposit submitted, but it hasn't committed yet. Your funds are safe — revisit this page later to record the position.",
    );
  };

  const handleClosePreview = () => {
    setPreviewOpen(false);
    setSignError(null);
    setSignSuccess(null);
    setBuildError(null);
  };

  const isLoading = snapshotsLoading || oppsLoading;

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col p-6 md:p-12 max-w-4xl mx-auto">
        <Link href="/discover" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="h-4 w-4" /> Back to Discover
        </Link>
        <SkeletonDetails />
        <div className="mt-8">
          <SkeletonChart />
        </div>
      </main>
    );
  }

  if (!opportunity) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6">
        <p className="text-muted-foreground">Opportunity not found.</p>
        <Link href="/discover" className="mt-4 text-sm underline">
          Back to Discover
        </Link>
      </main>
    );
  }

  const risk = getRiskLevel(opportunity.il_risk_score);
  const poolTokens = opportunity.pool_name.split("/");

  return (
    <main className="flex min-h-screen flex-col p-6 md:p-12 max-w-4xl mx-auto">
      <Link href="/discover" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Discover
      </Link>

      <DataSourceBanner
        source={oppsSource}
        message={oppsError}
        className="mb-6"
      />

      {/* Header */}
      <div className="flex flex-col gap-2 mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{opportunity.pool_name}</h1>
          <span className="text-sm text-muted-foreground capitalize px-2 py-0.5 rounded bg-muted">
            {opportunity.protocol}
          </span>
        </div>
        <div className="flex items-baseline gap-4">
          <span
            className={`text-4xl font-bold ${apyTone(headlineApy(opportunity))}`}
          >
            {formatApy(headlineApy(opportunity))}
          </span>
          <span className="text-muted-foreground">
            {isIlFree(opportunity)
              ? "projected APY — single-asset, no IL to subtract"
              : "projected net APY, after impermanent loss"}
          </span>
        </div>
        {/* The arithmetic behind the headline, so it can be checked. */}
        <p className="text-sm text-muted-foreground tabular-nums">
          {isIlFree(opportunity) ? (
            <>{formatApy(grossApy(opportunity))} yield · no impermanent loss</>
          ) : (
            <>
              {formatApy(grossApy(opportunity))} in fees{" "}
              {formatApy(impermanentLoss(opportunity))} expected impermanent
              loss
            </>
          )}
        </p>
        <RiskMeter ilRiskScore={opportunity.il_risk_score} />
      </div>

      {/* Chart */}
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Yield History</CardTitle>
            <div className="flex gap-1">
              {(["7d", "30d"] as TimeRange[]).map((range) => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-3 py-1 rounded text-sm transition-colors ${
                    timeRange === range
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="apyGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12 }}
                  // Points are hourly, so a date-only label repeats 24x a day.
                  // Thin to the ends plus a bounded number of interior ticks.
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  formatter={(value: number) => [`${value}%`, "APY"]}
                  contentStyle={{
                    borderRadius: "8px",
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--card))",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="apy"
                  stroke="hsl(142, 76%, 36%)"
                  fill="url(#apyGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pool Info */}
        <div className="space-y-4">
          {/* Trust panel — audit + custody + curator (top-most so the
              user sees it before they reason about deposit amount) */}
          <TrustPanel opportunity={opportunity} />

          {/* Price Movement Risk */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Price Movement Risk</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${risk.color}`}
                    style={{ width: `${100 - opportunity.score}%` }}
                  />
                </div>
                <span className="text-sm font-medium">{risk.level}</span>
              </div>
              <p className="text-sm text-muted-foreground">{risk.description}</p>
            </CardContent>
          </Card>

          {/* Pool Composition */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Pool Composition</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                {poolTokens.map((token) => (
                  <div key={token} className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                      {token.slice(0, 2)}
                    </div>
                    <span className="font-medium">{token}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground mt-3">
                Approximate 50/50 ratio
              </p>
            </CardContent>
          </Card>

          {/* Pool Size */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Pool Size</span>
                <span className="text-xl font-bold">
                  {formatTvl(opportunity.tvl_usd)}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Deposit CTA — inputs follow the pool's RESOLVED blueprint */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Deposit</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {poolInfoError && (
              <p className="rounded-md border border-loss-red/50 bg-loss-red/10 p-3 text-sm text-loss-red">
                Could not resolve this pool: {poolInfoError}
              </p>
            )}
            {!poolInfo && !poolInfoError && (
              <div className="animate-pulse space-y-2">
                <div className="h-10 w-full rounded bg-muted" />
                <div className="h-10 w-full rounded bg-muted" />
              </div>
            )}
            {kind === "unsupported" && (
              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                This pool&apos;s blueprint isn&apos;t supported for deposits yet.
              </p>
            )}

            {poolInfo && kind !== "unsupported" && (
              <>
                {isVenue ? (
                  <div className="space-y-2">
                    <label className="text-sm text-muted-foreground">
                      Amount (XRD)
                    </label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      min="0"
                      value={amountX}
                      onChange={(e) => setAmountX(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {kind === "native_stake"
                        ? "Staked to the top-paying active validator — you receive its Liquid Stake Unit (LSU), redeemable back to XRD after the unstake delay."
                        : kind === "lsulp"
                          ? "Staked and pooled into CaviarNine LSULP — you receive LSULP (the liquid-staking yield token) plus a pool receipt, tradable any time."
                          : "Supplied to Weft V2 lending — you receive w2-XRD deposit units that accrue interest and redeem back to XRD on withdraw."}
                    </p>
                  </div>
                ) : kind === "defiplaza_pair" ? (
                  <div className="space-y-2">
                    <label className="text-sm text-muted-foreground">
                      Deposit token (single-sided)
                    </label>
                    <div className="flex gap-1">
                      {(["x", "y"] as const).map((side) => (
                        <button
                          key={side}
                          type="button"
                          onClick={() => setPlazaSide(side)}
                          className={`flex-1 px-3 py-1.5 rounded text-sm transition-colors ${
                            plazaSide === side
                              ? "bg-foreground text-background"
                              : "bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {side === "x" ? labelX : labelY}
                        </button>
                      ))}
                    </div>
                    <Input
                      type="number"
                      placeholder="0.00"
                      min="0"
                      value={plazaSide === "x" ? amountX : amountY}
                      onChange={(e) =>
                        plazaSide === "x" ? setAmountX(e.target.value) : setAmountY(e.target.value)
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      If the pool needs both tokens right now, the preview will ask
                      for the second amount.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="text-sm text-muted-foreground">
                      Amount ({labelX})
                    </label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      min="0"
                      value={amountX}
                      onChange={(e) => setAmountX(e.target.value)}
                    />
                    <label className="text-sm text-muted-foreground">
                      Amount ({labelY})
                    </label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      min="0"
                      value={amountY}
                      onChange={(e) => setAmountY(e.target.value)}
                    />
                    {poolInfo.concentrated && (
                      <p className="text-xs text-muted-foreground">
                        One side may be 0 — the pool takes the correct ratio for
                        your range and returns any change.
                      </p>
                    )}
                  </div>
                )}

                {poolInfo.concentrated && (
                  <RangeSelector
                    value={rangeMultiple}
                    onChange={setRangeMultiple}
                    suggestion={poolInfo.suggestion}
                  />
                )}
              </>
            )}

            {recordNote && (
              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                {recordNote}
              </p>
            )}

            {connected ? (
              <Button
                className="w-full"
                size="lg"
                onClick={handleDeposit}
                disabled={!canDeposit || isBuilding}
                title={
                  oppsSource !== "live"
                    ? "Live data required to deposit. The API is unreachable — try again shortly."
                    : undefined
                }
              >
                Review deposit
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground text-center">
                Connect your wallet with the Connect button at the top of the
                page to deposit.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <DexPreviewModal
        open={previewOpen}
        onClose={handleClosePreview}
        build={build}
        isBuilding={isBuilding}
        buildError={buildError}
        poolName={opportunity.pool_name}
        onSign={handleSign}
        isSigning={isSigning}
        signError={signError}
        signSuccess={signSuccess}
        onProvideCoLiquidity={handleProvideCoLiquidity}
      />
    </main>
  );
}
