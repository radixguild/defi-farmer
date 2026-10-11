"use client";

import type { StakeClaimsResult } from "@/lib/api/dex";
import { useFetch } from "./use-fetch";

/// The signed-in account's Stake Claim NFTs — the unbonding queue
/// (GET /api/holdings/claims, session tier).
///
/// No mock fallback, for the same reason as useHoldings and with sharper teeth:
/// a claim is spent by NFT local id, so a sample row would offer a Claim button
/// bound to an id the account does not own. mock-degraded renders as nothing.
///
/// Refreshed on the holdings cadence. Readiness is epoch-driven (~300 s each),
/// so nothing here changes faster than that, and the server refuses an early
/// claim regardless of what a stale row says.
export function useStakeClaims(enabled: boolean) {
  return useFetch<StakeClaimsResult | null>(enabled ? "/api/holdings/claims" : null, null, {
    refreshIntervalMs: 120_000,
  });
}
