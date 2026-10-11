/**
 * Structural guard on the positions sign flow.
 *
 * THE BUG THIS EXISTS FOR (found by adversarial review, 2026-08-23). The page
 * has several entry points into the same modal — exit a tracked position,
 * unstake a validator LSU, redeem LSULP, claim a matured NFT. `buildDex` is not
 * cancellable and the modal can be closed while a build is in flight, so two
 * flows could interleave: a slow response from an abandoned flow resolved into
 * a later flow's modal. The user saw "Unstake" in the title and signed a
 * tracked position's withdraw. Then `handleSign` branched on `exitingPositionId`
 * — already cleared by the second flow — took the venue path, and never
 * recorded the close, leaving a genuinely exited position `active` forever.
 *
 * The fix is a generation stamp in `startBuild()`. That only holds while
 * `startBuild` stays the single door: a new handler calling `buildDex` directly
 * would reintroduce the whole class, silently, and no type error would catch it.
 * This test is that door.
 *
 * It is deliberately structural rather than behavioural — the repo has no DOM
 * test harness, and adding one to assert a three-line ref counter would be a
 * worse trade than asserting the invariant that actually protects it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = join(import.meta.dir, "..", "app", "positions", "page.tsx");
const src = readFileSync(PAGE, "utf8");

describe("positions sign flow", () => {
  test("buildDex is called from exactly one place", () => {
    const calls = src.match(/\bbuildDex\s*\(/g) ?? [];
    expect(
      calls.length,
      "every sign flow must go through startBuild() so it gets a generation stamp — " +
        "see this file's header for what interleaving builds cost",
    ).toBe(1);
  });

  test("the single call site is inside startBuild", () => {
    const start = src.indexOf("function startBuild");
    expect(start, "startBuild() not found").toBeGreaterThan(-1);
    // The next function declaration after startBuild bounds its body well enough
    // for this check; buildDex must appear between them.
    const callAt = src.search(/\bbuildDex\s*\(/);
    expect(callAt).toBeGreaterThan(start);
  });

  test("the build response is gated on the generation stamp", () => {
    // Both .then and .catch must bail when superseded; a guarded .then with an
    // unguarded .catch would still let a stale error overwrite a live preview.
    const guards = src.match(/buildSeq\.current\s*!==\s*seq/g) ?? [];
    expect(guards.length, "both .then and .catch must check the stamp").toBeGreaterThanOrEqual(2);
  });

  test("closing the flow retires the in-flight build", () => {
    const close = src.slice(src.indexOf("handleCloseSignFlow"));
    expect(
      /buildSeq\.current\+\+/.test(close.slice(0, 500)),
      "handleCloseSignFlow must bump the stamp, or an abandoned build lands in the next modal",
    ).toBe(true);
  });

  test("ledger actions are not gated on the tracked-positions data source", () => {
    // Holdings and claims are independent fetches. Gating them on posSource told
    // a user looking at a real matured claim that the page was "showing samples".
    expect(src.includes("ledgerActionsDisabled")).toBe(true);
    const holdingsProps = src.slice(src.indexOf("<HoldingsSection"), src.indexOf("<HoldingsSection") + 400);
    expect(holdingsProps.includes("actionsDisabled={ledgerActionsDisabled}")).toBe(true);
  });
});
