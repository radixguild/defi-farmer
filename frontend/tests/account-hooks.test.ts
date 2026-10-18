/**
 * Structural guard: every hook that reads a wallet's own rows goes through
 * useAccountFetch, and useAccountFetch keys its cache by the signed-in account.
 *
 * Why structural: the repo has no DOM test harness (see sign-flow-guard.test.ts),
 * and the failure this guards against is a one-word regression. Swap
 * useAccountFetch back to useFetch in any of these hooks and a signed-out
 * visitor sees sample positions again (or, after a wallet switch, the previous
 * wallet's cached rows). The fallback rules themselves are unit-tested in
 * fetch-state.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "..", "lib", "hooks");
const read = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");

/** Hook file → the session-tier endpoint it reads. */
const ACCOUNT_HOOKS: Record<string, string> = {
  "use-positions.ts": "/api/positions",
  "use-holdings.ts": "/api/holdings",
  "use-stake-claims.ts": "/api/holdings/claims",
  "use-rotation-pending.ts": "/api/rotation/pending",
};

describe("account-scoped hooks", () => {
  for (const [file, endpoint] of Object.entries(ACCOUNT_HOOKS)) {
    test(`${file} reads ${endpoint} through useAccountFetch, never useFetch`, () => {
      const src = readFileSync(join(HOOKS, file), "utf8");
      expect(src.includes(endpoint)).toBe(true);
      expect(src).toMatch(/\buseAccountFetch\s*</);
      expect(src).not.toMatch(/\buseFetch\s*[<(]/);
    });
  }

  test("useAccountFetch keys by the signed-in account and never keeps another key's data", () => {
    const src = readFileSync(join(HOOKS, "use-fetch.ts"), "utf8");
    const body = src.slice(src.indexOf("export function useAccountFetch"));
    expect(body.length).toBeGreaterThan(0);
    // No account → no key → no request.
    expect(body).toMatch(/!authAddress\s*\?\s*null\s*:\s*\(\[url,\s*authAddress\]/);
    expect(body).toMatch(/keepPreviousData:\s*false/);
    expect(body).toMatch(/scope:\s*"account"/);
  });

  test("the home page renders the portfolio from the hook's state, not behind `connected`", () => {
    const page = read("app", "page.tsx");
    // The old gate showed sample positions to any connected-but-signed-out wallet.
    expect(page).not.toMatch(/connected\s*&&\s*<PortfolioSection/);
    expect(page).toContain("Sign in with your Radix Wallet to see your positions");
    expect(page).toMatch(/source=\{posSource\}/);
  });

  test("the positions page prompts for sign-in when the read says signed-out", () => {
    const page = read("app", "positions", "page.tsx");
    expect(page).toMatch(/posSource === "signed-out"/);
    expect(page).toMatch(/posSource === "unavailable"/);
  });
});
