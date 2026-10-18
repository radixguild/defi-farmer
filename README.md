# defi-farmer

Non-custodial DeFi yield advisor for [Radix](https://www.radixdlt.com) mainnet: a Bun agent
that scans and scores yield venues, and a Next.js dapp where every deposit and exit is a
transaction manifest **you** sign in your own wallet. The server holds no signing key, no
vault and no custody. Funds never touch it.

**Status: live, maintained, zero users to date.** The honest version is in [STATE.md](STATE.md).
Licence: Apache-2.0 ([LICENSE](LICENSE)). How this public tree came to be:
[PROVENANCE.md](PROVENANCE.md).

## What it does

- **Scans** Ociswap, CaviarNine (including its LSU Pool), DefiPlaza, native XRD staking and
  Weft V2 lending through the public Radix Gateway. No private APIs, no keys.
- **Scores** each opportunity on risk-adjusted yield net of impermanent loss: 7-day APY
  moving average, TVL stability, audit status, diversity and APY provenance
  (`server/src/services/scorer.ts`, `calculators.ts`).
- **Proposes** rotations and flags exits (APY or TVL collapse). Proposals are shown to the
  operator; the agent never executes anything.
- **Builds manifests** for five pool kinds (Ociswap Basic and Precision, CaviarNine Weighted
  and QuantaSwap, DefiPlaza) plus staking, LSU-pool and lending exits, and dry-runs every
  one through the Gateway's `/transaction/preview` before the wallet sees it. That preview
  is the sign gate (`server/src/services/dex/preview.ts`): a failing preview cannot be
  signed.
- **Records positions** only from committed transactions it has verified against the
  Gateway (`POST /api/positions {intent_hash}`). Nothing client-asserted is trusted.

## What it does not do

Hold or derive keys, custody funds, sign or submit transactions, auto-rebalance, or move
anything on your behalf. A change that would add any of those is out of scope here; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

| Path | What |
|---|---|
| `frontend/` | Next.js 16 App Router (React 19) dapp: Radix dApp Toolkit v2 sign flows, ROLA sign-in, dark mode, same-origin API proxy |
| `server/` | Bun + TypeScript agent and HTTP API (`Bun.serve`) with SQLite via `bun:sqlite`: scanners, enricher, scorer, Kelly allocator, range optimizer, rotation proposals |
| `server/src/services/dex/` | The non-custodial builder: runtime pool resolver, manifest builders, concentrated-liquidity math, Gateway dry-run preview |
| `docs/` | Specs that are still current: [DEX-INTEGRATION](docs/DEX-INTEGRATION.md) (verified mainnet interfaces and math) · [MONETIZATION](docs/MONETIZATION.md) · [PHASE-3.1-DESIGN](docs/PHASE-3.1-DESIGN.md) (auth model) · [SNAPSHOT-CADENCE-PLAN](docs/SNAPSHOT-CADENCE-PLAN.md) · [SPEC-FEE-SPLIT-AND-IL](docs/SPEC-FEE-SPLIT-AND-IL.md) · [YIELD-TOOLS-LANDSCAPE](docs/YIELD-TOOLS-LANDSCAPE.md) |

## Quick start

Requires [Bun](https://bun.sh) 1.3.12 (the version CI pins; 1.3.14 regressed `--frozen-lockfile`)
and Node 20.9 or newer for the Next.js build (Next.js 16 needs `>=20.9.0`; CI pins only Bun, not Node).

```bash
bun install && (cd server && bun install) && (cd frontend && bun install)
cp .env.example .env                 # API_AUTH_TOKEN is the only required value; there is no signing key
cp frontend/.env.example frontend/.env.local
bun run validate                     # typechecks + the full test suite (the merge gate)
bun run agent                        # advisor agent + API on 127.0.0.1:3001
bun run dev                          # dapp on http://localhost:3000
```

Set `NEXT_PUBLIC_USE_MOCKS=true` in `frontend/.env.local` to browse the UI on sample data
without running the agent. Sign actions are disabled in that mode.

## Auth model

Three API tiers. **Public**: market data and the read-only `POST /api/dex/build` sign gate.
**Session**: a ROLA account proof becomes an HttpOnly `farmer_session` cookie, and a wallet
sees only its own rows. **Operator**: a Bearer token, or a session whose account is listed
in `OPERATOR_ADDRESSES`, for agent control. No session ever sees past its own account, an
allowlisted one included: views across accounts (every position, the rotation proposals, the
watch list) take the Bearer. Design and decisions:
[docs/PHASE-3.1-DESIGN.md](docs/PHASE-3.1-DESIGN.md).

## Running it in production

Two loopback-bound processes behind a TLS-terminating reverse proxy (the reference
deployment uses Caddy): the agent and API (`bun run agent:start`) and the dapp
(`next start`). Behind the proxy set `TRUST_PROXY=true` and `SESSION_COOKIE_SECURE=true`.
`ROLA_EXPECTED_ORIGIN` and the dApp definition must match the deployed origin, and that
origin must be in the dApp definition's on-chain `claimed_websites`
(`frontend/public/.well-known/radix.json` must name the same account). The operator's own
deploy tooling is not part of this repository.

## Security

Private reporting only; see [SECURITY.md](SECURITY.md). Never test against the live
deployment.
