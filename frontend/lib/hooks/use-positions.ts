"use client";

import { Position } from "@/lib/types";
import { mockPositions } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

// Position current_value_xrd updates as fees + rewards accrue. 30s feels
// like a CEX-style refresh without hammering the backend.
export function usePositions() {
  return useFetch<Position[]>("/api/positions", mockPositions, {
    refreshIntervalMs: 30_000,
  });
}

export function usePosition(id: number) {
  return useFetch<Position>(
    `/api/positions/${id}`,
    mockPositions.find((p) => p.id === id) ?? mockPositions[0],
    { refreshIntervalMs: 30_000 },
  );
}
