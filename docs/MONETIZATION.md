# Monetization + profitability — build spec

Non-custodial throughout: every fee rides inside a manifest the user personally signs;
principal never touches the platform. Derived from a code-grounded strategy study.

## Thesis

Monetize the **automation and the scoring engine, not the swap skim.** The fee surface is
replicable and (since the user signs in their own wallet) strippable — so the moat is the
**profitability engine below**, not the fee. Build the engine first; monetization only has
something to attach to if staying inside the tool is demonstrably worth it.

## Revenue streams (sequenced by trust, not size)

| Stream | Mechanism | Rate | Phase |
|---|---|---|---|
| **B — aggregator rev-share** | route swaps via Astrolescent/CaviarNine, take partner share | Astrolescent shares 30% of its fee | ship first (no user-trust ramp) |
| **C — manifest routing fee** | fee bucket spliced into the user-signed deposit/harvest manifest → treasury component | **0.15%** on deposit; **~10% of reward tokens only** on harvest (success-linked) | after trust ramp |
| **A — premium automation sub** | off-chain payment for agent-built harvest/rebalance manifests + alerts + advanced analytics | **$20–30/mo** | the real lever (out-earns C ~10–30×) |

Do NOT build: management/performance fees (no AUM), a token/points program, or an on-chain
royalty component (reintroduces the surface the pivot deleted; still strippable).

## Fee mechanism (wire into the manifest builders)

Splice the fee **before** the final `deposit_batch ENTIRE_WORKTOP` sweep (order is load-bearing —
after the sweep, the sweep returns the fee to the user):

```
… withdraw <amountInclFee> …
TAKE_FROM_WORKTOP Address("<token>") Decimal("<feeAmount>") Bucket("fee_bucket");
CALL_METHOD Address("<treasury_component>") "try_deposit_or_abort" Bucket("fee_bucket") Enum<0u8>();
TAKE_ALL_FROM_WORKTOP Address("<token>") Bucket("deposit_bucket");
CALL_METHOD Address("<pool>") "add_liquidity" Bucket("deposit_bucket") … ;
CALL_METHOD Address("<account>") "deposit_batch" Expression("ENTIRE_WORKTOP");
```
Rules: deposit to a treasury **component** (not a bare account) via `try_deposit_or_abort`;
`feeAmount` must pass the existing `validateAmount` guard (≤18 dp); make `feeRate`/`feeComponent`
per-integrator params (B2B later); the Gateway preview already shows the treasury outflow — name
it an explicit "Platform fee: X" line so it never reads as an exploit. Harvest lane: take the fee
slice from the **reward token only** after `claim_fees`/harvest.

## Profitability engine (ranked value × feasibility) — THE moat

**The core bug:** `calculators.ts` already computes `netApy` (net-of-IL) + `riskAdjustedReturn`,
but `scorer.ts:70` and `allocator.ts` rank/size on **gross** `apyMa7d` — nothing consumes the net
math. So a 40%-gross pool bleeding 25% IL outranks a safe 15% pool. Fixing this wiring is the whole
profitability thesis.

- **#0 (prereq)** Fix scanner registry mislabels (blueprint resolver — already in flight). IL/risk
  math keys off token identity; garbage-in otherwise.
- **#1** Score + allocate on **net-of-IL, risk-adjusted APY** (mostly wiring `calculators.ts` →
  `scorer.ts`/`allocator.ts`; also replace the Kelly `confidence = score/maxScore` proxy with the
  risk-adjusted return so Kelly `p` is meaningful). `netApy = grossApy + estimatedIl` (IL negative).
- **#2** Per-token **realized-vol + correlation** feed (`il_bps` is hardcoded `0` in
  `data-tracker.ts:235`). From Ociswap price history: annualized vol = `dailyStdev·√365`; correlation
  from paired daily returns. Unblocks IL for ranking + risk simultaneously.
- **#3** **Concentrated-liquidity range optimizer** (strongest "earn more" feature): choose a
  tick/bin range maximizing **feeAPR(width)·P(in-range | vol, horizon) − E[IL(width)]**. Ties into the
  concentrated math (Ociswap ticks / CaviarNine bins).
  Concentrated IL over [r_lo, r_hi], entry=1: `V(p) = (2√p − p·√r_lo − 1/√r_hi)/(2 − √r_lo − 1/√r_hi)`,
  `IL_conc = V(p)/H(p) − 1`; out of range → IL frozen at boundary AND fees=0, weight by P(in-range).
- **#4** **Blueprint-dispatched IL model** (pure fns): replace the single 50/50 formula
  (`calculators.ts:103`) with dispatch on blueprint. WeightedPool non-50/50:
  `IL = r^w/(w·r + (1−w)) − 1` (the existing `2√r/(1+r)−1` is the `w=0.5` case). DefiPlaza single-sided
  = constant-product approx, flagged pending calibration.
- **#5** **Net-benefit rebalance/rotation gate**: `net = Δ(netAPY)·horizon − gas − swap/slippage −
  realizedIL`; act only if `net > 0` (re-ranging a concentrated position *realizes* pending IL).
- **#6/#7** (fast follow) out-of-range/APY-collapse/TVL-drain alerts (extend `checkExitGuards`);
  position-level PnL/tax CSV from recorded intents + Gateway `resource_changes`.

## Rollout

- **Phase 0** free + Stream B; land #0→#2 (the moat).
- **Phase 1** 0.15% routing toll (Stream C, transparent line-item); land #3→#5.
- **Phase 2** premium automation subscription (Stream A).

## Biggest threat

The fee surface is replicable and strippable — so if the engine (net-of-IL scoring, range
optimizer, preview-safety, tracking) isn't demonstrably better than hand-rolling or a DEX's native
UI, the fees evaporate. The moat is the engine, not the fee.
