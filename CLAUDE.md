# defi-farmer — notes for agents

Read first: [README.md](README.md) (what it is), [STATE.md](STATE.md) (status: live,
feature work paused, zero users to date), [CONTRIBUTING.md](CONTRIBUTING.md) (ground rules),
[SECURITY.md](SECURITY.md). Specs that are still current (reference, not status):
`docs/DEX-INTEGRATION.md` (verified mainnet interfaces + concentrated math),
`docs/MONETIZATION.md` (engine spec), `docs/PHASE-3.1-DESIGN.md` (auth model D1–D9),
`docs/SNAPSHOT-CADENCE-PLAN.md` (data lifecycle; phases 4–5 open),
`docs/SPEC-FEE-SPLIT-AND-IL.md`, `docs/YIELD-TOOLS-LANDSCAPE.md`.
Operator-only notes (deployment, dApp-definition rotation, incident history) are kept
outside this public tree.

Non-custodial yield dapp + autonomous **advisor** agent on Radix mainnet. The agent
scans and scores real DEX, staking and lending venues and surfaces proposals; the USER signs
every deposit / withdraw manifest in their own wallet. **Funds never touch the server:
there is no signing key, vault, or custody.**

## Stack
- `frontend/` — Next.js 16 App Router (React 19), Radix dApp Toolkit v2, ROLA sign-in, Tailwind/shadcn-style, dark default
- `server/` — Bun + TypeScript + bun:sqlite; advisor agent loop + HTTP API (`Bun.serve`)
- `server/src/services/dex/` — the non-custodial real-DEX builder: runtime pool resolver,
  manifest builders (Ociswap Basic/Precision, CaviarNine Weighted/QuantaSwap, DefiPlaza),
  concentrated math, and the Gateway-dry-run preview (the sign gate)

## Commands
- `bun run validate` — server + frontend typechecks + full test suite (the merge gate)
- `bun run agent` — advisor agent + API on 127.0.0.1:3001
- `bun run dev` — Next dapp on localhost:3000

## Auth model (Phase 3.1)
Three API tiers: public (market data + the read-only `POST /api/dex/build` sign gate) /
session (ROLA account proof → `farmer_session` HttpOnly cookie, own rows only) / operator
(Bearer, agent control + global views). Positions are recorded only via Gateway-verified
`POST /api/positions {intent_hash}` — everything stored is read from the committed tx.

## Safety rules
- NEVER add a signing key, vault, signer process or auto-execute path — the app is
  non-custodial by design: it builds a manifest and the USER signs it in their own wallet.
- Every manifest is Gateway-dry-run **preview-gated** before it reaches the wallet
  (`dex/preview.ts`) — a failing preview cannot be signed. Preview cannot catch a
  valid-but-wrong range, so re-verify concentrated math against DEX-INTEGRATION.md if you touch it.
- Gift destinations (`frontend/lib/gift`) come from env only and are validated at build
  time; never hard-code an address.
- The dApp definition address must be identical in `frontend/public/.well-known/radix.json`,
  `frontend/lib/radix-provider.tsx` and `server/src/config.ts`;
  `frontend/tests/dapp-definition.test.ts` fails CI if they drift.
- NEVER print values of env keys containing KEY/TOKEN/SECRET — key names via anchored grep only
- Tests live under `server/tests/` and `frontend/tests/`, run with `bun run test`; CI
  typechecks + builds `frontend/` — never drop that gate (it's how broken code merged before)
