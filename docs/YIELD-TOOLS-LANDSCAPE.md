> **Provenance:** Drafted 2026-08-07 by an AI session without a shell (never typechecked, built, or run); landed 2026-08-13. Claims in this document were NOT re-verified at landing time — verify against live code before acting. Several claims from the same drafting sessions did not survive verification.

# DeFi Farming Tools Landscape → implications for defi-farmer

> Research synthesis, 2026-07-24 (an AI research session plus a background research agent). Draft; landed 2026-08-13.
>
> **Method honesty:** the fan-out research sub-agents did not return their findings, so this is built from targeted web searches this session + domain knowledge. **Well-sourced (verified this session):** the Radix pass, DefiLlama yields API, IL/concentrated-liquidity calculators. **Thin (domain knowledge, NOT freshly verified — treat TVL/traction as unverified):** cross-chain aggregator mechanics (Beefy/Yearn/Convex/Pendle/Sommelier), portfolio-tracker API specifics, and the whole AI-agent/LST 2026 "frontier."

## 1. defi-farmer baseline (what it already does)

Autonomous Radix yield agent (Bun/TS + bun:sqlite + Next.js "Netflix for yield" frontend). Scans Ociswap/CaviarNine/DefiPlaza → unified `PoolInfo[]` → composite `OpportunityScorer` (APY-7d-MA 40% / TVL-stability 20% / audit 15% / diversity 15% / apySource 10%) → stable-vs-rotational classification → `RotationManager` (exit guards: APY drop >30%, TVL drop >40%; harvest gate reward > 2× gas; 3-day cooldowns; 40%-pool/60%-protocol caps) → atomic withdraw+deposit manifests. 12-endpoint API + Morpho-style curator allowlist.
**Stated gaps:** IL out of scope (just a flag); APY `estimated`/`0` for CaviarNine & DefiPlaza, no fee-vs-emissions split; no price oracle (P&L XRD-only); no concentrated-liquidity range awareness; scoring uses only own snapshots (no external risk data); no lending/health-factor monitoring.

## 2. Cross-chain best-in-class (by category)

**IL & LP calculators** — Metrix Finance (https://metrix.finance, v3/v4 CL backtester — best-in-class), Poolfish (https://poolfish.xyz), Flipside v3 fee calc, apy.vision, Revert Finance. 2026 shift: *range-aware backtested* IL over the classic √-formula; "fees offset 80–90% of theoretical IL in active pools" is now standard framing. Core math: IL = 2·√k/(1+k) − 1.

**APY/APR & projection** — APY = (1+APR/n)^n − 1 (auto-compounders maximize n). Real-yield-vs-emissions is the sustainability lens, best operationalized by DefiLlama's `apyBase` vs `apyReward`. Reward-token decay modeling is a genuine cross-chain gap.

**Aggregators / auto-compounders** *(mechanics = domain knowledge)* — Beefy (https://beefy.com, publishes a per-vault **Safety Score** — cherry-pickable), Yearn v3 (ERC-4626 vaults — reference share-accounting standard), Convex, **Pendle** (https://pendle.finance — PT/YT yield-splitting, biggest structural yield innovation of the cycle), Sommelier (off-chain strategist steering on-chain vaults — precedent for an agent-steered vault like defi-farmer).

**Portfolio / position trackers** — DeBank, Zapper, Zerion, DefiLlama Portfolio. **Every one skips Radix.** So Radix LP P&L/IL tracking is unserved by incumbents.

**Risk / scoring (strongest cherry-pick)** — **DefiLlama yields API** (https://yields.llama.fi/pools, https://github.com/DefiLlama/yield-server): per-pool `apyBase`/`apyReward`, `il7d`, `apyMean30d`, `sigma` (APY vol), `outlier`, `ilRisk`, ML `predictions`. Exponential.fi (A–F pool grades), De.Fi (exploit/rug scanner), DeFiSaver (lending health automation).

**Rebalancing / automation** *(domain knowledge)* — CL auto-rebalancers: Arrakis, Gamma, Steer, Charm, ICHI, Revert Autopilot (auto-recenter v3 ranges = the CL analogue of defi-farmer's rotation). Keepers: Gelato, Chainlink Automation, Keep3r (defi-farmer's tick-loop is a self-hosted keeper — reasonable on Radix, which has no keeper network).

**2026 AI-agent / LST frontier (THIN — verify before trusting):** Giza/ARMA (USDC optimizer on Base, most credible live one), Brahma Console, Almanak, Axal, Mozaic — mostly demoware/thin TVL. Intent/solver: Enso. LST/LRT: EigenLayer + Ether.fi/Renzo/Kelp, farmed via Pendle points. Points trackers: Merkl, Royco. x402/AP2 × yield = a thesis, not a product; Radix invisible.

## 3. Radix-specific pass (well-sourced)

- **Ociswap** — Pool V2 (auto-compounding fees) + **Precision Pool V2** (concentrated liquidity, **manual fee claim**). https://docs.ociswap.com/ociswap-dex/liquidity-pools/precision-pool-v2
- **CaviarNine** — most advanced LP tooling on Radix: **Shape Liquidity** (CL with a dynamic auto-compounding fee that "cushions IL"), LSU Pool / **LSULP**, HyperStake. Community lib **`c9-shape-liquidity-getter`** (https://github.com/Stabilis-Labs/c9-shape-liquidity-getter) computes redemption value + in-range status with Scrypto-matching precision. https://docs.caviarnine.com/products-floop/shape-liquidity/pools
- **DefiPlaza** — **single-sided** liquidity DEX designed to reduce IL. https://docs.defiplaza.net
- **Astrolescent** — swap **aggregator** with the **best public API on Radix** (prices = liquidity-weighted avg, ~10-min refresh; used by ShardSpace/DefiPlaza/Attos). https://docs.astrolescent.com/astrolescent-docs/infrastructure/api
- **Weft V2** — lending; **Wefty NFT** = CDP (collateral+loan), real-time health + liquidation protection (~12% penalty). https://docs.v2.weft.finance/intro/intro
- **Root Finance** — lending; higher LTVs (~85% LSULP→XRD), ~8% penalty.

**Radix gaps vs other chains:** (1) no cross-protocol yield aggregator/auto-compounder — defi-farmer is closest to filling it; (2) no portfolio/P&L/IL tracker covers Radix; (3) no IL / CL-range calculator for Radix pools despite CaviarNine Shape & Ociswap Precision being concentrated; (4) no external `apyBase`/`apyReward`/`sigma`/`il7d` data (Llama barely indexes Radix → must compute natively); (5) no unified Weft+Root health monitor.

## 4. Implications for defi-farmer — ranked, LEAN

**#1 — OWN THE GAP: fee-APR vs emissions split** (fixes "APY estimated, no real-yield signal"). Cherry-pick DefiLlama's `apyBase`/`apyReward` model but compute it natively from Gateway data: fee-APR = pool swap volume × fee tier ÷ TVL; label emissions separately. Integrate **Astrolescent API** for the volume/price side; build the fee-APR calc as core. Upgrades the scorer's biggest weakness.

**#2 — OWN THE GAP: a real IL / USD P&L number** (fixes "IL out of scope + no oracle"). You already renamed IL "price movement risk" in the UI but there's no number behind it. Add IL = 2√k/(1+k)−1 driven by Astrolescent liquidity-weighted prices; decompose position value into deposit vs fees-earned vs IL. Table-stakes elsewhere, **absent on Radix.** Keep lean: one formula + one price feed, not a backtesting suite.

**#3 — CHERRY-PICK: concentrated-liquidity range awareness** for CaviarNine Shape + Ociswap Precision. Both are CL → a position can be *out of range earning nothing*, invisible to a flat `apy` field. Integrate **`c9-shape-liquidity-getter`** for CaviarNine in-range status + Ociswap Precision state; add one "in-range %" signal to the scorer/exit-guard. Most Radix-specific edge available, and the library already exists — low build cost.

**#4 — CHERRY-PICK: Beefy-style transparent Safety Score.** Your composite score is internal-only. Fold in external-style dimensions (contract age, IL-risk class from #2, `apyBase:apyReward` ratio from #1) and surface a visible letter/star grade behind the curator UI. No new infra — richer inputs into the existing scorer.

**#5 — DON'T (anti-bloat) + one to park:** Skip AI-agent/intent frameworks (Enso/Giza/x402) and keeper networks (Gelato/Chainlink) — your tick-loop already is the keeper; Radix has no intent layer to plug into. **Park, don't build:** a Weft/Root **health-factor monitor** — natural next surface (ties to the DeFi-Farmer account's Weft positions), nobody on Radix aggregates it, but it's a *new product surface* (borrowing), not a farming feature → defer until LP-side #1–#3 ship.

## 5. Confidence / unknowns + things to verify before building
- **Verify:** (a) Weft's health-factor **direction** (<1.0 vs >1.0 triggers liquidation — confirm in Weft docs before a monitor); (b) whether DefiLlama indexes *any* Radix pools today (confirm before assuming full native compute); (c) whether Ociswap volume/fee data is reachable via Gateway vs needing Ociswap's own API (verify before committing #1's fee-APR calc).
- **Not covered:** Surge (Radix perps), RadixLSU staking-yield specifics.

**Net:** the four highest-value moves are all **own-the-gap-on-Radix** plays reusing ONE library (`c9-shape-liquidity-getter`) + ONE API (Astrolescent), mapping directly to defi-farmer's stated gaps, adding zero new external infra.
