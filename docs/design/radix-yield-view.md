# Radix-wide yield view: design note

Status: built minimal in the same PR as this note. Analytics only: nothing here signs, trades
or moves funds, and nothing feeds the scorer, rotation or the deposit builder.
Date: 2026-11-19. Builds on the source-health and DefiPlaza changes (STATE.md, 2026-11-19).

## Goal

One page that answers "where is the yield on Radix, in XRD, and can I get out". Not an
indexer and not a price engine. At this size of market (DefiLlama put Radix chain TVL at
about $275k on 2026-11-19) exit depth matters more than headline return, so the page sorts by
depth.

## Sources (no new infrastructure)

| Source | Used for | Notes |
|---|---|---|
| Astrolescent `GET https://api.astrolescent.com/prices` | token price in XRD (`tokenPriceXRD`), `aggregateTVL` (USD), `aggregateVolume7D` (XRD) | keyed by resource address; symbols are not unique (two resources call themselves `XRD`) |
| Ociswap `GET https://api.ociswap.com/pools?limit=100` | pool fee APR (`apr.7d`, fee-only), `total_value_locked.xrd.now`, `volume.xrd.7d`, `fee.xrd.7d`, `pool_type`, `fee_rate`, token `price.xrd.now` | one page, XRD fields only (the USD fields are distorted by XRD's own move) |
| DefiPlaza `GET https://radix.defiplaza.net/api/pairs` | per-side ALR (IL-inclusive), side reserves | the snapshot `services/defiplaza.ts` already refreshes |
| Gateway, via the existing `staking.ts` scan | native staking APY | the row the agent already scores |
| DefiLlama `coins.llama.fi/prices/current/coingecko:radix` | XRD/USD, converted once | `radix:<resource>` lookups return nothing, so only XRD itself |
| DefiLlama `api.llama.fi/v2/chains` | Radix chain TVL (banner) | |

## The three price rules

1. **Price = Astrolescent `tokenPriceXRD`**, cross-checked against Ociswap's `price.xrd.now`
   from the deepest Ociswap pool that pairs the token with XRD. If they differ by more than 5%
   the asset is flagged `price_disagree` and both prices are shown. They are never averaged.
2. **Liquidity floor.** A token whose Astrolescent `aggregateTVL` is under $1,000 or whose
   `aggregateVolume7D` is 0 is `below_floor`: it gets no rows. This removes the junk prices
   (BONK at trillions of USD, migrated duplicates with a placeholder TVL of exactly 1000 and no
   volume).
3. **Everything in XRD.** USD appears once: XRD/USD from DefiLlama, used for the banner and an
   asset's USD price (needed for the off-peg flag). No source's own USD fields are used.

## Rows and fields

Rows exist only for pools whose two tokens are both on the watchlist, so junk pairs never
reach the page. Three sections, each sorted by exit depth, never merged into one ranked list:

- **Staking APY**: native XRD staking (Gateway). Exit: the network unstake delay, not a pool.
- **Fee APR (no IL)**: Ociswap pools. `apr.7d` is fee income only; impermanent loss is not in it.
- **ALR (IL-inclusive)**: DefiPlaza pair sides. DefiPlaza's Annualized Liquidity Return, the return
  versus holding that side's token; can be negative.

Per row: venue, pair, return type + return %, exit depth in XRD, 7d volume in XRD (DefiPlaza: not
reported, shown as such), flags, and the 7-day change of return and depth from the daily snapshot.
DefiPlaza depth is computed in XRD from the side reserves × the rule-1 token price; if a price is
unavailable, depth is unavailable (never 0).

Per watchlist asset: price in XRD (Astrolescent), cross-check price (Ociswap), divergence, USD
price, aggregate TVL, 7d volume, flags, 7-day price change.

## Flags

- `bridge`: the asset depends on an external bridge (`h`-assets: Hyperlane; `x`-assets:
  Instabridge). Redeemability is unverified; the page says so rather than guessing.
- `off_peg`: a `stable`-tagged asset whose USD price is more than 5% from $1.
- `meme`.
- `price_disagree`, `below_floor` (rules 1 and 2).
- Protocol status comes from `services/venue-status.ts` (CaviarNine sunset, Weft exploited). No
  rows come from those venues today, because no adapters are built for them.
- **Kickers** (validator bonuses paid in DFP2 or ASTRL) are a separate list, each marked
  `unverified` with the venue's own page as the source, until checked in the dApp.

## Chain banner

XRD/USD, chain TVL, and a config note that carries only what a source backs: the Radix
Foundation's 28 Apr 2026 post says exchange market making was pre-funded "through September"
with an option to extend (whether it was extended is not known here), and that Radix Rewards
were distributed and are no longer hosted by the Foundation.

## Watchlist is config, not code

`server/src/config/yield-watchlist.json`: resource address, symbol, tags (`meme`, `stable`,
`bridge` + route), kickers and the banner note. Keyed by resource address, never by symbol.
Starting set (2026-11-19, the assets with both liquidity and volume): XRD, DCKS (Ociswap lists
the same resource as REDDICKS), WOWO, hUSDC, xUSDC, DFP2, ASTRL.

## Daily snapshot

Table `yield_snapshots (day, kind, key, value)`, one row per UTC day per value (`INSERT OR
IGNORE`), kinds `price_xrd`, `return_pct`, `depth_xrd`. The view reads the value from 7 days
earlier to show a 7d change; missing history shows as unavailable. Pruned with the existing
retention sweep window.

## Don't build

- Our own indexer or Gateway reserve crawler.
- A custom price engine (Astrolescent already aggregates across DEXs).
- 500-token coverage: the watchlist is the coverage.
- Backtests or IL suites (the 30-day vol estimate in `price-feed.ts` is enough here).
- Adapters for dead or unverified venues (CaviarNine, Weft, Root).
- HTML scraping (DefiPlaza per-pool volume exists only as HTML, so it stays "not reported").

## Serving

`GET /api/yields` (public, read-only), refreshed by the agent loop at most every 15 minutes,
with per-source health (`astrolescent`, `ociswap-pools`, `defillama-xrd`, `defillama-chains`)
on `/api/status`. Frontend: `/yields`.
