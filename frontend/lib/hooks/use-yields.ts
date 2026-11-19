"use client";

import type { YieldView } from "@/lib/types";
import { useFetch } from "./use-fetch";

/// No sample numbers: when the API is unreachable the page shows an empty view
/// under the data-source banner rather than invented yields.
const EMPTY_VIEW: YieldView = {
  generatedAt: null,
  banner: { xrdUsd: null, chainTvlUsd: null, chainTvlXrd: null, note: "", noteSource: "" },
  rules: [],
  assets: [],
  sections: { staking: [], feeApr: [], alr: [] },
  kickers: [],
  excluded: { belowFloorAssets: [], rowsBelowDepthFloor: 0, rowsDepthUnknown: 0, depthFloorXrd: null },
};

// The server refreshes at most every 15 minutes; polling faster only re-reads it.
export function useYields() {
  return useFetch<YieldView>("/api/yields", EMPTY_VIEW, { refreshIntervalMs: 5 * 60_000 });
}
