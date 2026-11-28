# Deploy and rollback

## What has run, and when

| Step | Status |
|---|---|
| 2. Before you deploy: copy the database | Run on 2026-11-19, before the `8934fd2` deploy |
| 2. Before you deploy: read `DEPLOYED_COMMIT`, range check | Not yet run. The marker did not exist before the `8934fd2` deploy; a read before the `16b35b6` deploy is not recorded |
| 4. Ship and build (sync `server/` and `frontend/`, frozen installs, dapp build) | Run on 2026-11-19, for `8934fd2` and then `16b35b6` |
| 6. Restart, verify, write `DEPLOYED_COMMIT` | Run on 2026-11-19: local health of both processes, `/api/status`, `/yields`, the deposit-switch read-back, the marker written. Checks 1, 3, 5 and 6 are not recorded. The marker was read again on 2026-11-24 ([STATE.md](../STATE.md)) |
| Rollback | Not yet run |
| 1. Prerequisites on a clean machine (runtime, proxy, process manager) | Not yet run from this page. The host was set up before this page existed |

[STATE.md](../STATE.md) records the commit the live site runs and what is switched off.
This page does not change any of that.

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

Two processes on one machine, behind a TLS-terminating reverse proxy
([README](../README.md#running-it-in-production)):

| Process | Started with (from `<app-dir>`) | Script |
|---|---|---|
| Agent and API | `bun run agent:start` | `package.json:13` → `server/package.json:9` (`bun run src/index.ts`) |
| Dapp | `cd frontend && bunx next start -H 127.0.0.1 -p <web-port>` | `frontend/package.json:9` is plain `next start`, with no host or port of its own |

The agent binds loopback by default (`API_HOST`, `server/src/config.ts:124`). Nothing in
this repo binds the dapp: pass `-H 127.0.0.1 -p <web-port>` as above so that only the
proxy can reach it. Started as plain `next start`, Next's documented defaults apply (all
interfaces, port 3000; not run here).

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

- Read `<app-dir>/DEPLOYED_COMMIT` on `<host>` (written at the end of step 6) and compare it
  with the commit [STATE.md](../STATE.md) records. Write it down: it is the rollback target.
  If they differ, find out why before you go on.
- List what changed between that commit and the one you deploy (`git log`, `git diff --stat`).
  Note any change outside `server/` and `frontend/` (see step 4), any change to
  `server/src/db/schema.ts` (step 5), and any new or changed name in
  [CONFIG.md](CONFIG.md) (step 3).
- The commit you deploy should be on `main` with CI green. Check it on GitHub.
- **Operator step, not in this repo:** stop the agent, then copy the SQLite file
  (`DB_PATH`), its `-wal` and `-shm` files if they exist, and the env files aside. The
  database runs in WAL mode (`server/src/db/schema.ts:19`), so a copy of the `.db` file
  alone, taken while the agent is running, can miss committed rows. To copy without
  stopping the agent, use SQLite's own online backup (`sqlite3 <db-file> ".backup
  <copy>"`; not run here). The repo has no backup command.

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

## 4. Ship and build

This is the route the 2026-11-19 deploys used. It copies two folders from a clean checkout
into `<app-dir>`; it does not run `git` on `<host>`.

**Do not use the older deploy script.** An operator deploy script from before this repository
was published is not part of this tree ([PROVENANCE.md](../PROVENANCE.md), "What was left
out"). It syncs, with deletion, a process-manager file and a `scripts/` folder, and this tree
has neither. Run against this tree it would stop halfway, or delete the host's own
operator scripts in `<app-dir>/scripts/`. Use the steps below instead.

1. On a machine other than `<host>`, make a clean checkout of `<commit>`.
   `git status --porcelain` must print nothing. Write down `git rev-parse <commit>^{tree}`,
   so you can show later which tree you shipped.
2. Sync `server/` and `frontend/` from that checkout into `<app-dir>/server/` and
   `<app-dir>/frontend/`, deleting files that no longer exist upstream, and excluding what
   lives only on the host:
   - from `server/`: `node_modules/`, `data/`, `logs/`, `.env*`;
   - from `frontend/`: `node_modules/`, `.next/`, `.env*`.

   Run the sync as a dry run first (with `rsync`: `-n -i` on the same command line) and read
   the list of files it would change or delete. Stop if it would touch the database, an env
   file or anything outside those two folders. With `rsync` on macOS, write each exclude on
   the command line; do not pass them through a shell variable.
3. Root files (`package.json`, `bun.lock`, `bunfig.toml`) are not synced by this route. If
   the range changes one of them, copy it as well (not run on 2026-11-19). The root
   dependencies are development-only (`typescript`), and `agent:start` and `build` change
   into the subfolders (`package.json:10,13`), so the deploy does not install them.
4. On `<host>`, from `<app-dir>`:

   ```bash
   (cd server && bun install --frozen-lockfile)
   (cd frontend && bun install --frozen-lockfile)
   (cd frontend && bunx next build)
   ```

   `--frozen-lockfile` is what CI runs (`.github/workflows/ci.yml:29,55,71`); the build is
   `package.json:10`. Stop if either fails. The running processes keep serving until step 6,
   but the dapp process now runs beside a rebuilt `frontend/.next`, so restart soon after.

The full test suite (`bun run validate`, `package.json:19`) is CI's merge gate. Running it on
`<host>` is optional; the 2026-11-19 record does not show a run there.

## 5. Database

There is no separate migration command. On startup the agent opens `DB_PATH` (creating the
directory if needed) and applies the schema: `CREATE TABLE IF NOT EXISTS` plus a list of
`ALTER TABLE … ADD COLUMN` statements whose errors are all ignored, on the assumption that
the column already exists (`server/src/db/schema.ts:18-178`, `:163-169`, `:180-186`). Every schema change in the code today is
additive.

## 6. Restart and verify

**Operator step, not in this repo:** stop the agent, copy the database (step 2), then start
or restart both processes through the process manager, and save its process list so the same
processes come back after a reboot.

If you changed the agent's environment for this deploy: a process manager that saves each
process's environment (pm2 does) can keep serving the old values from its saved copy, even
after a restart. On 2026-11-19 the agent process was deleted from the process manager and
started again, then the list was saved. Confirm the new values with the startup log below.

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

8. Write the full deployed commit to `<app-dir>/DEPLOYED_COMMIT` on `<host>`, and read it
   back. The sync in step 4 copies no `.git` folder, so this file is the only record on the
   host of which commit runs.
9. Record the deployed commit and date in [STATE.md](../STATE.md) in a follow-up pull
   request.

## Rollback to the previous build

Not yet run. If a check in step 6 fails, or the new build misbehaves:

1. To stop new deposits only, while exits keep working, the deposit switch may be enough
   and needs only an agent restart
   ([Pausing deposits](DEX-INTEGRATION.md#pausing-deposits-operator-switch)). It covers LP
   pool kinds, not native staking.
2. Redeploy the previous commit, the one you read from `DEPLOYED_COMMIT` in step 2: run
   step 4 with a clean checkout of that commit (same sync, same excludes, dry run first).
   The dapp build in `frontend/.next` belongs to the commit it was built from;
   `NEXT_PUBLIC_*` values are baked into it, so rebuild it.
3. Restore the env files saved in step 2 if they changed, and mind the saved process
   environment (step 6).
4. Restart both processes, run step 6 again, and write the previous commit to
   `DEPLOYED_COMMIT`.
5. Record the rollback in [STATE.md](../STATE.md) in a follow-up pull request.
6. Database: the schema changes are additive, so the previous code should still open the
   newer file (unverified). Restore the copy from step 2 only if the data itself is wrong,
   with the agent stopped, replacing the `.db` file and any `-wal` / `-shm` files beside
   it; rows written since the copy are lost.

What survives a rollback: the database (every row written since the deploy, unless you
restore the copy), the env files (a code rollback does not touch them), and anything on the
ledger. The app holds no key and signs nothing, so there is no on-ledger action of its own to
undo. In-memory state of the two processes is lost on any restart, rollback or not.
