/**
 * What a data hook shows, decided from the raw fetch result. Pure (no React,
 * no SWR) so the rules are unit-tested directly: tests/fetch-state.test.ts.
 *
 * Two scopes, two fallback policies:
 *
 *   public  — market data anyone may read (opportunities, validators, pool
 *             snapshots, agent status). An unreachable API falls back to
 *             labelled sample data ("mock-degraded") so the page is not blank.
 *   account — rows that belong to the signed-in wallet (positions, holdings,
 *             stake claims, rotation proposals). There is NO sample fallback:
 *             a signed-out visitor sees "signed-out", a failed read shows
 *             "unavailable", and neither carries any data. Sample rows under a
 *             wallet header read as that wallet's money.
 *
 * NEXT_PUBLIC_USE_MOCKS=true ("mock-forced") is the one exception for both
 * scopes. It is a development switch, labelled on screen, and it disables
 * every sign flow.
 */

export type DataSource =
  | "loading"
  | "live"
  /**
   * Last fetch failed but we still have a previously-successful response
   * from the same key cached. Numbers shown are real but not fresh — the
   * user must not commit funds against them. For an account read the key
   * includes the account, so this is always the same wallet's own data.
   */
  | "stale-live"
  /**
   * Public reads only: no prior successful response and the API is
   * unreachable. UI is showing local sample data so the page isn't blank.
   * Sign-flow gates MUST refuse.
   */
  | "mock-degraded"
  /** NEXT_PUBLIC_USE_MOCKS=true (dev/storybook only). */
  | "mock-forced"
  /**
   * Account reads only: there is no signed-in wallet, or the server answered
   * 401 (session expired or revoked). No data; the page asks for a sign-in.
   */
  | "signed-out"
  /**
   * Account reads only: the read failed for a reason other than auth and
   * there is nothing cached for this wallet. No data, never samples.
   */
  | "unavailable";

export type FetchScope = "public" | "account";

/** A non-2xx response. The status is kept so 401 can be told apart. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401;
}

// Sanitize HTTP error messages: include the numeric status (spec-defined,
// non-attacker-controlled in practice) but drop `statusText` (server-supplied
// and could be crafted to look reassuring — "200 Live data confirmed").
export function sanitizeFetchError(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  if (!(err instanceof Error)) return "Network error";
  const statusMatch = err.message.match(/^HTTP (\d{3})/);
  if (statusMatch) return `HTTP ${statusMatch[1]}`;
  return "Network error";
}

export interface FetchInputs<T> {
  scope: FetchScope;
  mocksForced: boolean;
  /**
   * Account scope only: the ROLA-verified account this read is keyed to, or
   * null when nobody is signed in. Ignored for public reads.
   */
  account?: string | null;
  /** SWR's data for the CURRENT key (undefined = nothing cached yet). */
  data: T | undefined;
  /** SWR's error for the current key, if the latest fetch failed. */
  error: unknown;
  /** Sample data: shown for public reads when degraded, and in mock-forced mode. */
  mockData: T;
}

export interface FetchState<T> {
  dataSource: DataSource;
  data: T | null;
  error: string | null;
}

export function resolveFetchState<T>(i: FetchInputs<T>): FetchState<T> {
  if (i.mocksForced) {
    return { dataSource: "mock-forced", data: i.mockData, error: null };
  }

  if (i.scope === "account") {
    if (!i.account) return { dataSource: "signed-out", data: null, error: null };
    if (i.error) {
      // The server no longer holds this session. Whatever was cached is not
      // shown again: the next person at this screen is not that wallet.
      if (isUnauthorized(i.error)) return { dataSource: "signed-out", data: null, error: null };
      if (i.data !== undefined) {
        return {
          dataSource: "stale-live",
          data: i.data,
          error: `Live data is stale — last fetch failed (${sanitizeFetchError(i.error)}).`,
        };
      }
      return {
        dataSource: "unavailable",
        data: null,
        error: `Unavailable right now (${sanitizeFetchError(i.error)}).`,
      };
    }
  } else if (i.error) {
    // Distinguish stale-live (we have prior success) from mock-degraded
    // (we never had a success). Both refuse sign-flow gates, but the user
    // copy is different.
    if (i.data !== undefined) {
      return {
        dataSource: "stale-live",
        data: i.data,
        error: `Live data is stale — last fetch failed (${sanitizeFetchError(i.error)}).`,
      };
    }
    return {
      dataSource: "mock-degraded",
      data: i.mockData,
      error: `API unreachable — showing sample data (${sanitizeFetchError(i.error)}).`,
    };
  }

  if (i.data === undefined) return { dataSource: "loading", data: null, error: null };
  return { dataSource: "live", data: i.data, error: null };
}
