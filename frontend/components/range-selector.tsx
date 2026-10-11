"use client";

import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RangeSuggestion } from "@/lib/api/dex";

/** The widths a user can pick — matches the optimizer's candidate grid. */
const WIDTHS = [1.02, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];

function pctDown(m: number): string {
  return `−${((1 - 1 / m) * 100).toFixed(1)}%`;
}
function pctUp(m: number): string {
  return `+${((m - 1) * 100).toFixed(1)}%`;
}

/**
 * Concentrated-range width selector: a discrete slider over symmetric width
 * multiples (range = [1/m, m] × current price), seeded by the server-side
 * optimizer when it has live vol for the pair. The chosen multiple goes to
 * POST /api/dex/build as `range: { multiple }` — the server converts it to
 * on-grid ticks/bins.
 */
export function RangeSelector({
  value,
  onChange,
  suggestion,
  disabled = false,
}: {
  value: number;
  onChange: (multiple: number) => void;
  suggestion?: RangeSuggestion;
  disabled?: boolean;
}) {
  const index = useMemo(() => {
    const i = WIDTHS.findIndex((w) => w >= value);
    return i === -1 ? WIDTHS.length - 1 : i;
  }, [value]);

  const isSuggested = suggestion !== undefined && value === suggestion.multiple;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground">Price range</label>
        <span className="text-sm font-medium">
          {pctDown(value)} / {pctUp(value)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={WIDTHS.length - 1}
        step={1}
        value={index}
        disabled={disabled}
        onChange={(e) => onChange(WIDTHS[parseInt(e.target.value, 10)])}
        className="w-full accent-foreground"
        aria-label="Range width"
      />
      <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground/70">
        <span>Tight · more fees, more risk</span>
        <span>Wide · calmer</span>
      </div>

      {suggestion && (
        <div className="rounded-md bg-muted p-3 text-sm space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Suggested: {pctDown(suggestion.multiple)} / {pctUp(suggestion.multiple)}
            </span>
            {!isSuggested && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onChange(suggestion.multiple)}
              >
                Use
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Modeled on this pair&apos;s volatility: ~{Math.round(suggestion.timeInRange * 100)}% of
            the next 30 days in range, ~{suggestion.exitsPerYear.toFixed(0)} re-ranges/yr.
            Estimates, not guarantees.
          </p>
        </div>
      )}
    </div>
  );
}
