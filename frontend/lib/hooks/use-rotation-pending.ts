"use client";

import { RotationEntry } from "@/lib/types";
import { mockRotationPending } from "@/lib/mocks";
import { useAccountFetch } from "./use-fetch";

// Pending rotation proposals for the signed-in wallet (session tier; the
// server returns only rows that carry the session's account). Account read:
// no sample fallback. 30s polling so state changes propagate.
export function useRotationPending() {
  return useAccountFetch<RotationEntry[]>("/api/rotation/pending", mockRotationPending, {
    refreshIntervalMs: 30_000,
  });
}
