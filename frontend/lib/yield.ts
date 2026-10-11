/**
 * The single source of truth for how a yield figure is presented.
 *
 * This module exists because of a real bug: the server computed net-of-IL
 * returns (`net_apy_ma_7d`, `estimated_il`, `risk_adjusted_return`) and served
 * them correctly, while every frontend surface independently reached for
 * `apy_7d_ma` — the GROSS figure — and painted it `profit-green`. Discover, the
 * home tile and the detail page each made the same mistake separately, so
 * fixing one left the others lying.
 *
 * Rule: UI code must not read `apy_7d_ma` directly. Go through `headlineApy`,
 * `grossApy` and `apyTone` so there is exactly one definition of the number a
 * user sees, and one place to change it.
 */

import type { Opportunity, YieldKind } from "@/lib/types";

/**
 * The number to show as THE yield. Net of expected impermanent loss, so it can
 * legitimately be negative — that is the point, not a rendering bug.
 */
export function headlineApy(opp: Opportunity): number {
  return opp.net_apy_ma_7d;
}

/** Fee income before IL. Only ever shown as a labelled breakdown component. */
export function grossApy(opp: Opportunity): number {
  return opp.apy_7d_ma;
}

/** Expected annualised IL as a negative number, or 0 for IL-free venues. */
export function impermanentLoss(opp: Opportunity): number {
  return opp.estimated_il;
}

/** True when the venue cannot suffer impermanent loss by construction. */
export function isIlFree(opp: Opportunity): boolean {
  return opp.yield_kind === "staking" || opp.yield_kind === "lending";
}

/**
 * Whether the pair is stablecoin-ish, as a REAL boolean.
 *
 * The API sources this from SQLite, which has no boolean type and sends integer
 * 0 / 1. Writing `{opp.is_stable && <Badge/>}` therefore renders a literal "0"
 * on every non-stable card — React skips `false` but prints `0`. That shipped to
 * production and was visible on every card in the list.
 */
export function isStablePair(opp: Opportunity): boolean {
  return Boolean(opp.is_stable);
}

/** Colour by sign. Never paint a return green without checking it is one. */
export function apyTone(value: number): string {
  if (value > 0) return "text-profit-green";
  if (value < 0) return "text-loss-red";
  return "text-muted-foreground";
}

export function formatApy(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatTvl(tvl: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(tvl);
}

/**
 * Plain-English IL risk from the server's 0-100 `il_risk_score` (higher =
 * more divergence risk). Deliberately worded as risk, not quality, so it can
 * never be mistaken for a star rating.
 */
export function ilRiskLabel(score: number): { label: string; tone: string } {
  if (score <= 20) return { label: "Very low IL risk", tone: "text-profit-green" };
  if (score <= 40) return { label: "Low IL risk", tone: "text-profit-green" };
  if (score <= 60) return { label: "Moderate IL risk", tone: "text-risk-yellow" };
  if (score <= 80) return { label: "High IL risk", tone: "text-risk-orange" };
  return { label: "Very high IL risk", tone: "text-loss-red" };
}

export function yieldKindLabel(kind: YieldKind | undefined): string {
  switch (kind) {
    case "staking":
      return "Staking";
    case "lending":
      return "Lending";
    case "amm-lp":
      return "LP pool";
    default:
      return "LP pool";
  }
}

export type SortOption = "risk-adjusted" | "net-yield" | "il-risk" | "tvl";

export const SORT_LABELS: Record<SortOption, string> = {
  "risk-adjusted": "Best risk-adjusted",
  "net-yield": "Highest net yield",
  "il-risk": "Lowest IL risk",
  tvl: "Largest pool",
};

/**
 * Comparators rank on net/risk-adjusted figures only. The previous "Highest
 * yield" sorted on gross APY and so ranked the worst net performer first; the
 * old "Trending" (`gross / (101 - score)`) mixed a gross return with a
 * composite score and meant nothing, so it is gone rather than relabelled.
 */
export function sortOpportunities(
  opps: Opportunity[],
  sort: SortOption,
): Opportunity[] {
  const out = [...opps];
  switch (sort) {
    case "risk-adjusted":
      out.sort((a, b) => b.risk_adjusted_return - a.risk_adjusted_return);
      break;
    case "net-yield":
      out.sort((a, b) => headlineApy(b) - headlineApy(a));
      break;
    case "il-risk":
      out.sort((a, b) => a.il_risk_score - b.il_risk_score);
      break;
    case "tvl":
      out.sort((a, b) => b.tvl_usd - a.tvl_usd);
      break;
  }
  return out;
}

/** Pools projected to make money after IL. Usually empty on Radix today. */
export function profitable(opps: Opportunity[]): Opportunity[] {
  return opps.filter((o) => headlineApy(o) > 0);
}
