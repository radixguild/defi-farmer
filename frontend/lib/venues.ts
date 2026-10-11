/**
 * Single-sided venue exits, derived from a ledger holding.
 *
 * WHY THIS EXISTS. `POST /api/dex/build` has accepted `action:'withdraw'|'claim'`
 * for the three single-sided venues since #44, and `lib/api/dex.ts` has carried
 * the types for just as long — but nothing in the UI ever called them. A user
 * could enter native staking, LSULP or Weft from this app and then had to leave
 * it to get out. This module is the missing map from "a row the ledger reports"
 * to "the exit request that row needs".
 *
 * The server owns the venue identity; these ids mirror
 * `server/src/services/dex/venue-manifests.ts` `detectVenue()`, and
 * `frontend/tests/venue-ids.test.ts` reads the server source to fail CI if they
 * ever drift. A wrong id here does not build a wrong manifest — `detectVenue`
 * would simply not match and the request would fall through to the LP pool
 * resolver and 400 — but it would present an Exit button that cannot work.
 *
 * WEFT was absent until the classifier could identify it honestly. A `w2-XRD`
 * deposit unit carries no `validator`/`pool` metadata and its symbol is
 * forgeable, so it used to fall through to `kind:'unknown'`. Rather than match
 * a symbol — guessing a resource address for a money manifest is the class of
 * mistake the rest of this app refuses — `services/holdings.ts` now resolves
 * the unit from Weft's own component (the same chain the exit builder walks)
 * and sets `detail` to the `weft-v2:…` venue id, which is exactly what
 * `detectVenue()` matches on. That resolution is fail-open: if it cannot be
 * read the row stays `unknown` and simply offers no exit, never a wrong one.
 */

import type { DexBuildRequest, StakeClaim } from "@/lib/api/dex";
import type { Holding } from "@/lib/types";

/** Mirrors `staking.ts` XRD_STAKING_ADDRESS — a synthetic id, not an address. */
export const NATIVE_STAKING_ID = "native_xrd_staking";

/** Mirrors `lsu-pool.ts` LSU_POOL_COMPONENT — CaviarNine's LSU Pool. */
export const LSU_POOL_COMPONENT =
  "component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp";

/**
 * Where an exit actually lands. This is the thing the user needs to know BEFORE
 * signing, and the thing a Gateway dry-run cannot tell them: an unstake previews
 * perfectly and still leaves them holding a receipt instead of XRD.
 */
export type ExitTerminus =
  /** Spendable XRD lands in the account in this same transaction. */
  | "immediate"
  /** Returns a Stake Claim NFT; the XRD unlocks after ~7 days and a 2nd signature. */
  | "unbonding";

export interface ExitOption {
  label: string;
  /** One line, plain language, shown before the wallet opens. */
  outcome: string;
  terminus: ExitTerminus;
  request: Omit<DexBuildRequest, "account">;
}

/**
 * The exits available for a holding, or [] when this app cannot build one.
 *
 * Returning [] is a first-class answer, not a failure: most rows (plain XRD, an
 * LP position, anything unclassified) have no single-sided exit, and the caller
 * must render nothing rather than a disabled button that implies otherwise.
 */
export function exitOptionsFor(holding: Holding): ExitOption[] {
  const amount = holding.amount;
  if (!isPositiveAmount(amount)) return [];

  if (holding.kind === "validator-stake") {
    // detail is the validator address; without it the server cannot resolve the
    // LSU resource and would reject the build, so do not offer the action.
    if (!holding.detail?.startsWith("validator_")) return [];
    return [
      {
        label: "Unstake",
        outcome:
          "Returns a Stake Claim NFT, not XRD. The XRD unlocks after ~7 days and needs a second signature to claim.",
        terminus: "unbonding",
        request: {
          action: "withdraw",
          poolAddress: NATIVE_STAKING_ID,
          validator: holding.detail,
          lpAmount: amount,
        },
      },
    ];
  }

  if (holding.kind === "lsulp") {
    // Two genuinely different products, so both are offered rather than one
    // being chosen for the user: redeeming to LSU is instant but leaves them
    // staked, while going to XRD starts the same 7-day unbond as an unstake.
    return [
      {
        label: "Redeem to LSU",
        outcome:
          "Instant. You receive a validator LSU — still staked and still earning, just no longer in the pool.",
        terminus: "immediate",
        request: {
          action: "withdraw",
          poolAddress: LSU_POOL_COMPONENT,
          lpAmount: amount,
          exitTo: "lsu",
        },
      },
      {
        label: "Exit to XRD",
        outcome:
          "Redeems to an LSU and unstakes it in one transaction. Returns a Stake Claim NFT — the XRD unlocks after ~7 days and needs a second signature.",
        terminus: "unbonding",
        request: {
          action: "withdraw",
          poolAddress: LSU_POOL_COMPONENT,
          lpAmount: amount,
          exitTo: "xrd",
        },
      },
    ];
  }

  if (holding.kind === "weft-lending") {
    // detail is the `weft-v2:…` venue id the server's detectVenue() matches on.
    // Without it there is no poolAddress to send, so offer nothing.
    if (!holding.detail?.startsWith("weft-v2:")) return [];
    return [
      {
        label: "Withdraw",
        outcome:
          "Instant. Redeems your Weft deposit units back to XRD — lending has no unbonding period.",
        terminus: "immediate",
        request: {
          action: "withdraw",
          poolAddress: holding.detail,
          lpAmount: amount,
        },
      },
    ];
  }

  return [];
}

/** The claim request for a matured Stake Claim NFT. */
export function claimRequestFor(claim: StakeClaim): Omit<DexBuildRequest, "account"> {
  return {
    action: "claim",
    poolAddress: NATIVE_STAKING_ID,
    validator: claim.validator,
    localId: claim.localId,
  };
}

/**
 * Amounts arrive as raw Gateway decimal strings. parseFloat is fine for a
 * "is there anything here" gate and is NOT used for the amount that gets
 * spent — `request.lpAmount` carries the original string through untouched, so
 * no float artifact can reach a manifest.
 */
function isPositiveAmount(raw: string): boolean {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0;
}
