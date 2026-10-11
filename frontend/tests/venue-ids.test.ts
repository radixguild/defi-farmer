/**
 * The venue ids in `lib/venues.ts` must equal the server's, because the server
 * matches them EXACTLY (`detectVenue()` is `===` on two of them).
 *
 * The failure mode this guards is quiet, which is why it is a test and not a
 * comment: a drifted id does not build a wrong manifest — `detectVenue` simply
 * fails to match, the request falls through to the LP pool resolver, and the
 * user gets a 400 from an Exit button that looked real. The same shape as the
 * dApp-definition drift guard next door.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_STAKING_ID, LSU_POOL_COMPONENT } from "@/lib/venues";

const REPO = join(import.meta.dir, "..", "..");

function serverConst(relPath: string, name: string): string {
  const src = readFileSync(join(REPO, relPath), "utf8");
  // `export const NAME =` then a single- or double-quoted string, possibly
  // wrapped onto the next line (the server files wrap the long addresses).
  const m = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*['"]([^'"]+)['"]`, "s").exec(src);
  if (!m) throw new Error(`could not find ${name} in ${relPath}`);
  return m[1];
}

describe("venue ids match the server", () => {
  test("NATIVE_STAKING_ID === staking.ts XRD_STAKING_ADDRESS", () => {
    expect(NATIVE_STAKING_ID).toBe(
      serverConst("server/src/services/staking.ts", "XRD_STAKING_ADDRESS"),
    );
  });

  test("LSU_POOL_COMPONENT === lsu-pool.ts LSU_POOL_COMPONENT", () => {
    expect(LSU_POOL_COMPONENT).toBe(
      serverConst("server/src/services/lsu-pool.ts", "LSU_POOL_COMPONENT"),
    );
  });

  test("the component id is a well-formed component address", () => {
    // Cheap sanity on the one that IS a real on-ledger address: the staking id
    // is deliberately synthetic and must NOT look like an address.
    expect(LSU_POOL_COMPONENT.startsWith("component_rdx1")).toBe(true);
    expect(NATIVE_STAKING_ID.includes("_rdx1")).toBe(false);
  });
});
