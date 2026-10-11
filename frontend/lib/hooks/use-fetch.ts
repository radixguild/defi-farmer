"use client";

import useSWR from "swr";

export type DataSource =
  | "loading"
  | "live"
  /**
   * Last fetch failed but we still have a previously-successful response
   * from the same URL cached. Numbers shown are real but not fresh — the
   * user must not commit funds against them.
   */
  | "stale-live"
  /**
   * No prior successful response and the API is unreachable. UI is showing
   * local sample data so the page isn't blank. Sign-flow gates MUST refuse.
   */
  | "mock-degraded"
  /** NEXT_PUBLIC_USE_MOCKS=true (dev/storybook only). */
  | "mock-forced";

export interface UseFetchResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  /**
   * Where the data in `data` came from on the latest tick. Sign / write
   * actions MUST require `dataSource === "live"`. Any other value means
   * the user might be acting on mock or stale numbers.
   */
  dataSource: DataSource;
  /** Imperatively replace the cached data — used for optimistic updates. */
  mutate: (next: T) => Promise<T | undefined>;
}

const useMocksForced =
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_USE_MOCKS === "true";

// Sanitize HTTP error messages: include the numeric status (spec-defined,
// non-attacker-controlled in practice) but drop `statusText` (server-supplied
// and could be crafted to look reassuring — "200 Live data confirmed").
function sanitizeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return "Network error";
  const msg = err.message;
  const statusMatch = msg.match(/^HTTP (\d{3})/);
  if (statusMatch) return `HTTP ${statusMatch[1]}`;
  return "Network error";
}

async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    // Throw with status only — let sanitizeFetchError pull the number out.
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface UseFetchOptions {
  /** Auto-refetch interval in ms. Set to 0 (default) to disable polling. */
  refreshIntervalMs?: number;
}

export function useFetch<T>(
  /** null disables the fetch entirely (conditional hooks — e.g. holdings
   *  before sign-in). dataSource reports "loading"; no request is made. */
  url: string | null,
  mockData: T,
  options: UseFetchOptions = {},
): UseFetchResult<T> {
  // Mock-forced short-circuit: never fire a network request, return samples.
  // Sign-flow gates check dataSource === "live" so this disables wallet writes.
  const swrKey = useMocksForced ? null : url;

  const { data, error, isLoading, mutate } = useSWR<T>(swrKey, jsonFetcher, {
    refreshInterval: options.refreshIntervalMs ?? 0,
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    keepPreviousData: true,
  });

  let dataSource: DataSource;
  let resolvedData: T | null;
  let resolvedError: string | null;

  if (useMocksForced) {
    dataSource = "mock-forced";
    resolvedData = mockData;
    resolvedError = null;
  } else if (error) {
    // Distinguish stale-live (we have prior success) from mock-degraded
    // (we never had a success). Both refuse sign-flow gates, but the user
    // copy is different and the user shouldn't be told "this is sample data"
    // when it's actually their real, last-known position.
    if (data !== undefined) {
      dataSource = "stale-live";
      resolvedData = data;
      resolvedError = `Live data is stale — last fetch failed (${sanitizeFetchError(error)}).`;
    } else {
      dataSource = "mock-degraded";
      resolvedData = mockData;
      resolvedError = `API unreachable — showing sample data (${sanitizeFetchError(error)}).`;
    }
  } else if (data === undefined) {
    dataSource = "loading";
    resolvedData = null;
    resolvedError = null;
  } else {
    dataSource = "live";
    resolvedData = data;
    resolvedError = null;
  }

  return {
    data: resolvedData,
    isLoading: isLoading && !data,
    error: resolvedError,
    refetch: () => {
      void mutate();
    },
    dataSource,
    mutate: async (next: T) => mutate(next, { revalidate: false }),
  };
}
