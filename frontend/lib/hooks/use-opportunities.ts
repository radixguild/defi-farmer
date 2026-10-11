"use client";

import { Opportunity } from "@/lib/types";
import { mockOpportunities } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

// Opportunity APYs and TVLs are recomputed at most every minute on the
// backend (per the agent loop's SCAN_INTERVAL_MS). Polling more aggressively
// would just hit the cache; less aggressively would feel stale.
export function useOpportunities(limit: number = 20) {
  return useFetch<Opportunity[]>(
    `/api/opportunities?n=${limit}`,
    mockOpportunities.slice(0, limit),
    { refreshIntervalMs: 60_000 },
  );
}
