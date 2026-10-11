"use client";

import type { HoldingsResult } from "@/lib/types";
import { useFetch } from "./use-fetch";

/// What the LEDGER says the signed-in account holds, classified server-side
/// (GET /api/holdings, session tier — the proxy forwards the farmer_session
/// cookie). Distinct from usePositions, which only knows deposits recorded
/// through this app: pre-existing stake and LP show up HERE and nowhere else.
///
/// No mock fallback, deliberately. Holdings inform real decisions about real
/// balances; a sample account rendering under the user's own wallet header
/// would be worse than an empty state. mock-degraded therefore renders as
/// "unavailable", not as data.
export function useHoldings(enabled: boolean) {
  return useFetch<HoldingsResult | null>(enabled ? "/api/holdings" : null, null, {
    refreshIntervalMs: 120_000,
  });
}
