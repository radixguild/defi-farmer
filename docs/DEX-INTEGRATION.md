# DEX Integration — verified real-component manifest spec

Source of truth for the non-custodial deposit/withdraw builders. Every interface
below was verified against **Radix mainnet** (Gateway `https://mainnet.radixdlt.com`)
on 2026-07-18 by reading real committed transactions — not from docs or assumptions.
The custom vault is being removed; these are the real third-party components users
sign manifests against. Funds never touch defi-farmer.

## The safety keystone: preview before sign

Every built manifest MUST be dry-run through the Gateway **before** it reaches the
user's wallet. This is what makes the deposit builder safe.

`POST https://mainnet.radixdlt.com/transaction/preview` — no signature, no key, no
submission, no state change:

```json
{
  "manifest": "<RTM string>",
  "start_epoch_inclusive": <epoch>,          // from POST /status/gateway-status
  "end_epoch_exclusive":   <epoch + 100>,    // NB: *exclusive* — "inclusive" is silently ignored → InvalidEpochRange
  "tip_percentage": 0,
  "nonce": 1,
  "signer_public_keys": [],
  "flags": { "use_free_credit": true, "assume_all_signature_proofs": true, "skip_epoch_check": false }
}
```

- `assume_all_signature_proofs: true` → previews any account's manifest without keys.
- Gate signing on `receipt.status == "Succeeded"` (else `"Failed"`/`"Rejected"` with `receipt.error_message`).
- `resource_changes` = the exact per-vault token movements → this becomes the preview
  the UI shows the user (replaces the old speculative `manifest-preview.ts` decoder).
- Also catches: wrong component address, reversed x/y bucket order, DefiPlaza shortage
  panic, mis-aligned ticks — before any signature.

## Do NOT trust the scanner registry — resolve blueprint per component at runtime

`server/src/services/caviarnine.ts` mislabels **3 of its 4 pools** (verified):

| Shows as | Actually is |
|---|---|
| XRD-xUSDC (CaviarNine) | XRD/**hSOL**, CaviarNine WeightedPool (wrong token) |
| XRD-xUSDT (CaviarNine) | ✅ CaviarNine QuantaSwap |
| XRD-xWBTC (CaviarNine) | **Ociswap** PrecisionPool (wrong protocol) |
| XRD-xETH  (CaviarNine) | **DefiPlaza** PlazaPair (wrong protocol) |

Fix the registry, and before building any manifest resolve the pool's real blueprint
via `POST /state/entity/details {addresses:[component], aggregation_level:"Global"}` →
`details.blueprint_name` (+ package). Dispatch on that, not on a static label. Pools
span multiple packages/generations (e.g. Ociswap Precision ships ≥2 packages).

**The package is part of the identity (DF-1, 2026-10-06).** Anyone can publish a package
with a blueprint named `PrecisionPool`, so `pool-resolver.ts` accepts a kind only when the
(blueprint, package) pair is pinned; any other package resolves as `unsupported` (never
ranked, never built). Pinned in code: Precision `…ca40ts8dt` and QuantaSwap `…762h383wa3`.
Every other package is pinned per box with `DEX_PACKAGES_<KIND>` (comma-separated; names in
`server/src/config.ts` `DEX_PACKAGE_ENV`) and must be recorded here when it is set.

**Mainnet-verified and set on the box (2026-10-06 UTC, after #73 deployed).**
Resolved from the farmer's OWN scanned pools (`pool_snapshots`: 502 ociswap / 3 caviarnine /
1 defiplaza) via Gateway `/state/entity/details` → `package_address`, then written as four
`DEX_PACKAGES_*` lines in `<deploy-root>/.env`:

| Env var | Blueprint | Package(s) | How verified |
|---|---|---|---|
| `DEX_PACKAGES_OCISWAP_BASIC` | Ociswap BasicPool | `package_rdx1p5l6dp3slnh9ycd7gk700czwlck9tujn0zpdnd0efw09n2zdnn0lzx` | 47/47 sampled BasicPools; live `/api/dex/pool-info` for `component_rdx1cp05j865…` → `kind: ociswap_basic` |
| `DEX_PACKAGES_OCISWAP_PRECISION` | Ociswap PrecisionPool | `package_rdx1pkl8tdw43xqx64etxwdf8rjtvptqurq4c3fky0kaj6vwa0zrkfmcmc`, `package_rdx1pkvrgxw9aqrrrrh9p0hpym8x3kmsm0gqfdqchdmxe9snar2vp2adf9`, `package_rdx1p4gww2e62cs53zyucza9qyxncpx0xsr5v45kpzhtm3vf35xsc6mmye` | the three further Precision packages seen in scanned pools (the fourth, `…ca40ts8dt`, is the code pin) |
| `DEX_PACKAGES_CAVIARNINE_WEIGHTED` | CaviarNine WeightedPool | `package_rdx1pkhxu8zy5t7h3rww6jsftca22e2jdgqpc28rje7lnmkjxxf50zagr7` | scanned CaviarNine pools |
| `DEX_PACKAGES_DEFIPLAZA_PAIR` | DefiPlaza PlazaPair | `package_rdx1p4dhfl7qwthqqu6p2267m5nedlqnzdvfxdl6q7h8g85dflx8n06p93` | the scanned DefiPlaza pool |

QuantaSwap `…762h383wa3` seen in the scan matches the code pin. **Deliberately NOT pinned**
(by design; they stay `unsupported`): Ociswap FlexPool
(`package_rdx1pkzxm6nw55wvz0e2fn79hd8t07834cxa8kpdlhq8s5lp5ldqpcglwe`), Ociswap `Pool`
(`package_rdx1phyk2tszvfhz2ukht6pkg3f3q3ww3fsuwku4uyyzctslpfp6dqksqq`) and CaviarNine
LsuPool (`package_rdx1pkfrtmv980h85c9nvhxa7c9y0z4vxzt25c3gdzywz5l52g5t0hdeey`). A box
without these env lines (a fresh deploy, a dev checkout) falls back to the two code pins.

## Verified interfaces (real mainnet txids cited)

Bucket order is always the pool's canonical `(x, y)`; preserve `ociswap.ts` x→tokenA / y→tokenB.
All manifests wrap: `withdraw`(_non_fungibles) → `TAKE…` → pool call →
`deposit_batch ENTIRE_WORKTOP` (sweeps LP + change back to the user).

**No manifest locks its own fee.** The dapp hands every manifest to the Radix Wallet
through RDT `sendTransaction`, and the wallet adds the `lock_fee` itself from the account
the user picks. Radix's "Conforming Manifest Types" doc says dApps do not need to add a fee
lock, that doing so will generally get the manifest stub rejected, and it lists an account
`lock_fee` call among the instructions that get a non-conforming stub rejected. This
repo's 2026-08-23 dApp-definition signing (Radix Dashboard, Send Raw Transaction, which
also hands the manifest to the wallet) hit that rejection. The preview needs no lock
either, because it runs with `use_free_credit: true`. `BuildOpts.lockFee` still emits one
on request, for a manifest that never goes through the wallet (a notarised CLI submit),
but nothing in the app sets it. One helper applies this rule to every builder:
`optionalLockFee` in `server/src/services/dex/rtm.ts`. Fee-less builds previewed
`Succeeded` on mainnet on 2026-10-08 (keyless, through `buildAndPreview`): native stake,
Weft supply, LSULP, DefiPlaza, QuantaSwap and Precision deposits.

### Simple / fungible-LP pools — amount(s) in, fungible LP out

| Blueprint | add_liquidity | remove_liquidity | LP token | Verified txid (add / remove) |
|---|---|---|---|---|
| **Ociswap BasicPool** v1 | `(x: Bucket, y: Bucket)` | `(lp: Bucket)` → (x,y) | **Fungible** | `txid_rdx1mc9440…` / `txid_rdx15gytr9…` |
| **CaviarNine WeightedPool** (wraps native TwoResourcePool) | `(x: Bucket, y: Bucket)` | `(lp: Bucket)` → (x,y) | **Fungible** | `txid_rdx1dvax6f…` / `txid_rdx1z3dsyj…` |
| **DefiPlaza PlazaPair** (single-sided) | via **PlazaDex router**: `(input: Bucket, co: Option<Bucket>, base_token: Option<ResourceAddress>)`; direct: `(input: Bucket, co: Option<Bucket>)` | router: `(lp: Bucket)`; direct: `(lp: Bucket, is_quote: bool)` → (base,quote) | **Fungible** (separate base-LP / quote-LP per side) | add `txid_rdx1vt0xmx…`, remove `txid_rdx1sq0pgr…` |

DefiPlaza rules (money-wrong if ignored): (1) single-sided add is **preview-conditional**
— reading `pair.state.shortage` is NOT sufficient. Verified live: a quote-side (XRD) add
to the xETH/XRD pair with `state.shortage == Equilibrium` and `None` co-liquidity STILL
panicked `pair.rs:290 "In shortage: requires counter liquidity"`. So the deposit endpoint
must be preview-driven: try `None`; if the preview fails with that panic, the flow requires
`Some(co_liquidity)` and the UI must collect the other token (co-amount computable from
`target_ratio`/`p0`). The preview is the oracle, not the shortage flag. (2) Router `base_token` must be `Some(pair base resource)` when
depositing the quote token (DFP2); always passing `Some(base)` is safe. Router path is
what the audited DefiPlaza front-end uses. `Option` encoding: `None = Enum<0u8>()`,
`Some(bkt) = Enum<1u8>(Bucket("..."))`.

### Concentrated / NFT-receipt pools — need a price range, mint an NFT position

| Blueprint | add_liquidity | remove_liquidity | LP receipt | Verified txid |
|---|---|---|---|---|
| **Ociswap PrecisionPool** v2 | `(left_tick: i32, right_tick: i32, x: Bucket, y: Bucket)` | `(lp_nft: Bucket)` → (x,y); also `claim_fees(lp_nft)` | **NFT** | add `txid_rdx1p8ypfk…`, remove `txid_rdx13na9ca…` |
| **CaviarNine QuantaSwap** (bins) | `(x: Bucket, y: Bucket, positions: Array<Tuple(bin: u32, amount_x: Decimal, amount_y: Decimal)>)` | `(lp_nft: Bucket)` → (x,y) | **NFT** | add `txid_rdx14q70wy…`, remove `txid_rdx1sad922…` |

Ticks (`i32`, `left < right`) must align to the component's `tick_spacing`; bins to
`bin_span`. Bins/ticks above the active price hold token_x, below hold token_y, the
active one holds both — so a UI range selection has to compute the per-bin split. This
is the extra work vs. simple pools.

### Not verified (resolve + preview before ever routing a user here)
- **Ociswap FlexPool** v1 (`package_rdx1pkzxm6nw55wvz…`) and a `Pool` blueprint — live but interface unconfirmed.
- Always re-preview; treat an unknown `blueprint_name` as unsupported (build no manifest).

## Single-sided venues — deposit AND exit (verified 2026-08-11 / 2026-08-13)

Native staking, Weft V2 lending and CaviarNine LSULP are not AMM pools and never reach
`resolvePool` — they are dispatched from a synthetic opportunity id (`detectVenue`) into
`services/dex/venue-manifests.ts`. Interfaces below were read off real committed mainnet
transactions, same standard as the pool table above.

| Venue | Deposit | Exit | Exit spends | Exit returns | Verified txid (exit) |
|---|---|---|---|---|---|
| **Native staking** (`validator_rdx1…`) | `stake(Bucket<XRD>)` → LSU | `unstake(Bucket<LSU>)` **then** `claim_xrd(Bucket<claim_nft>)` | the validator's **stake unit**, never XRD | phase 1: a **Stake Claim NFT**; phase 2: XRD | unstake `txid_rdx1x289695…`, claim `txid_rdx1zzg00z2…` |
| **Weft V2** (`component_rdx1czmr02y…`) | `deposit(Array<Bucket>)` → w2-XRD | `withdraw(Array<Bucket>)` | the pool's **deposit units** (w2-XRD) | the underlying (XRD) | `txid_rdx1rh2cusw…`, `txid_rdx12e2gtpk…` |
| **CaviarNine LSULP** (`component_rdx1cppy08x…`) | `add_liquidity(Bucket<LSU>, None)` → LSULP | `remove_liquidity(Bucket<LSULP>, Address<target_LSU>, None)` | LSULP | **an LSU of the caller's chosen validator** — not XRD | `txid_rdx1cevm52a…` |

Rules that are money-wrong if ignored:

1. **Unstake is two-phase and returns no money.** `unstake` burns stake units and mints a
   Stake Claim NFT; only `claim_xrd` returns XRD, and only at/after the NFT's `claim_epoch`.
   Before then the engine rejects with `ValidatorError(EpochUnlockHasNotOccurredYet)`
   (confirmed by dry-run 2026-08-13). **Never ship unstake without claim.**
2. **The unbonding delay is 2016 epochs = exactly 7 days.** MEASURED, not recalled: an
   unstake committed in epoch 334597 minted a claim with `claim_epoch` 336613 (Δ2016), and
   mainnet epochs run 300 s (18,990-epoch sample → 300.0 s/epoch). The claim's
   `claim_amount` is FIXED at unstake time — it does not keep accruing.
3. **Stake Claim local ids are RUIDs** (`{16hex-16hex-16hex-16hex}`), like QuantaSwap
   receipts and unlike Ociswap's integer ids. Claim NFT data fields: `name`, `claim_epoch`
   (U64), `claim_amount` (Decimal).
4. **LSULP's `remove_liquidity` takes THREE args, not one** — the naive mirror of
   `add_liquidity`'s arity is wrong. The second arg names WHICH validator's LSU you are
   paid in (the pool does not return "your" LSU), so it must be an LSU the pool holds
   enough of, and reaching XRD requires chaining `unstake` on that same validator — which
   re-enters the 7-day unbonding. All three observed real exits chain it in one signed tx.
5. **Resolve every exit resource from its issuer, never from the caller**: stake unit ←
   `validator.state.stake_unit_resource_address`; claim NFT ←
   `validator.state.claim_token_resource_address`; Weft deposit unit ← the V2
   `resource_pools` KVS entry's `deposit_unit_res_address` (XRD → `resource_rdx1th0gjs6…`).
6. **A zero-amount exit previews `Succeeded`.** It is a valid no-op that costs a network
   fee and moves nothing — the same "preview cannot catch valid-but-wrong" family as the
   tick/bin trap, so the builders reject zero themselves.

Exit dry-runs on mainnet 2026-08-13 (`/transaction/preview`, no signature, nothing
submitted): unstake 100 LSU → 1 claim NFT; Weft 100 w2-XRD → 104.718 XRD; LSULP 1000 →
998.879 LSU; LSULP 1000 → 1 claim NFT via the chained unstake. All `Succeeded`.

## Position tracking (position-recorder.ts)

Currently requires an **NFT receipt minted to the caller** — works for Precision +
QuantaSwap. Generalize: when no NFT is found, record the largest **fungible LP inflow**
(Basic, Weighted, DefiPlaza) as the position instead. Both are Gateway-verified from
the committed intent hash; neither needs a vault. This is the one *additive* change.

## Runtime resolution cheatsheet (all verified against mainnet)

`/state/entity/details {aggregation_level:"Global"}` → `items[0].details.blueprint_name`
classifies the pool. Then per blueprint, extract tokens / LP / params:

| Blueprint | tokenX / tokenY | LP resource | params |
|---|---|---|---|
| **BasicPool** | state `x_address` / `y_address` (also in metadata) | native `liquidity_pool` → its `state.pool_unit_resource_address` (fungible) | `input_fee_rate` |
| **PrecisionPool** | metadata `x_address` / `y_address` | metadata `lp_address` (NFT) | metadata `tick_spacing`; state `active_tick` (Enum{I32}), `price_sqrt` |
| **WeightedPool** | native `resource_pool` → `state.vaults[].resource_address` (order = x,y) | native `resource_pool` → `pool_unit_resource_address` (fungible) | `weights`, `fee` |
| **QuantaSwap** | state `tokens_x` / `tokens_y` (internal vaults → each `state.resource_address`) | state `liquidity_receipt_manager` (NFT) | state `bin_span`, `tick_index.current` (active bin), `lower_limit`/`upper_limit` |
| **PlazaPair** | state `base_address` / `quote_address` | native `base_pool` / `quote_pool` → each `pool_unit_resource_address` (two fungible LPs) | state tuple `state.shortage` (BaseShortage/QuoteShortage/Equilibrium) |

Helpers confirmed live: native pools return `details.state.pool_unit_resource_address` +
`details.state.vaults[]` with `opt_ins:{native_resource_details:true}`; internal vaults are
directly queryable (`details.state.resource_address`). Unknown blueprint → `unsupported`,
build no manifest.

`/transaction/preview` response: top-level `resource_changes[]` = `{index, resource_changes:[{
resource_address, component_entity.entity_address, amount}]}`. To show the user their net
movement: keep entries where `component_entity.entity_address == userAccount`, sum `amount`
per `resource_address` (negative = sent, positive = received). `receipt.status == "Succeeded"`
is the sign-gate.

## Manifest templates

See each protocol's verbatim gold-standard manifest in the research transcripts; the
canonical RTM templates (Basic/Weighted/DefiPlaza/Precision/QuantaSwap, add + remove)
are reproduced in the builder module `server/src/services/manifests.ts` as it's rewritten.

## Concentrated math — VERIFIED against mainnet 2026-07-18 (real committed manifests)

Preview can't catch a *valid-but-wrong* tick/bin range (the deposit still succeeds, just
in the wrong place), so these are pinned to real on-chain evidence, not docs/recall.

### Ociswap PrecisionPool  (pkg `package_rdx1pkrgvskdkglfd2ar4jkpw5r2tsptk85gap4hzr9h3qxw6ca40ts8dt`)
- **`price = 1.0001^tick`** (token_y per token_x); `price_sqrt = 1.0001^(tick/2)`. Standard
  Uniswap-v3 base. Confirmed on `component_rdx1cpgmgr…` (xWBTC/XRD): the real add
  `txid_rdx1eudksd05q6y852mvs9efs2ewn077fukkcgdkw4v7cg63mcxjvppsnszfy6` deposited
  Y/X = 1488.55/0.00004286 = 3.473e7 = `1.0001^173640` (the active_tick then). Beware:
  `active_tick` on a dead pool goes STALE vs `price_sqrt` (this one now reads tick 173640
  but price_sqrt 8310 ⇒ real tick ~180500) — **center ranges on `price_sqrt`, not `active_tick`.**
- **`add_liquidity  <left>i32 <right>i32  Bucket(x) Bucket(y)`** — bare `i32` literals, `left<right`,
  pool takes the price-correct ratio and returns change. Ticks need **NOT** be multiples of
  `tick_spacing` (that real add used 166708/180572, not multiples of 60, CommittedSuccess) —
  we snap to spacing anyway so displayed range == deposited range.
- **`remove_liquidity  Bucket(lp_nft)`** — integer local id `#421#`. `withdraw_non_fungibles`
  → `TAKE_NON_FUNGIBLES` → `remove_liquidity`. (`txid_rdx1gl9v7w0a62phhhfqju8y9vz98mhjdcqrk6hays9vs6cg5a5vhdtquqxhlp`.)

### CaviarNine QuantaSwap  (pkg `package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3`)
- **`price(t) = lower_limit · 1.0005^(t − active_bin)`** (token_y per token_x). Per-tick base
  **1.0005 verified across all 8 CaviarNine QuantaSwap pools** (bin_span ∈ {1,10,100}): every
  pool's `upper_limit/lower_limit == 1.0005^bin_span` exactly ⇒ `lower_limit = price(active_bin)`,
  `upper_limit = price(active_bin + bin_span)`.
- **`active_bin`** = `tick_index.current` and is nested: field `tick_index` → `current`
  (Enum `Some`) → Tuple `Tick` → `U32`. (The naive `intField(tick_index.fields,'current')` reads NaN.)
- Valid bins are **multiples of `bin_span`**. **x only in bins ≥ active, y only in bins ≤ active**;
  the active bin holds both. Verified on the real add
  `txid_rdx14q70wyejgd3gmkfm5tvzjp5aqdd8l9zygx3t3z6rfk5sy96lqxzsqpxdfu`.
- **`add_liquidity  Bucket(x) Bucket(y)  Array<Tuple>(Tuple(<bin>u32, Decimal(x), Decimal(y)), …)`**.
  Caller supplies the per-bin split; pool consumes the price-correct amount per bin and returns
  change (a trailing `ASSERT_WORKTOP_CONTAINS` is an optional slippage guard, omitted — preview is the gate).
- **`remove_liquidity  Bucket(lp_nft)`** — receipt id is a **RUID** `{16hex-16hex-16hex-16hex}`,
  NOT an integer (Ociswap's is). NFT-id validator must accept both.
  (`txid_rdx1sad922xl2q3n0rxa3zktmlftumkgc3rvr033t8tnkvk4np5el8vseza7jv`.)
