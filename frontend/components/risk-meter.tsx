"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ilRiskLabel } from "@/lib/yield";

interface RiskMeterProps {
  /** Server `il_risk_score`, 0-100, HIGHER = more divergence risk. */
  ilRiskScore: number;
  className?: string;
}

/**
 * Impermanent-loss risk, stated in words plus a filled bar.
 *
 * Replaces the previous `RiskStars`, which was actively misleading: it mapped
 * `score >= 80` to ONE star and `score < 20` to FIVE, so the safest pools drew
 * the fewest stars and the riskiest drew a full five — while sitting directly
 * beside a green APY figure. Every user reads five filled stars as "excellent".
 * It also keyed off the composite quality `score` rather than the IL risk it
 * appeared to show.
 *
 * A bar plus an explicit "…IL risk" caption cannot be read backwards: more fill
 * means more risk, and the label says so in words.
 */
export function RiskMeter({ ilRiskScore, className }: RiskMeterProps) {
  const { label, tone } = ilRiskLabel(ilRiskScore);
  const pct = Math.min(100, Math.max(0, ilRiskScore));

  const fill =
    ilRiskScore <= 40
      ? "bg-profit-green"
      : ilRiskScore <= 60
      ? "bg-risk-yellow"
      : ilRiskScore <= 80
      ? "bg-risk-orange"
      : "bg-loss-red";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full", fill)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn("text-xs font-medium", tone)}>{label}</span>
    </div>
  );
}
