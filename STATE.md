# State

_Updated 2026-10-13. This is the project's public status page. It changes when the facts
change, not on a schedule._

## Deployed

Live since August 2026 as a non-custodial advisor on Radix mainnet at
`farmer.156-67-219-105.sslip.io`. A move to a radixguild.com subdomain was considered and
dropped on 2026-10-11; the address stays as it is. It reads public ledger and DEX
state, scores it, and builds manifests for the connected wallet to review and sign. There is
no server-side key and no custody (see the [README](README.md)). The deploy tooling behind
it is not part of this repository.

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
- **Radix mainnet halted on 2026-08-31 and resumed on 2026-09-11.** The advisor ran through
  the halt with nothing current to score.

## Known gaps

- The CaviarNine LSU-pool credit-receipt (LSUCR) discount path is unverified against
  mainnet; exits pass `None`.
- [docs/SNAPSHOT-CADENCE-PLAN.md](docs/SNAPSHOT-CADENCE-PLAN.md) phases 4 and 5 (index
  re-measure, one-off `VACUUM`) are open.
- Comments that cite `REVIEW-2026-07-17 Fnn` refer to an internal 2026-07-17 security review
  whose text is not published. The IDs are kept so the code's history stays traceable.
