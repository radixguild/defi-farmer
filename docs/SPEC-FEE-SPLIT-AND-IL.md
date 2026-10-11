> **Provenance:** Drafted 2026-08-07 by an AI session without a shell (never typechecked, built, or run); landed 2026-08-13. Claims in this document were NOT re-verified at landing time — verify against live code before acting. Several claims from the same drafting sessions did not survive verification.

# Spec — #1 Fee-APR vs Emissions split · #2 Real IL / USD P&L

> Lean build notes (2026-07-24). Draft. Read-only/analytics layer —
> no on-chain, no vault dependency (safe to build now while the vault lane is blocked).
>
> **Key framing: the math already exists.** `server/src/services/calculators.ts` already has
> `calculateApr` (fees/liquidity × 365/period), `calculateApy`, `calculateImpermanentLoss`
> (`2√r/(1+r)−1`), `calculateIlRiskScore`, `computePoolYieldSummary`. **Both features are DATA
> PLUMBING, not new formulas** — feed real fee/volume/price data into the primitives that exist.
> Shared dependency: the **Astrolescent API** (liquidity-weighted USD prices + volume; ~10-min
> refresh).

---

## #1 — Fee-APR vs Emissions split

**Goal:** split each pool's APY into `apyBase` (organic fees) + `apyReward` (emissions), so the
scorer rewards *sustainable* yield. Fixes the current state: `ociswap.ts` reads a single blended
`apr['24h']` (`apySource:'live'`), and CaviarNine/DefiPlaza are `estimated`/`0` with no split.

**Data → formula (reuse `calculateApr`):**
`feeApr = calculateApr({ feesEarned: volumeUsd_period × feeTier, liquidityProvided: tvlUsd, periodDays })`
- `volumeUsd_period` — from Astrolescent (or the DEX's own stats); `feeTier` — per-pool constant
  from pool metadata; `tvlUsd` — you have `tvl` already, USD-convert via Astrolescent.
- `apyBase = feeApr` (optionally compounded via `calculateApy`); `apyReward = apy − apyBase`
  when a blended `apy` is known; `apy = apyBase + apyReward`.

**Where:**
- `gateway.ts` `PoolInfo` — add `apyBase?: number`, `apyReward?: number`, `feeApr?: number`, and
  extend `apySource` with `'blended'` (see honesty note).
- Each adapter (`ociswap.ts` / `caviarnine.ts` / `defiplaza.ts`) — populate the new fields from
  volume + feeTier + tvl. Keep `apy` = the total.
- `scorer.ts` — the lean scorer change: add ONE "yield quality" input = `apyBase / apy` (organic
  ratio; higher = more sustainable). Fold into the existing 40% APY weight (bias it toward
  `apyBase`), don't add a whole new top-level dimension.

**Per-DEX honesty (do NOT fabricate a split):**
- **Ociswap** — gives a live APR; verify whether their API exposes **volume** (needed for the
  split). If yes → real split. If only blended APY → mark `apySource:'blended'`, set `apy` only,
  leave base/reward `undefined`.
- **CaviarNine / DefiPlaza** — likely need volume from **on-chain swap-event aggregation via
  Gateway** (heavier) or Astrolescent. Start where data exists; for the rest emit
  `apySource:'blended'` and an honest "split unavailable" — better than a fake number feeding the
  scorer.

**Tests** (`server/tests/calculators.test.ts` + adapter tests): assert `apyBase + apyReward === apy`
when split is known; an emissions-only pool scores below a fee-heavy pool of equal APY;
`'blended'` pools don't get a fabricated base.

**Verify first** (from the landscape report): does Ociswap expose volume via Gateway or need its
own API? Does DefiLlama index any Radix pools (if so, borrow its `apyBase`/`apyReward` directly
instead of computing)?

---

## #2 — Real IL / USD P&L

**Goal:** put a real number behind the frontend's "price movement risk," and USD-denominate
position P&L (deposit vs fees vs IL) — fixes "IL out of scope" + "P&L XRD-only."

**Two surfaces, two uses of the existing math:**

**(a) Pool scanning — forward IL risk** (already partly there): `computePoolYieldSummary` +
`calculateIlRiskScore` exist but take price-change *params*. Feed them **real trailing price
ratios** from `data-tracker.ts` snapshots (or Astrolescent history) so the risk number reflects
this pool's actual recent divergence, not a guess.

**(b) Positions — realized/unrealized USD P&L** (new, small): add to `calculators.ts`:
```ts
computePositionPnL({ entryPrices, currentPrices, lpShare, feesEarnedUsd })
  → { depositValueUsd, currentValueUsd, ilUsd, feesUsd, netPnlUsd }
```
- IL leg reuses `calculateImpermanentLoss(entryRatio, currentRatio)`; `ilUsd = (lpValue − hodlValue)`.
- Requires **entry prices captured at position open** → add `entry_price_a/b` (or a priced
  snapshot) to the positions row in `db/schema.ts`; positions are already recorded via the
  Gateway-verified `POST /api/positions`, so capture prices there.
- Current prices + USD conversion: Astrolescent.

**Where:** `calculators.ts` (the new pure fn) → `api.ts` positions endpoint → the positions /
`opportunity/[address]` frontend surfaces (show deposit vs fees vs IL vs net, in USD).

**Tests:** `calculators.test.ts` for `computePositionPnL` (stable-pair → ~0 IL; 2× move → known
IL; fees offset IL); `positions.test.ts` for entry-price capture.

**CRITICAL honesty caveat — CL pools:** the `2√r/(1+r)−1` formula is for **full-range / 50-50
constant-product** pools ONLY. **CaviarNine Shape and Ociswap Precision are concentrated** — their
IL is different and range-dependent. **Do NOT apply the formula to CL positions.** For those, take
"current value" from the **`c9-shape-liquidity-getter`** redemption value (that's play #3) and
compute P&L from that, not the formula. So #2 is exact for constant-product pools; CL correctness
depends on #3. Gate the formula on pool type.

**Other caveats:** Astrolescent refresh ~10 min → P&L is near-real-time, not tick-exact (fine for a
farming agent). Verify Astrolescent covers both tokens of every scanned pool.

---

## Build order (lean, dependency-aware)
1. Astrolescent price/volume client (shared by both) — one small service, USD prices + volume.
2. **#1** fee split in the adapters + `PoolInfo` fields + the one scorer input (highest value: fixes the scorer).
3. **#2a** real trailing-price IL risk in scanning (small, reuses existing fns).
4. **#2b** `computePositionPnL` + entry-price capture + frontend P&L breakdown.
5. (Then #3 CL range awareness unlocks correct #2 for CaviarNine/Ociswap Precision.)

No new external infra beyond the Astrolescent client. All four steps reuse `calculators.ts`.
