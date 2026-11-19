# State

_Updated 2026-11-19. This is the project's public status page. It changes when the facts
change, not on a schedule._

## Now (2026-11-19)

What changed in code with this update. Whether the live site runs it depends on the next
deploy: a live `/api/status` that carries a `sources` block runs it.

- **DefiPlaza data is back, as its own view.** The old sources were dead:
  `stats.defiplaza.net/api/pairs` returns 404, and the Gateway path found no pairs (the
  PlazaDex router keeps them in KeyValueStores) and returned nothing without an error. The
  farmer now reads `https://radix.defiplaza.net/api/pairs` and serves one row per pair side
  at `GET /api/defiplaza`. Each return is labelled **ALR** (DefiPlaza's Annualized
  Liquidity Return: versus holding that side's token, including impermanent loss, can be
  negative; [definition](https://docs.defiplaza.net/defiplaza/radix/faq)). It is not a fee
  APR, so these rows are kept out of `/api/opportunities` and the scorer, which treats
  figures as fee APR and subtracts a modelled IL. The API's `volume` field is always 0 and
  is not read.
- **A failed price is "unavailable", not 0 USD.** The pool enricher's per-token price
  lookup used to return 0 on any failure and cache it, so a pool's TVL quietly shrank. It
  now returns nothing, the pool gets no TVL (and is not ranked) and the failure is retried
  on the next pass.
- **CaviarNine and Weft are no longer recommended.** The CaviarNine DEX app says the DEX "is
  being sunsetted" and asks users to withdraw their remaining liquidity
  ([caviarnine.io](https://www.caviarnine.io/), checked 2026-11-19; its remove panel covers
  LSU Pools too);
  DefiLlama lists a Weft V2 exploit on 2026-08-30
  ([defillama.com/hacks](https://defillama.com/hacks)). Their pools, including the
  CaviarNine LSU Pool, stay scanned and existing positions still show and can be exited,
  but they are excluded from scoring, `/api/opportunities` and rotation targets. The UI
  labels them "Sunset · exit only" and "Exploited Aug 2026 · unverified". The sign gate also
  refuses new LSULP and Weft deposits (`POST /api/dex/build`), before any Gateway read;
  their exits build as before. The operator deposit switch (#11) covers LP pool kinds only;
  this closes LSULP and Weft, two of the three single-sided venues it does not reach. Native
  staking, the third, stays open.
- **Per-source health on `/api/status`.** A `sources` block lists each data source with
  `ok`, `lastSuccessAt`, `lastErrorAt`, `lastErrorKind` and `lastRows`. A source that
  answers with zero rows counts as a failure (`empty`). Raw error text stays on the
  operator route.
- **Radix-wide yield view** (`/yields`, `GET /api/yields`; design note
  [docs/design/radix-yield-view.md](docs/design/radix-yield-view.md)). Read-only. Three
  separate tables, each sorted by exit depth in XRD: staking APY (Gateway), Ociswap fee APR
  (impermanent loss not included) and DefiPlaza ALR (included). Rows only for pairs of
  watchlist assets (`server/src/config/yield-watchlist.json`, keyed by resource address).
  Prices follow three rules: Astrolescent price cross-checked against Ociswap (flagged beyond
  5%, never averaged), a liquidity floor ($1,000 aggregate TVL and non-zero 7-day volume),
  and XRD throughout with USD once from DefiLlama. Flags: bridge, off peg, meme, prices
  disagree, outlier. Validator kickers are listed apart, as advertised and unverified. A
  daily snapshot (`yield_snapshots`) gives 7-day changes once a week of history exists.
- **Known, not fixed here:** Ociswap's per-token price endpoint (`/prices/<token>`) answered
  502 for every token tried on 2026-11-19 (XRD, DFP2, ASTRL), while `/tokens/<token>`
  answered 200. Until the price source changes, pools whose TVL has to be filled from vault
  balances stay unpriced and unranked, and `/api/status` shows `ociswap-prices` as
  `price_unavailable`.
- Unchanged: the pool resolver's pinned-package checks, the deposit switch (#11), the LSULP
  part-fill refusal (#8) and the sign gate. Nothing new signs, trades or moves funds.

## Previous (2026-11-15)

- Live at https://farmer.radixguild.com. Main was at `38441ce`.
- The exact commit the live site runs is not recorded. Whether it includes the two changes
  below is unknown.
- Merged since the 2026-11-06 update:
  - #8 (2026-11-09): LSULP exits are refused at the sign gate if the dry-run would only
    part-fill. Design note: [docs/design/lsulp-exit-part-fill.md](docs/design/lsulp-exit-part-fill.md).
  - #9 (2026-11-11): the dApp definition moved to a new account.
- **LSULP part-fill limit.** If an LSULP withdrawal would return any LSULP unfilled, the app
  refuses it and shows the returned amount. It does not part-fill and does not pick another
  validator LSU. The user would have to exit in smaller parts or wait.
- **Size threshold.** The note gives no exact threshold. It estimates about 554k LSULP for the
  LSU the app picks today, from a 2026-11-07 vault read. That figure is inferred, not measured.
- **Deposit switch.** The operator can pause deposits per venue kind or per pool
  (`DEX_DEPOSITS_DISABLED_KINDS`, `DEX_DEPOSITS_DENY_POOLS`). The switch does not gate
  withdrawals or position recording. See
  [docs/DEX-INTEGRATION.md](docs/DEX-INTEGRATION.md#pausing-deposits-operator-switch).
- Users: still zero recorded (see Users below). Feature work still paused.

> Superseded 2026-11-15: the sections below are kept as written on 2026-11-06 unless marked
> otherwise. Where they differ from "Now", "Now" is current. On venues: see "Now" for
> CaviarNine and Weft.

## Deployed

Live at https://farmer.radixguild.com since 2026-10-18, a non-custodial advisor on Radix
mainnet (first deployed in August 2026). The move to a radixguild.com subdomain, dropped on
2026-10-11, was re-ruled on 2026-10-18. The earlier address,
`farmer.156-67-219-105.sslip.io`, redirects: on 2026-11-05 (UTC) it answered `301` to the
same path on `https://farmer.radixguild.com`. It reads public
ledger and DEX state, scores it, and builds manifests for the connected wallet to review and
sign. There is no server-side key and no custody (see the [README](README.md)). The deploy
tooling behind it is not part of this repository.

## Users

**Zero.** One wallet (the operator's) completed a ROLA sign-in as a smoke test on
2026-08-23. No deposit has ever been recorded through the app and its position table is
empty. Read every "live" claim here accordingly: the code paths are exercised by tests and
by Gateway dry-runs, not by a production deposit round trip.

## Maintained, with feature work paused

The last feature work landed in 2026-08. The repository is kept live and maintained: security
fixes, dependency updates, documentation corrections and test improvements (see
[CONTRIBUTING.md](CONTRIBUTING.md)) land as they come, and the operator's stated reason for
keeping it running (2026-10-09) is that stablecoin liquidity is expected to return to the venues
this advisor scans, which makes the tool useful again. Feature work resumes when that happens.
Why it paused:

- **The Radix venue set is shrinking.** During 2026 at least one DEX this advisor scans
  announced a wind-down and one lending market it reads went dormant. The scanner reports
  what the Gateway returns, so a venue that disappears simply stops appearing. Nothing is
  faked and nothing is substituted.
- **Monetization was never built.** The streams in [docs/MONETIZATION.md](docs/MONETIZATION.md)
  are a spec. The platform-fee splice exists in code but is off by default and fails safe
  when misconfigured; the gift page (`/gift`) stays dark unless a destination is configured
  and validates (`frontend/lib/gift`).
- **Radix mainnet halted on 2026-08-31 and resumed on 2026-09-11.** The Gateway's
  transaction stream shows no committed transaction between state version 557840627
  (2026-08-31 21:19 UTC) and 557840628 (2026-09-11 11:35 UTC). The advisor ran through the
  halt with nothing current to score.

## Known gaps

- LSULP exits above the picked LSU's depth are refused, not filled (#8, 2026-11-09). Choosing
  the exit LSU by pool depth is listed in the design note as a possible later improvement; it
  is not built.
- CaviarNine LSU-pool exits pass `None` for the credit-receipt (LSUCR) proof. A schema read
  and mainnet previews on 2026-11-05 confirmed that `None` is valid. Passing the receipt's
  proof would waive the pool's 0.07% fee on the credited amount for that LSU, and the
  builder does not do this (see [docs/DEX-INTEGRATION.md](docs/DEX-INTEGRATION.md), rule 7
  under single-sided venues).
- [docs/SNAPSHOT-CADENCE-PLAN.md](docs/SNAPSHOT-CADENCE-PLAN.md) phases 4 and 5 (index
  re-measure, one-off `VACUUM`) are open.
- Comments that cite `REVIEW-2026-07-17 Fnn` refer to an internal 2026-07-17 security review
  whose text is not published. The IDs are kept so the code's history stays traceable.
