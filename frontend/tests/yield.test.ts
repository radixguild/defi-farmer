/**
 * Contract tests for `lib/yield.ts` — the single module every opportunity
 * surface (Discover, the home tile, the detail page) routes through for
 * `headlineApy` / `apyTone` / `profitable`.
 *
 * The module's own header explains why it exists: the server computed the
 * net-of-IL figure correctly while every frontend surface independently read
 * the GROSS `apy_7d_ma` and painted it profit-green. PR #29 (2026-08-02)
 * centralised the fix; nothing tested it until now. These tests exist so
 * that regression can't come back silently — flip the sign check in
 * `apyTone`/`profitable`, or swap which field `headlineApy`/`grossApy`
 * read, and a test below must fail.
 */

import { describe, expect, test } from "bun:test";
import {
  headlineApy,
  grossApy,
  impermanentLoss,
  isIlFree,
  isStablePair,
  apyTone,
  formatApy,
  formatTvl,
  ilRiskLabel,
  yieldKindLabel,
  sortOpportunities,
  profitable,
  SORT_LABELS,
  type SortOption,
} from "@/lib/yield";
import type { Opportunity } from "@/lib/types";

/** A fully-populated, internally-consistent Opportunity. Override per test. */
function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    pool_address: "component_rdx1cptest",
    protocol: "Ociswap",
    pool_name: "XRD/xUSDC",
    score: 50,
    apy_7d_ma: 10,
    net_apy_ma_7d: 5,
    estimated_il: -5,
    il_risk_score: 30,
    risk_adjusted_return: 4,
    tvl_usd: 100_000,
    is_stable: false,
    yield_kind: "amm-lp",
    computed_at: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

describe("headlineApy / grossApy — which field is THE number", () => {
  test("headlineApy reads net_apy_ma_7d, never apy_7d_ma", () => {
    const opp = makeOpportunity({ net_apy_ma_7d: -3, apy_7d_ma: 40 });
    expect(headlineApy(opp)).toBe(-3);
  });

  test("grossApy reads apy_7d_ma and is independent of the net figure", () => {
    const opp = makeOpportunity({ net_apy_ma_7d: -3, apy_7d_ma: 40 });
    expect(grossApy(opp)).toBe(40);
    expect(grossApy(opp)).not.toBe(headlineApy(opp));
  });
});

describe("apyTone — colour by sign only, and never trust an unchecked sign", () => {
  test("positive value -> profit tone", () => {
    expect(apyTone(0.01)).toBe("text-profit-green");
  });

  test("negative value -> loss tone", () => {
    expect(apyTone(-0.01)).toBe("text-loss-red");
  });

  test("exactly zero -> neutral, not profit (boundary)", () => {
    expect(apyTone(0)).toBe("text-muted-foreground");
  });

  test("NaN (a missing/unparseable net figure) -> neutral, never profit", () => {
    // net_apy_ma_7d is typed as `number`, but the API is JSON over HTTP — a
    // field that is dropped or fails to parse arrives as NaN/undefined at
    // runtime despite the type. `value > 0` and `value < 0` are both false
    // for NaN, so this falls through to the neutral branch. That fallthrough
    // — not a dedicated "missing data" tone — is the actual contract; assert
    // it rather than inventing a nicer one.
    expect(apyTone(NaN)).toBe("text-muted-foreground");
  });
});

describe("profitable — net-of-IL first, gross never painted profit-green", () => {
  test("net negative + gross positive is excluded (the bug PR #29 fixed)", () => {
    const loser = makeOpportunity({ net_apy_ma_7d: -2, apy_7d_ma: 25 });
    expect(profitable([loser])).toEqual([]);
  });

  test("net positive is included", () => {
    const winner = makeOpportunity({ net_apy_ma_7d: 2, apy_7d_ma: 1 });
    expect(profitable([winner])).toEqual([winner]);
  });

  test("net exactly zero is excluded (boundary: > not >=)", () => {
    const breakEven = makeOpportunity({ net_apy_ma_7d: 0, apy_7d_ma: 10 });
    expect(profitable([breakEven])).toEqual([]);
  });

  test("missing net (NaN) is excluded, not treated as profitable", () => {
    const missingNet = makeOpportunity({ net_apy_ma_7d: NaN, apy_7d_ma: 50 });
    expect(profitable([missingNet])).toEqual([]);
  });

  test("mixed list keeps only the net-positive ones", () => {
    const winner = makeOpportunity({ pool_address: "a", net_apy_ma_7d: 3 });
    const loser = makeOpportunity({
      pool_address: "b",
      net_apy_ma_7d: -1,
      apy_7d_ma: 99,
    });
    expect(profitable([winner, loser]).map((o) => o.pool_address)).toEqual(["a"]);
  });
});

describe("impermanentLoss", () => {
  test("reads estimated_il", () => {
    expect(impermanentLoss(makeOpportunity({ estimated_il: -7.5 }))).toBe(-7.5);
  });
});

describe("isIlFree", () => {
  test("staking is IL-free", () => {
    expect(isIlFree(makeOpportunity({ yield_kind: "staking" }))).toBe(true);
  });

  test("lending is IL-free", () => {
    expect(isIlFree(makeOpportunity({ yield_kind: "lending" }))).toBe(true);
  });

  test("amm-lp is not IL-free", () => {
    expect(isIlFree(makeOpportunity({ yield_kind: "amm-lp" }))).toBe(false);
  });

  test("undefined yield_kind is not treated as IL-free", () => {
    expect(isIlFree(makeOpportunity({ yield_kind: undefined }))).toBe(false);
  });
});

describe("isStablePair — SQLite 0/1 coerced to a real boolean", () => {
  test("integer 1 (as the API actually sends it) coerces to true", () => {
    const opp = makeOpportunity({ is_stable: 1 as unknown as boolean });
    expect(isStablePair(opp)).toBe(true);
  });

  test("integer 0 coerces to false, not the truthy string '0'", () => {
    const opp = makeOpportunity({ is_stable: 0 as unknown as boolean });
    expect(isStablePair(opp)).toBe(false);
  });
});

describe("sortOpportunities", () => {
  test("net-yield ranks by headlineApy (net), not gross", () => {
    // Gross ranking would put `highGrossLowNet` first; net ranking must not.
    const highGrossLowNet = makeOpportunity({
      pool_address: "hg",
      net_apy_ma_7d: -1,
      apy_7d_ma: 90,
    });
    const lowGrossHighNet = makeOpportunity({
      pool_address: "lg",
      net_apy_ma_7d: 3,
      apy_7d_ma: 4,
    });
    const sorted = sortOpportunities([highGrossLowNet, lowGrossHighNet], "net-yield");
    expect(sorted.map((o) => o.pool_address)).toEqual(["lg", "hg"]);
  });

  test("risk-adjusted ranks by risk_adjusted_return descending", () => {
    const a = makeOpportunity({ pool_address: "a", risk_adjusted_return: 1 });
    const b = makeOpportunity({ pool_address: "b", risk_adjusted_return: 9 });
    expect(sortOpportunities([a, b], "risk-adjusted").map((o) => o.pool_address)).toEqual([
      "b",
      "a",
    ]);
  });

  test("il-risk ranks by il_risk_score ascending (lowest risk first)", () => {
    const risky = makeOpportunity({ pool_address: "risky", il_risk_score: 80 });
    const safe = makeOpportunity({ pool_address: "safe", il_risk_score: 10 });
    expect(sortOpportunities([risky, safe], "il-risk").map((o) => o.pool_address)).toEqual([
      "safe",
      "risky",
    ]);
  });

  test("tvl ranks by tvl_usd descending (largest pool first)", () => {
    const small = makeOpportunity({ pool_address: "small", tvl_usd: 1_000 });
    const big = makeOpportunity({ pool_address: "big", tvl_usd: 5_000_000 });
    expect(sortOpportunities([small, big], "tvl").map((o) => o.pool_address)).toEqual([
      "big",
      "small",
    ]);
  });

  test("does not mutate the input array", () => {
    const a = makeOpportunity({ pool_address: "a", tvl_usd: 1 });
    const b = makeOpportunity({ pool_address: "b", tvl_usd: 2 });
    const input = [a, b];
    sortOpportunities(input, "tvl");
    expect(input).toEqual([a, b]);
  });

  test("SORT_LABELS has a non-empty label for every SortOption", () => {
    const options: SortOption[] = ["risk-adjusted", "net-yield", "il-risk", "tvl"];
    for (const opt of options) {
      expect(typeof SORT_LABELS[opt]).toBe("string");
      expect(SORT_LABELS[opt].length).toBeGreaterThan(0);
    }
  });
});

describe("ilRiskLabel — boundaries on the 0-100 score", () => {
  test.each([
    [0, "Very low IL risk", "text-profit-green"],
    [20, "Very low IL risk", "text-profit-green"],
    [21, "Low IL risk", "text-profit-green"],
    [40, "Low IL risk", "text-profit-green"],
    [41, "Moderate IL risk", "text-risk-yellow"],
    [60, "Moderate IL risk", "text-risk-yellow"],
    [61, "High IL risk", "text-risk-orange"],
    [80, "High IL risk", "text-risk-orange"],
    [81, "Very high IL risk", "text-loss-red"],
    [100, "Very high IL risk", "text-loss-red"],
  ])("score %p -> %p / %p", (score, label, tone) => {
    expect(ilRiskLabel(score as number)).toEqual({
      label: label as string,
      tone: tone as string,
    });
  });
});

describe("yieldKindLabel", () => {
  test("staking", () => {
    expect(yieldKindLabel("staking")).toBe("Staking");
  });
  test("lending", () => {
    expect(yieldKindLabel("lending")).toBe("Lending");
  });
  test("amm-lp", () => {
    expect(yieldKindLabel("amm-lp")).toBe("LP pool");
  });
  test("undefined defaults to LP pool", () => {
    expect(yieldKindLabel(undefined)).toBe("LP pool");
  });
});

describe("formatApy", () => {
  test("positive value gets an explicit + sign", () => {
    expect(formatApy(5.4321)).toBe("+5.43%");
  });
  test("negative value keeps its native - sign, no double sign", () => {
    expect(formatApy(-5.4321)).toBe("-5.43%");
  });
  test("zero gets no + sign (boundary)", () => {
    expect(formatApy(0)).toBe("0.00%");
  });
});

describe("formatTvl", () => {
  test("compact-formats large TVL", () => {
    expect(formatTvl(1_234_567)).toBe("$1.2M");
  });
  test("compact-formats sub-million TVL", () => {
    expect(formatTvl(9_876)).toBe("$9.9K");
  });
  test("zero TVL", () => {
    expect(formatTvl(0)).toBe("$0");
  });
});
