Draft from the repository contents; not yet run end to end from a clean machine.

# Deploy and rollback

This is the deploy path the repository itself defines: its `package.json` scripts, its
config and its health routes. The reference deployment's own tooling (deploy script,
process-manager file, health cron) is not part of this repository
([PROVENANCE.md](../PROVENANCE.md), "What was left out"). Where a step lives only in that
kind of tooling, it is marked **operator step, not in this repo**, with what it must
achieve.

Placeholders: `<host>` the machine, `<app-dir>` the checkout on it, `<domain>` the public
origin, `<api-port>` the agent's port (`API_PORT`, default `3001`), `<web-port>` the dapp's
port.

## What runs

Two processes on one machine, both bound to loopback, behind a TLS-terminating reverse
proxy ([README](../README.md#running-it-in-production)):

| Process | Started with (from `<app-dir>`) | Script |
|---|---|---|
| Agent and API | `bun run agent:start` | `package.json:13` → `server/package.json:9` (`bun run src/index.ts`) |
| Dapp | `cd frontend && bun run start` | `frontend/package.json:9` (`next start`) |

The agent has no build step: Bun runs the TypeScript source. The dapp must be built first.
The agent's working directory is `server/` (`package.json:13`), so the relative defaults
`DB_PATH=./data/defi-farmer.db` and `CRASH_LOG_DIR=./logs` resolve under `server/`
(unverified on a deployed machine).

## 1. Prerequisites on `<host>`

- Bun 1.3.12 and Node 20.9 or newer ([README](../README.md#quick-start), `ci.yml:28`).
- **Operator step, not in this repo:** a reverse proxy that terminates TLS for `<domain>`
  and forwards to the dapp on `127.0.0.1:<web-port>`. The API stays on loopback; the dapp
  reaches it through its `/api/*` proxy (`frontend/app/api/[...path]/route.ts`). The
  reference deployment uses Caddy; its config is not in this repo.
- **Operator step, not in this repo:** a process manager that starts the two processes
  above, restarts them on exit and keeps their logs. `server/src/crash-guard.ts` writes
  uncaught errors to `CRASH_LOG_DIR` but does not restart anything.

## 2. Before you deploy

- **Operator step, not in this repo:** write down the commit the machine runs now. That is
  the rollback target. [STATE.md](../STATE.md) records that the live commit has not been
  recorded so far.
- **Operator step, not in this repo:** copy the SQLite file (`DB_PATH`) and the env files
  aside. The repo has no backup command.

## 3. Environment

Every name, default and secret/public class: [CONFIG.md](CONFIG.md). For a production
deployment, from the code and the README:

- Agent: `API_AUTH_TOKEN` (required, secret); `TRUST_PROXY=true` and
  `SESSION_COOKIE_SECURE=true` behind the proxy; `ROLA_EXPECTED_ORIGIN` equal to
  `https://<domain>`; `DAPP_DEFINITION_ADDRESS` equal to the account in
  `frontend/public/.well-known/radix.json`, and that origin listed in the dApp
  definition's on-chain `claimed_websites` ([README](../README.md#running-it-in-production)).
  `OPERATOR_ADDRESSES` if a wallet should reach the operator panels.
- Agent: the `DEX_PACKAGES_*` lines. **Operator step, not in this repo:** set them in the
  agent's environment. The values verified so far are recorded in
  [DEX-INTEGRATION.md](DEX-INTEGRATION.md#do-not-trust-the-scanner-registry--resolve-blueprint-per-component-at-runtime);
  without them only the two packages pinned in code are accepted and every other pool is
  unsupported. A malformed value stops the agent at startup (`server/src/config.ts:71-73`).
- Agent, optional: `DEX_DEPOSITS_DISABLED_KINDS` / `DEX_DEPOSITS_DENY_POOLS` to keep
  deposits paused ([Pausing deposits](DEX-INTEGRATION.md#pausing-deposits-operator-switch)).
- Dapp, runtime: `BACKEND_API_URL=http://127.0.0.1:<api-port>` and
  `ALLOW_LOOPBACK_BACKEND=true`. Without the second, a loopback backend is refused in
  production and every `/api/*` call answers 503
  (`frontend/lib/server/proxy-guard.ts:75-84`, `route.ts:55-58`).
- Dapp, build time: every `NEXT_PUBLIC_*` value must be in place **before** the build step;
  they are inlined into the bundle (`frontend/lib/gift/index.ts:46-49`).
- **Operator step, not in this repo:** decide where each process reads its environment
  from. The quick start uses `.env` at the repo root and `frontend/.env.local`
  ([README](../README.md#quick-start)); DEX-INTEGRATION.md refers to `<deploy-root>/.env`.
  Which file the agent actually loads depends on how the process is started (working
  directory `server/`); confirm it with the startup log in step 6.

## 4. Build

From `<app-dir>`, on the commit to deploy:

```bash
bun install --frozen-lockfile
(cd server && bun install --frozen-lockfile)
(cd frontend && bun install --frozen-lockfile)
bun run validate          # server + frontend typecheck, then the full test suite
bun run build             # cd frontend && bunx next build
```

`--frozen-lockfile` is what CI runs (`.github/workflows/ci.yml:29,55,71`). `bun run validate`
and `bun run build` are `package.json:19` and `:10`. Stop if either fails.

## 5. Database

There is no separate migration command. On startup the agent opens `DB_PATH` (creating the
directory if needed) and applies the schema: `CREATE TABLE IF NOT EXISTS` plus a list of
`ALTER TABLE … ADD COLUMN` statements whose errors are all ignored, on the assumption that
the column already exists (`server/src/db/schema.ts:18-178`, `:163-169`, `:180-186`). Every schema change in the code today is
additive.

## 6. Restart and verify

**Operator step, not in this repo:** restart both processes through the process manager.

Then check, in order:

1. Agent log at startup (`server/src/index.ts:12-25`, `crash-guard.ts:88`):
   `[crash-guard] Installed …`, `[config] Configuration validated …`,
   `[db] Database initialized`. If a deposit switch is set, also
   `[deposit-switch] deposits paused — …`, or `[deposit-switch] INVALID …` for a bad value
   (`server/src/services/dex/deposit-switch.ts:88-105`).
2. `GET http://127.0.0.1:<api-port>/api/health` on `<host>` returns `{"status":"ok"}`
   (`server/src/api.ts:367-368`).
3. `GET https://<domain>/api/health` returns the same through the dapp's proxy. A 503 with
   `Server misconfigured` means `BACKEND_API_URL` / `ALLOW_LOOPBACK_BACKEND` (step 3).
4. `GET https://<domain>/api/status` answers; it carries a `sources` block on code that
   includes #12 ([STATE.md](../STATE.md), "Now").
5. Pages load: `https://<domain>/`, `/discover`, `/yields` (`frontend/app/*/page.tsx`).
6. `https://<domain>/.well-known/radix.json` loads and names the same dApp definition
   account as `DAPP_DEFINITION_ADDRESS`.
7. If a deposit switch is set, read it back as in
   [Pausing deposits](DEX-INTEGRATION.md#pausing-deposits-operator-switch) ("Check it").

**Operator step, not in this repo:** record the deployed commit (for example in
[STATE.md](../STATE.md)).

## Rollback to the previous build

If a check in step 6 fails, or the new build misbehaves:

1. To stop new deposits only, while exits keep working, the deposit switch may be enough
   and needs only an agent restart
   ([Pausing deposits](DEX-INTEGRATION.md#pausing-deposits-operator-switch)). It covers LP
   pool kinds, not native staking.
2. **Operator step, not in this repo:** put the tree back to the commit recorded in step 2.
3. Restore the env files saved in step 2 if they changed.
4. Re-run step 4 (install, validate, build) on that commit. The dapp build in
   `frontend/.next` belongs to the commit it was built from; `NEXT_PUBLIC_*` values are
   baked into it.
5. Restart both processes and run step 6 again.
6. Database: the schema changes are additive, so the previous code should still open the
   newer file (unverified). Restore the copy from step 2 only if the data itself is wrong;
   rows written since the copy are lost.
