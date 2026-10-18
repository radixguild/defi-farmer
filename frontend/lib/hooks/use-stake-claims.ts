"use client";

import type { StakeClaimsResult } from "@/lib/api/dex";
import { useAccountFetch } from "./use-fetch";

/// The signed-in account's Stake Claim NFTs — the unbonding queue
/// (GET /api/holdings/claims, session tier).
///
/// Account read with no mock rows, for the same reason as useHoldings and with
/// sharper teeth: a claim is spent by NFT local id, so a sample row would offer
/// a Claim button bound to an id the account does not own.
///
/// Refreshed on the holdings cadence. Readiness is epoch-driven (~300 s each),
/// so nothing here changes faster than that, and the server refuses an early
/// claim regardless of what a stale row says.
export function useStakeClaims() {
  return useAccountFetch<StakeClaimsResult | null>("/api/holdings/claims", null, {
    refreshIntervalMs: 120_000,
  });
}
