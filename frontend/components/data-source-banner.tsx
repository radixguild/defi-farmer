"use client";

import { AlertTriangle } from "lucide-react";
import type { DataSource } from "@/lib/hooks/use-fetch";
import { cn } from "@/lib/utils";

interface DataSourceBannerProps {
  source: DataSource;
  message?: string | null;
  className?: string;
}

/**
 * Renders a sticky-feeling warning whenever the data on screen is NOT live.
 *
 * Three non-live states get distinct copy so the user knows whether the
 * numbers are real-but-stale (don't sign anyway) vs synthetic samples
 * (don't sign and don't believe the numbers either):
 *
 *   - stale-live    : last fetch failed; data shown is real but cached.
 *   - mock-degraded : API unreachable AND we have no cached real data.
 *   - mock-forced   : NEXT_PUBLIC_USE_MOCKS=true (dev / storybook).
 */
export function DataSourceBanner({ source, message, className }: DataSourceBannerProps) {
  if (source === "live" || source === "loading") return null;

  let headline: string;
  let detail: string;
  if (source === "stale-live") {
    headline = "Numbers may be stale — live API unreachable";
    detail =
      message ??
      "These are your real positions, but the most recent refresh failed. Do NOT sign any deposit, harvest, or rotation action until the connection is restored.";
  } else if (source === "mock-degraded") {
    headline = "Showing sample data — API unreachable";
    detail =
      message ??
      "Live numbers, balances, and APYs are NOT available right now. Do NOT sign any deposit, withdraw, or harvest action while this banner is visible.";
  } else {
    headline = "Sample data (development mode)";
    detail = "NEXT_PUBLIC_USE_MOCKS=true. Real wallet actions are disabled.";
  }

  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div>
          <p className="font-medium text-amber-900 dark:text-amber-100">{headline}</p>
          <p className="text-amber-800/80 dark:text-amber-100/80 mt-0.5">{detail}</p>
        </div>
      </div>
    </div>
  );
}
