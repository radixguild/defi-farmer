"use client";

import type { ValidatorBoard } from "@/lib/types";
import { mockValidatorBoard } from "@/lib/mocks/validators";
import { useFetch } from "./use-fetch";

// The server refreshes the board at most twice a day (12h single-flight
// cache — ~32 Gateway calls per refresh). Polling faster than that only
// re-reads the cache; 15 minutes keeps a long-open tab from going stale
// without hammering anything.
export function useValidators() {
  return useFetch<ValidatorBoard>("/api/validators", mockValidatorBoard, {
    refreshIntervalMs: 15 * 60_000,
  });
}
