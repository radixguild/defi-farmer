/**
 * The √ Connect button and the server session must agree: connected with a
 * session for the shared account, or neither (lib/wallet-session.ts).
 *
 * The bug this exists for: after a sign-in, the app's own sidebar widget said
 * "Signed in as an account the wallet no longer shares" — the button and the
 * session had drifted apart and the UI showed a warning instead of ending it.
 * The custom widget is gone; every drift now signs out.
 *
 * Plus a structural guard on the wiring, since the repo has no DOM harness.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decideSession } from "../lib/wallet-session";

const A = "account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy";
const B = "account_rdx12x4zdjmz0rrxg9v6l8yq2m8h0kqzc9wpmqqjx5nznpdw6yqvsxkm4t";

describe("decideSession", () => {
  test("nothing is decided until both the server and the toolkit have reported", () => {
    expect(decideSession([], A, false)).toBe("keep");
    expect(decideSession([B], A, false)).toBe("keep");
    expect(decideSession([A], null, false)).toBe("keep");
  });

  test("connected with a session for the shared account: keep", () => {
    expect(decideSession([A], A, true)).toBe("keep");
  });

  test("neither connected nor signed in: keep", () => {
    expect(decideSession([], null, true)).toBe("keep");
  });

  test("disconnected in the button while a session exists: sign out", () => {
    expect(decideSession([], A, true)).toBe("sign-out");
  });

  test("the wallet stopped sharing the signed-in account: sign out, no warning state", () => {
    expect(decideSession([B], A, true)).toBe("sign-out");
  });

  test("connected (restored from storage) with no server session: sign out", () => {
    expect(decideSession([A], null, true)).toBe("sign-out");
  });
});

const FRONTEND = join(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}

describe("standard √ Connect button wiring", () => {
  const provider = readFileSync(join(FRONTEND, "lib", "radix-provider.tsx"), "utf8");

  test("exactly one <radix-connect-button> in the app (the toolkit wires only the first)", () => {
    const files = [...sourceFiles(join(FRONTEND, "app")), ...sourceFiles(join(FRONTEND, "components"))];
    const count = (re: RegExp) => files.flatMap((f) => readFileSync(f, "utf8").match(re) ?? []).length;
    // The element itself, inside the one wrapper component...
    expect(count(/<radix-connect-button\s*\/>/g)).toBe(1);
    // ...and that wrapper rendered once, in the layout.
    expect(count(/<ConnectWalletButton\b/g)).toBe(1);
    const layout = readFileSync(join(FRONTEND, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("<ConnectWalletButton />");
  });

  test("the custom sign-in widget is gone", () => {
    const files = [...sourceFiles(join(FRONTEND, "app")), ...sourceFiles(join(FRONTEND, "components")), ...sourceFiles(join(FRONTEND, "lib"))];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("SignInButton"), f).toBe(false);
      expect(src.includes("sessionMismatch"), f).toBe(false);
    }
  });

  test("connecting is the sign-in: one account with a ROLA proof, verified before the toolkit accepts it", () => {
    expect(provider).toMatch(/setRequestData\(\s*DataRequestBuilder\.accounts\(\)\.exactly\(1\)\.withProof\(\)/);
    expect(provider).toMatch(/provideChallengeGenerator/);
    const control = provider.slice(provider.indexOf("dataRequestControl("));
    expect(control.length).toBeGreaterThan(0);
    expect(control.slice(0, 900)).toContain("/api/auth/verify");
    expect(control.slice(0, 900)).toMatch(/throw new Error/);
    // No second, separate sign-in request alongside the button's own.
    expect(provider).not.toMatch(/sendOneTimeRequest/);
  });

  test("every drift signs out through decideSession, and sign-out disconnects the button", () => {
    expect(provider).toMatch(/decideSession\(/);
    const signOut = provider.slice(provider.indexOf("const signOut"), provider.indexOf("const reconcile"));
    expect(signOut).toContain("/api/auth/logout");
    expect(signOut).toMatch(/\.disconnect\(\)/);
  });
});
