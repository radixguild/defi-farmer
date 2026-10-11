"use client";

import { PoolSnapshot } from "@/lib/types";
import { mockSnapshotsMap } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

const defaultSnapshots: PoolSnapshot[] = Object.values(mockSnapshotsMap)[0] ?? [];

export function useSnapshots(address: string) {
  const mock = mockSnapshotsMap[address] ?? defaultSnapshots;
  return useFetch<PoolSnapshot[]>(`/api/snapshots/${address}`, mock);
}
