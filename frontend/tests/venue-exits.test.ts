/**
 * Which holdings get an Exit button, and what request it builds.
 *
 * This is the decision that stands between a user and a signature, so the
 * interesting cases are the REFUSALS: a row that cannot produce a working exit
 * must produce no button at all. A disabled or broken button on a money action
 * is worse than an absent one, because it implies the app knows how to do
 * something it does not.
 */

import { describe, expect, test } from "bun:test";
import {
  exitOptionsFor,
  claimRequestFor,
  NATIVE_STAKING_ID,
  LSU_POOL_COMPONENT,
} from "@/lib/venues";
import type { Holding } from "@/lib/types";
import type { StakeClaim } from "@/lib/api/dex";

const VALIDATOR = "validator_rdx1sv7zpyuj27ycmcsnw0de94j2rp93csq6gvcm4dl4yh4p4fxv9j5pqx";

function holding(over: Partial<Holding>): Holding {
  return {
    resource: "resource_rdx1t5" + "a".repeat(52),
    amount: "100",
    kind: "unknown",
    label: "Thing",
    detail: null,
    xrdValue: null,
    redemptionRate: null,
    ...over,
  };
}

describe("exitOptionsFor", () => {
  test("a validator LSU offers exactly one exit, and it is an unstake", () => {
    const opts = exitOptionsFor(
      holding({ kind: "validator-stake", detail: VALIDATOR, amount: "1234.5" }),
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].terminus).toBe("unbonding");
    expect(opts[0].request).toEqual({
      action: "withdraw",
      poolAddress: NATIVE_STAKING_ID,
      validator: VALIDATOR,
      lpAmount: "1234.5",
    });
  });

  test("the amount string is passed through untouched, never re-formatted", () => {
    // A float round-trip on an 18-dp Gateway decimal is how you spend a
    // different number than the one you displayed.
    const raw = "0.123456789012345678";
    const [opt] = exitOptionsFor(holding({ kind: "validator-stake", detail: VALIDATOR, amount: raw }));
    expect(opt.request.lpAmount).toBe(raw);
  });

  test("a validator LSU with no validator address offers nothing", () => {
    // detail is what resolves the LSU resource server-side. Without it the
    // build would 400, so the button must not exist.
    expect(exitOptionsFor(holding({ kind: "validator-stake", detail: null }))).toEqual([]);
    expect(
      exitOptionsFor(holding({ kind: "validator-stake", detail: "component_rdx1nope" })),
    ).toEqual([]);
  });

  test("LSULP offers both termini, and they differ in where the user lands", () => {
    const opts = exitOptionsFor(holding({ kind: "lsulp", amount: "50" }));
    expect(opts).toHaveLength(2);

    const instant = opts.find((o) => o.terminus === "immediate")!;
    const unbond = opts.find((o) => o.terminus === "unbonding")!;
    expect(instant.request).toMatchObject({ exitTo: "lsu", poolAddress: LSU_POOL_COMPONENT });
    expect(unbond.request).toMatchObject({ exitTo: "xrd", poolAddress: LSU_POOL_COMPONENT });

    // The instant one must NOT claim the user gets XRD — they get an LSU and
    // are still staked. That distinction is the whole point of offering both.
    expect(instant.outcome).toContain("LSU");
    expect(unbond.outcome).toMatch(/7 days|second signature/);
  });

  test("every unbonding exit says so in its outcome copy", () => {
    // The Gateway dry-run previews an unstake as a success and cannot express
    // "you now hold a receipt, not money" — the copy is the only warning.
    const all = [
      ...exitOptionsFor(holding({ kind: "validator-stake", detail: VALIDATOR })),
      ...exitOptionsFor(holding({ kind: "lsulp" })),
    ];
    for (const o of all.filter((x) => x.terminus === "unbonding")) {
      expect(o.outcome, o.label).toMatch(/Stake Claim NFT/);
      expect(o.outcome, o.label).toMatch(/second signature/);
    }
  });

  test("a Weft deposit unit withdraws instantly, with no unbonding claim", () => {
    const opts = exitOptionsFor(
      holding({ kind: "weft-lending", detail: `weft-v2:${"resource_rdx1tkn" + "x".repeat(48)}`, amount: "7.5" }),
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].terminus).toBe("immediate");
    expect(opts[0].request.lpAmount).toBe("7.5");
    // Lending has no unbonding period; promising one would be as wrong as
    // hiding one on an unstake.
    expect(opts[0].outcome).not.toMatch(/Stake Claim|7 days/);
  });

  test("a Weft row whose venue id did not resolve offers nothing", () => {
    // The classifier is fail-open: an unresolved deposit unit leaves detail
    // unset, and a poolAddress-less request would 400 from a real-looking button.
    expect(exitOptionsFor(holding({ kind: "weft-lending", detail: null }))).toEqual([]);
    expect(exitOptionsFor(holding({ kind: "weft-lending", detail: "component_rdx1nope" }))).toEqual([]);
  });

  test("rows with no single-sided exit offer nothing", () => {
    for (const kind of ["xrd", "pool-lp", "unknown"] as const) {
      expect(exitOptionsFor(holding({ kind })), kind).toEqual([]);
    }
  });

  test("a zero or unparseable balance offers nothing", () => {
    for (const amount of ["0", "0.0", "", "not-a-number"]) {
      expect(
        exitOptionsFor(holding({ kind: "validator-stake", detail: VALIDATOR, amount })),
        amount,
      ).toEqual([]);
    }
  });
});

describe("claimRequestFor", () => {
  test("spends the claim by its local id at its own validator", () => {
    const claim: StakeClaim = {
      validator: VALIDATOR,
      claimNftResource: "resource_rdx1ng" + "b".repeat(52),
      localId: "#42#",
      claimEpoch: 336613,
      claimAmountXrd: "4213.5",
      currentEpoch: 335801,
      epochsRemaining: 812,
      ready: false,
      readyAtEstimate: "2026-08-26T00:00:00Z",
    };
    expect(claimRequestFor(claim)).toEqual({
      action: "claim",
      poolAddress: NATIVE_STAKING_ID,
      validator: VALIDATOR,
      localId: "#42#",
    });
  });
});
