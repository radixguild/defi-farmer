/**
 * The fallback rules behind every data hook (lib/hooks/fetch-state.ts).
 *
 * The bug this exists for: a signed-out visitor to the home page saw "Your
 * positions: 4" with real-looking amounts and P&L. /api/positions answered 401,
 * and the shared fetch hook treated that like an unreachable API and filled
 * the gap with sample positions. Account reads now have no sample fallback at
 * all; only public market data keeps one.
 */

import { describe, expect, test } from "bun:test";
import { HttpError, resolveFetchState } from "../lib/hooks/fetch-state";

const MOCK = [{ id: 1, sample: true }];
const REAL = [{ id: 42, sample: false }];
const ACCOUNT = "account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy";

function account(over: Partial<Parameters<typeof resolveFetchState<typeof MOCK>>[0]>) {
  return resolveFetchState({
    scope: "account",
    mocksForced: false,
    account: ACCOUNT,
    data: undefined,
    error: undefined,
    mockData: MOCK,
    ...over,
  });
}

function pub(over: Partial<Parameters<typeof resolveFetchState<typeof MOCK>>[0]>) {
  return resolveFetchState({
    scope: "public",
    mocksForced: false,
    data: undefined,
    error: undefined,
    mockData: MOCK,
    ...over,
  });
}

describe("account reads never fall back to sample data", () => {
  test("signed out: no data, no request needed", () => {
    expect(account({ account: null })).toEqual({ dataSource: "signed-out", data: null, error: null });
  });

  test("401 with nothing cached: signed-out, not samples", () => {
    const s = account({ error: new HttpError(401) });
    expect(s.dataSource).toBe("signed-out");
    expect(s.data).toBeNull();
  });

  test("401 after a successful read: the cached rows are dropped too", () => {
    const s = account({ error: new HttpError(401), data: REAL });
    expect(s.dataSource).toBe("signed-out");
    expect(s.data).toBeNull();
  });

  test.each([
    ["HTTP 403", new HttpError(403)],
    ["HTTP 500", new HttpError(500)],
    ["HTTP 502", new HttpError(502)],
    ["network", new TypeError("fetch failed")],
  ])("%s with nothing cached: unavailable, no data", (_label, error) => {
    const s = account({ error });
    expect(s.dataSource).toBe("unavailable");
    expect(s.data).toBeNull();
    expect(s.error).toContain("Unavailable");
  });

  test("a non-auth failure after a success keeps that same wallet's rows, marked stale", () => {
    // The SWR key is [url, account], so `data` here can only be this wallet's.
    const s = account({ error: new HttpError(502), data: REAL });
    expect(s.dataSource).toBe("stale-live");
    expect(s.data).toBe(REAL);
  });

  test("loading and live", () => {
    expect(account({}).dataSource).toBe("loading");
    expect(account({}).data).toBeNull();
    expect(account({ data: REAL })).toEqual({ dataSource: "live", data: REAL, error: null });
  });

  test("no combination of account-read inputs yields the sample rows, outside mock-forced", () => {
    const errors = [undefined, new HttpError(401), new HttpError(403), new HttpError(500), new TypeError("x")];
    for (const acct of [ACCOUNT, null]) {
      for (const data of [undefined, REAL]) {
        for (const error of errors) {
          const s = account({ account: acct, data, error });
          expect(s.data).not.toBe(MOCK);
          expect(s.dataSource).not.toBe("mock-degraded");
        }
      }
    }
  });

  test("NEXT_PUBLIC_USE_MOCKS=true still shows samples, labelled mock-forced (dev only)", () => {
    const s = account({ mocksForced: true, account: null });
    expect(s.dataSource).toBe("mock-forced");
    expect(s.data).toBe(MOCK);
  });
});

describe("public reads keep their behaviour", () => {
  test("unreachable with nothing cached: labelled samples", () => {
    const s = pub({ error: new HttpError(502) });
    expect(s.dataSource).toBe("mock-degraded");
    expect(s.data).toBe(MOCK);
    expect(s.error).toContain("HTTP 502");
  });

  test("failure after a success: stale-live", () => {
    const s = pub({ error: new TypeError("fetch failed"), data: REAL });
    expect(s.dataSource).toBe("stale-live");
    expect(s.data).toBe(REAL);
    expect(s.error).toContain("Network error");
  });

  test("loading, live and mock-forced", () => {
    expect(pub({}).dataSource).toBe("loading");
    expect(pub({ data: REAL }).dataSource).toBe("live");
    expect(pub({ mocksForced: true }).dataSource).toBe("mock-forced");
  });
});
