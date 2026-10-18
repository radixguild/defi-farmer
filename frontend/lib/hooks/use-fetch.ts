"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { useWallet } from "./use-wallet";
import { HttpError, isUnauthorized, resolveFetchState, type DataSource } from "./fetch-state";

export type { DataSource } from "./fetch-state";

export interface UseFetchResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  /**
   * Where the data in `data` came from on the latest tick. Sign / write
   * actions MUST require `dataSource === "live"`. Any other value means
   * the user might be acting on mock or stale numbers, or on nothing.
   */
  dataSource: DataSource;
  /** Imperatively replace the cached data — used for optimistic updates. */
  mutate: (next: T) => Promise<T | undefined>;
}

const useMocksForced =
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_USE_MOCKS === "true";

async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    // Status only — fetch-state's sanitizeFetchError never echoes statusText.
    throw new HttpError(res.status);
  }
  return (await res.json()) as T;
}

/** Account reads are keyed [url, account]; the server reads the cookie, not the key. */
function accountFetcher<T>([url]: readonly [string, string]): Promise<T> {
  return jsonFetcher<T>(url);
}

export interface UseFetchOptions {
  /** Auto-refetch interval in ms. Set to 0 (default) to disable polling. */
  refreshIntervalMs?: number;
}

/**
 * A PUBLIC read: market data anyone may see. Falls back to labelled sample
 * data when the API is unreachable. Never use this for rows that belong to a
 * wallet; that is useAccountFetch.
 */
export function useFetch<T>(
  /** null disables the fetch entirely. dataSource reports "loading"; no request is made. */
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

  const state = resolveFetchState({ scope: "public", mocksForced: useMocksForced, data, error, mockData });
  return {
    ...state,
    isLoading: isLoading && !data,
    refetch: () => {
      void mutate();
    },
    mutate: async (next: T) => mutate(next, { revalidate: false }),
  };
}

/**
 * An ACCOUNT read: rows that belong to the signed-in wallet. The server scopes
 * them to the session's ROLA-verified account; this hook makes sure the screen
 * does too.
 *
 * - No signed-in wallet: no request, `dataSource: "signed-out"`, no data.
 * - 401: the session is gone. `"signed-out"`, no data, and the client's copy
 *   of the session is dropped so the page asks for a fresh sign-in.
 * - Any other failure: `"unavailable"`, no data. Never sample rows: a sample
 *   portfolio under a wallet header reads as that wallet's money.
 * - The cache key includes the account and keepPreviousData is off, so one
 *   wallet's rows never stand in for another's while a fetch is in flight or
 *   after sign-out.
 *
 * `mockData` is used only when NEXT_PUBLIC_USE_MOCKS=true (development).
 */
export function useAccountFetch<T>(
  url: string,
  mockData: T,
  options: UseFetchOptions = {},
): UseFetchResult<T> {
  const { authAddress, signOut } = useWallet();
  const swrKey = useMocksForced || !authAddress ? null : ([url, authAddress] as const);

  const { data, error, isLoading, mutate } = useSWR<T>(swrKey, accountFetcher<T>, {
    refreshInterval: options.refreshIntervalMs ?? 0,
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    keepPreviousData: false,
  });

  const sessionGone = !useMocksForced && !!authAddress && isUnauthorized(error);
  useEffect(() => {
    if (sessionGone) void signOut();
  }, [sessionGone, signOut]);

  const state = resolveFetchState({
    scope: "account",
    mocksForced: useMocksForced,
    account: authAddress,
    data,
    error,
    mockData,
  });
  return {
    ...state,
    isLoading: isLoading && !data,
    refetch: () => {
      void mutate();
    },
    mutate: async (next: T) => mutate(next, { revalidate: false }),
  };
}
