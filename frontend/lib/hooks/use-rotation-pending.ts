"use client";

import { RotationEntry } from "@/lib/types";
import { mockRotationPending } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

// Pending rotations are awaiting operator approve/reject. 30s polling so
// state changes (other operator approved, agent auto-rejected) propagate.
export function useRotationPending() {
  return useFetch<RotationEntry[]>("/api/rotation/pending", mockRotationPending, {
    refreshIntervalMs: 30_000,
  });
}
