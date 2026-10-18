"use client";

import { Position } from "@/lib/types";
import { mockPositions } from "@/lib/mocks";
import { useAccountFetch } from "./use-fetch";

// The signed-in wallet's own tracked positions (session tier). Account read:
// no sample fallback, nothing at all while signed out (see useAccountFetch).
// Position current_value_xrd updates as fees + rewards accrue. 30s feels
// like a CEX-style refresh without hammering the backend.
export function usePositions() {
  return useAccountFetch<Position[]>("/api/positions", mockPositions, {
    refreshIntervalMs: 30_000,
  });
}

export function usePosition(id: number) {
  return useAccountFetch<Position>(
    `/api/positions/${id}`,
    mockPositions.find((p) => p.id === id) ?? mockPositions[0],
    { refreshIntervalMs: 30_000 },
  );
}
