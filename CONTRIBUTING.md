# Contributing

Feature work is paused (see [STATE.md](STATE.md)). Security fixes, dependency updates,
documentation corrections and test improvements are welcome. Feature work is not being
planned; open an issue first so the conversation happens before the code.

## Ground rules

These are the product, not style preferences.

1. **Non-custodial, always.** Nothing in this repository may hold, read, derive or accept a
   signing key, and no server-side code may sign or submit a transaction. A change that adds
   a key, a vault, a signer process or an auto-execute path will be closed, however well it
   is written.
2. **Every manifest is preview-gated.** Anything that reaches a wallet goes through the
   Gateway dry-run in `server/src/services/dex/preview.ts` first, and a failing preview must
   stay unsignable. Preview cannot catch a valid-but-wrong range: if you touch the
   concentrated-liquidity math, re-verify it against
   [docs/DEX-INTEGRATION.md](docs/DEX-INTEGRATION.md).
3. **Money paths get a verified round trip, not a drive-by.** The manifest builders, the sign
   gate, position verification (`POST /api/positions`) and the gift guard
   (`frontend/lib/gift`) change only with a description of how the change was exercised end
   to end. Gift destinations come from env and are validated at build time; never hard-code
   an address anywhere.
4. **Nothing secret in the tree.** `.env` files are ignored, the `.env.example` files
   document the shape, and CI runs gitleaks over the full history on every PR. Never print
   the value of an env var whose name contains `KEY`, `TOKEN` or `SECRET`.

## Setup and tests

Bun 1.3.12 (the version CI pins; 1.3.14 regressed `--frozen-lockfile`) and Node 20.9 or newer
(Next.js 16 needs `>=20.9.0`; CI pins only Bun, not Node).

```bash
bun install && (cd server && bun install) && (cd frontend && bun install)
bun run validate          # server + frontend typecheck, then the full test suite
bun run test:server       # server/tests/**, bun:test with server/tests/setup.ts preloaded
bun run test:frontend     # frontend/tests/**
```

Tests sit next to the code they cover (`server/tests/`, `frontend/tests/`). Gateway calls
are faked with the real response envelopes; keep it that way. Use `bun run test`, not a
bare `bun test` from a directory whose `bunfig.toml` you have not read.

## Pull requests

- One change per PR, small enough to review in one sitting. `main` is protected: the four
  CI jobs (Frontend typecheck + Next build, Server tests, Server typecheck, gitleaks) must
  be green, and PRs are squash-merged.
- Commit messages: `type(scope): what changed`, for example `fix(dex): reject zero-amount
  exits`.
- Keep the lockfiles committed and installs frozen; a dependency bump is its own PR.
- A comment that no longer matches the code is a bug. Fix or delete it in the same PR.
- Security findings go through [SECURITY.md](SECURITY.md), never an issue or a PR
  description.
