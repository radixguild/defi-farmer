# Phase 3.1 — foundation fixes + ROLA auth + multi-tenant read path

**Date:** 2026-07-17 · **Branch:** `feat/phase31-rola-multitenant-20260717` · **Inputs:** the 2026-07-17 internal review (its findings are cited below by ID; the review itself is not published)

## Goal

Close the loop **connect wallet → sign in (ROLA) → deposit (existing flow) → position recorded →
portfolio shows it** — on a foundation whose CI actually validates the shipped code and whose
"local-only" assumptions are made real. This is the smallest coherent step from "parked agent +
orphaned frontend" to "one user-facing dapp with real identity."

## Design decisions

**D1 — Identity = account address, proven via ROLA account proof.**
The 2026-04 one-pager said persona-address identity; the Guild app's battle-tested implementation
(`guild-app/src/lib/rola.ts`, `useWallet.tsx`) authenticates the **account** (`SignedChallenge
type:"account"`), which is also what positions/portfolios are actually keyed by on-chain. We port
that pattern verbatim: identity = account address, `user_address` in every scoped row. Personas add
a mapping layer with zero v1 benefit. (Deviation from PLAN-era memory, deliberate.)

**D2 — Sessions = HttpOnly cookie + SQLite `sessions` table.**
Random 32-byte token, SHA-256 stored (never the raw token), 30-day TTL, sliding `last_seen_at`.
Cookie flows through the existing same-origin Next.js proxy (`app/api/[...path]/route.ts`) —
allowlist exactly the `farmer_session` cookie both directions. No CORS dance, no token in JS,
survives agent restarts (unlike the Guild app's in-memory store — we have SQLite on both ends anyway).
Challenge nonces stay in-memory (one-time consume) exactly like the Guild app. The TTL was 60s
at design time and is 5 minutes since 2026-10-18, for the mobile wallet round trip.

**D3 — Three-tier API auth (replaces "one shared token for everything"):**
| Tier | Guard | Endpoints |
|------|-------|-----------|
| Public | none | health, opportunities, snapshots, market-data GETs, `POST /api/manifest/build` |
| Session | `farmer_session` cookie → `user_address` | `GET/POST /api/positions` (own rows), `/api/auth/*` |
| Operator | existing Bearer token (timing-safe) | agent start/stop/harvest, rotation approve/reject, global position views, `/api/config` (F17: moves behind operator) |
Operator Bearer also satisfies session-tier endpoints (sees all rows). One middleware, fail-closed.
`POST /api/manifest/build` is public despite being a POST (POSTs otherwise default to
operator): `buildManifest()` is a pure preview utility — no DB writes, no signing, no agent
control — and the dapp's deposit flow builds a manifest **before** ROLA sign-in (wallet-connect
only, see `opportunity/[address]/page.tsx`), so gating it would break deposits. Money moves only
when the user signs the returned manifest in their own wallet. Its dedicated proxy route
(`frontend/app/api/manifest/build/route.ts`) therefore attaches NO operator Bearer — that route
exists specifically so the catch-all's blanket POST-Bearer never rides on an anonymous caller
(sibling to F10/F14/F17). F13 receipt-id/address validation still runs inside the builder; per-IP
rate limit + 100KB cap still bound it.

**D4 — Multi-tenant = additive `user_address` column, `NULL` = bot-owned.**
`positions`, `transactions`, `rotation_log`, `agent_log` gain `user_address TEXT` (nullable) +
indexes. The agent keeps operating exactly as today on its own (NULL-owner) rows — zero behavior
change to the loop. Session queries scope `WHERE user_address = ?`. No per-user keys, no per-user
agent: users are **manual-mode self-custody** (they sign; we track). Per-user vaults stay Phase 4.

**D5 — Position recording is verified, fail-closed (F11).**
`POST /api/positions {intent_hash}` (session tier): server fetches committed-details from the
Gateway, requires status `CommittedSuccess`, requires the tx's balance changes to touch the
session's account, extracts pool/amounts from deposit shape (reusing `verifier.ts` patterns).
Nothing client-asserted is trusted beyond the intent hash. Duplicate `intent_hash` = idempotent 200.

**D6 — `frontend/` (Next.js) becomes the canonical and only frontend (F2/F19).**
Legacy Vite app (`src/`, `vite.config.ts`, root vite scripts) deleted; CI gains
`frontend/`: `tsc --noEmit` + `next build`, keeps `bun test` + server typecheck; root scripts
repointed. `tradingview/` + `sources/radix-defi-sources.ts` deleted (imported by nothing).
Built-but-unwired modules (`calculators`, `data-tracker`, `report-generator`) stay — they're
tested and on the roadmap (ROI math / history).

> ⚠️ **Two thirds of that line went out of date and misled an audit (2026-08-09).**
> `calculators.ts` is LIVE — `scorer.ts:22` and `pool-enricher.ts:19`, both on the
> agent tick path; deleting it crashes the agent at boot. `data-tracker.ts` is
> PARTLY live — `pruneOldData` runs every tick from `loop.ts:355` and is what keeps
> `pool_snapshots` from regrowing to the 1.37M rows noted in its own header.
> Only `report-generator` was genuinely unwired, and it is now deleted.
> Trace from an entry point before trusting any "unwired" claim in this doc.

**D7 — Foundation security fixes ship in the same PR, first in the commit order:**
- F4: `API_HOST` env, default `127.0.0.1` (explicit `0.0.0.0` opt-in for containerized/public).
- F3: `BOT_PRIVATE_KEY`/`BOT_KEY_TYPE` required **only when `SIGNER_SERVICE_URL` is unset**; isolated mode boots keyless.
- F8: signer-service exits at boot when `SIGNER_AUTH_TOKEN` is unset (fail closed, matching its own allowlist posture).
- F12: rate-limit key = `server.requestIP()` socket address; `TRUST_PROXY=true` opts into first-hop XFF (Caddy).
- F7: idempotency row written **before** submit (`status='submitting'`), updated after — closes the double-harvest window.
- F13: `receipt_id` validated (`^[0-9]+$`) inside every manifest builder, not just the API path.
- F15: parameterize the one interpolated UPDATE.
- F5: typescript pin → 5.9.3 (5.7.0 yanked; aligns with PR #21's side).
- F16: `.npmrc` (`ignore-scripts=true`) into `server/` so the VPS install is covered.
- F14: document the operator-harvest bypass in `api.ts` (intentional, operator-token-gated).

**D8 — Deploy path made truthful, deploy itself NOT in scope.**
The deploy script and process-manager config reconciled (correct process names incl. a separate dapp
process for `next start`, rsync set incl. `frontend/` build). Actually deploying (VPS is 9+ weeks stale,
needs signer allowlist authored + envs split per F3 — an operator action) is a separate, explicit
step after this PR merges.

**D9 — Dark mode activated** (F21): `next-themes` provider, default dark, toggle in nav. House style.

## Build plan (commit order)

1. `docs`: this design + the review.
2. `fix(frontend)`: F1 — destructure `accounts`/`sendTransaction`, wire Exit, un-disable button.
3. `harden(server)`: D7 bundle (F3, F4, F7, F8, F12, F13, F15, F16, F14 comment) + tests for each.
4. `feat(auth)`: ROLA service + challenge/verify/logout/me endpoints + `sessions` table + middleware (D1-D3) + tests (TTL, replay, consume-on-fail, tier gating).
5. `feat(positions)`: `user_address` migration + scoped queries + verified `POST /api/positions` (D4-D5) + tests (gateway mocked).
6. `feat(frontend-auth)`: ROLA sign-in in `radix-provider` (challenge generator + `withProof`), `signIn/ensureSession/signOut/authed`, `decideSession` account-switch guard ported from the Guild app, deposit flow records position after commit, positions page uses session, sign-in prompt component.
7. `chore(frontend)`: D9 dark mode.
8. `chore`: D6 deletions + CI repoint + root script repoint.
9. `docs`: README rewrite to match reality (F20) + D8 deploy-file reconciliation.

Each commit leaves `bun test` + both typechecks green; CI change lands with the deletion commit so
the pipeline never validates a deleted app.

## Out of scope (explicitly)

- **PR #21 (scrypto audit fixes)** — merge needs Linux/VPS WASM build + `cargo test` + manual LP
  checks per its own test plan. Next lane after this PR; resolve `package.json` conflict toward 5.9.3.
- **VPS deployment** (D8) and signer allowlist authoring (F23) — operator actions.
- **dApp definition on-chain claim + origin registration** — required before any public origin
  serves the wallet flow (mainnet rejects unclaimed origins); ops step with the deploy.
- **Rotation execution wiring (F18)** — approve stays cosmetic until the execution design (incl.
  what "approved" authorizes and per-tenant caps) gets its own review; do not casually wire
  `executeRotation` to the flip endpoint.
- Auto-mode / per-user vaults / Phase-2 classifier enforcement (issue #10) — Phase 4 / ops.
