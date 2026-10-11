/**
 * The dApp definition address must be identical in all three in-repo places.
 *
 * WHY THIS TEST EXISTS. The wallet's verification is bidirectional — the origin's
 * /.well-known/radix.json names the dApp definition, and that account's on-chain
 * `claimed_websites` names the origin back. Separately,
 * server/src/services/rola.ts verifies every sign-in proof against
 * CONFIG.DAPP_DEFINITION_ADDRESS. So the failure mode of a partial rotation is
 * NOT cosmetic: if the frontend binds a proof to address A and the server
 * verifies it against address B, EVERY ROLA sign-in fails with
 * `rola: verification_failed`, and the app looks broken for reasons that have
 * nothing to do with the sign-in code.
 *
 * An earlier rotation checklist listed only four locations to change and
 * missed server/src/config.ts — precisely the one that breaks sign-in. This test
 * is the guard that makes such an omission fail CI instead of production.
 *
 * Change the address in all three files in the same commit so they cannot
 * drift (the operator's rotation script does exactly that).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const ACCOUNT = /account_rdx1[0-9a-z]{50,}/g;

function addressesIn(relPath: string): string[] {
  const text = readFileSync(join(REPO, relPath), "utf8");
  // Array.from, not spread: the frontend tsconfig targets below es2015.
  return Array.from(new Set(text.match(ACCOUNT) ?? []));
}

describe("dApp definition address consistency", () => {
  const wellKnown = addressesIn("frontend/public/.well-known/radix.json");
  const provider = addressesIn("frontend/lib/radix-provider.tsx");
  const serverCfg = addressesIn("server/src/config.ts");

  test("radix.json declares exactly one dApp definition", () => {
    expect(wellKnown).toHaveLength(1);
  });

  test("the frontend fallback matches radix.json", () => {
    // radix-provider.tsx is what RDT binds the ROLA proof to.
    expect(provider).toContain(wellKnown[0]);
  });

  test("the server fallback matches radix.json", () => {
    // rola.ts verifies against this. A mismatch fails every sign-in — this is
    // the location the manifest checklist forgot.
    expect(serverCfg).toContain(wellKnown[0]);
  });

  test("no in-repo file carries a second, stale dApp definition", () => {
    // Catches a half-applied rotation that left the old address behind
    // somewhere — the exact state a one-commit rotation exists to avoid.
    for (const [label, found] of [
      ["radix.json", wellKnown],
      ["radix-provider.tsx", provider],
      ["server/config.ts", serverCfg],
    ] as const) {
      expect(found, `${label} carries more than one account address`).toHaveLength(1);
    }
  });
});
