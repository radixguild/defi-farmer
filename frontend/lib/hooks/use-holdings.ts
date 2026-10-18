"use client";

import type { HoldingsResult } from "@/lib/types";
import { useAccountFetch } from "./use-fetch";

/// What the LEDGER says the signed-in account holds, classified server-side
/// (GET /api/holdings, session tier — the proxy forwards the farmer_session
/// cookie). Distinct from usePositions, which only knows deposits recorded
/// through this app: pre-existing stake and LP show up HERE and nowhere else.
///
/// Account read (useAccountFetch): no request while signed out, and no mock
/// rows even in development mode. Holdings inform real decisions about real
/// balances; a sample account rendering under the user's own wallet header
/// would be worse than an empty state.
export function useHoldings() {
  return useAccountFetch<HoldingsResult | null>("/api/holdings", null, {
    refreshIntervalMs: 120_000,
  });
}
