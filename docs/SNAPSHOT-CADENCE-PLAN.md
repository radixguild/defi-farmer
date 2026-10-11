# Snapshot cadence fix — plan

> **Partly executed.** Phases 1–3 shipped 2026-07-25 (#26/#27) and are live: writes are
> throttled to hourly and the retention sweep runs daily. **Phases 4 (re-measure the index)
> and 5 (batched delete + `VACUUM`) are still open** — the live DB was still 765 MB on
> 2026-08-02. Status: [STATE.md](../STATE.md). The measurements below are from
> 2026-07-25, before the fix.

The agent persists one row per pool **per minute** to both `pool_snapshots` and
`pool_scores`, but every reader in the codebase assumes **hourly**. That single
mismatch causes three separate defects. This is the plan to fix it.

Measured on the live VPS DB (`<deploy-root>/data/defi-farmer.db`, 2026-07-25,
read-only) — not estimated.

## The mismatch

`SCAN_INTERVAL_MS=60000` drives `tick()`, which calls `logSnapshots()` then
`logScores()` on every pass (`server/src/agent/loop.ts:171,174`). With 54 pools
that is **77,760 rows/day into each table**.

Every consumer assumes an hourly row:

| Reader | Window it wants | What it gets at 1-min rows |
|---|---|---|
| `api.ts:453` snapshots endpoint | `LIMIT 168` (= 7 days hourly) | 168 minutes = **2.8 hours** |
| `opportunity/[address]/page.tsx:129` | `hoursToShow` 168 (7d) / 720 (30d) | 2.8 h for *both* — backend caps at 168 |
| `scorer.ts:147` `computeApyMa7d` | 7 days | correct, but averages 10,080 points instead of 168 |
| `rotation.ts:73` TVL change | 1 day | correct |

## The three defects

**1. The APY chart is wrong.** The "7d" and "30d" ranges both render under three
hours of data, and the x-axis is formatted date-only, so it plots the same date
repeatedly. This is a live user-facing bug, not just waste.

**2. Unbounded growth.** 756 MB today, ~97% of which no query reads:

| | rows | dead rows | table | index |
|---|---|---|---|---|
| `pool_snapshots` | 1,372,680 | 828,738 (older than the 7-day max lookback) | 246 MB | 142 MB |
| `pool_scores` | 1,372,788 | 1,372,734 (**only the latest 54 are ever read**) | 189 MB | 144 MB |

All three `pool_scores` readers are latest-only (`api.ts:361`, `:421`, `:434`):
one finds `MAX(computed_at)`, the others select rows matching it. Nothing reads
score history.

**3. Endpoint latency that scales with the bloat.** Neither index leads with the
time column (`idx_pool_scores_addr` is `(pool_address, computed_at)`), so
`SELECT computed_at FROM pool_scores ORDER BY computed_at DESC LIMIT 1` scans all
1.37M rows into a temp B-tree. Measured **0.22 s**, against **0.44 s** for the
whole `/api/opportunities` request — roughly half the endpoint's time, growing
linearly.

There is already precedent for this reasoning in the codebase: `checkRebalance`
(`loop.ts:~296`) deliberately does *not* write to `agent_log` because "a standing
opportunity would append an identical row every tick, and nothing reads those
rows — unbounded growth with no consumer." Phase 4 applied that to `agent_log`
and missed these two tables.

## Phase 1 — throttle the writes

Add `SNAPSHOT_INTERVAL_MS` (default `3600000`, 1 h) to `config.ts` + `.env.example`.
Gate persistence — **not computation** — on it.

- `scored = this.scorer.scoreAll(...)` must still run every tick: `scored` feeds
  exit guards and rotation downstream in the same `tickInner()`. Only the two
  `INSERT` loops are throttled.
- Track `lastPersistAt` in agent state, seeded **once at startup**. Do NOT check
  the DB per tick: `SELECT MAX(scanned_at) FROM pool_snapshots` measured **0.17 s**
  because no index leads with the time column. Seeding once makes restarts cheap
  and stops a crashloop from writing a row per restart.
- **Cold-start caveat:** `computeTvlVariance` returns 0 with fewer than 2 rows,
  which reads as perfect stability. At 1-min writes a new pool clears that in two
  minutes; at hourly it takes two hours, so a newly-discovered pool scores
  slightly optimistically for that window. Mitigation if we care: keep an
  in-memory set of seen pool addresses and always write the first snapshot for a
  pool regardless of the throttle. `computeApyMa7d` needs no mitigation — with
  zero rows it returns the live `pool.apy` (`scorer.ts:156`).

**Acceptance:** one row per pool per hour in both tables; `scored` still computed
every tick (assert exit guards/rotation still fire per-tick in tests); restart
does not produce an extra row.

## Phase 2 — fix the chart window

- `api.ts:453`: raise/parameterise `LIMIT 168` so the 30-day range can actually
  return 720 rows.
- `opportunity/[address]/page.tsx:129`: `hoursToShow` is already 168/720 and
  becomes correct once rows are hourly — verify rather than change.
- Same file, x-axis label: include time, or thin the ticks. At hourly, date-only
  formatting yields 24 identical labels per day.

**Acceptance:** the 7d range shows 7 days and the 30d range shows 30 days, with
readable axis labels.

## Phase 3 — retention that actually runs

`pruneOldData` (`services/data-tracker.ts:307`) looks like it already solves this.
It does not: it targets `pool_snapshots_v2`, **a table that does not exist in the
live DB**, and it is called only from `tests/data-tracker.test.ts`. It needs
rewriting, not wiring.

- Retarget it at `pool_snapshots` and `pool_scores`.
- Retention must exceed the longest lookback in the code (7 days) with margin —
  default **30 days**, exposed as `SNAPSHOT_RETENTION_DAYS`.
- Call it on a daily cadence from the agent loop.
- Tests: deletes beyond the window, preserves everything inside it, and is a
  no-op on an empty table.

**Steady state after Phases 1+3:** 54 × 24 × 30 = **38,880 rows/table** ≈ **20 MB
total**, versus 756 MB today.

## Phase 4 — re-measure the index question

At ~39k rows the 0.22 s latest-batch scan should fall to single-digit ms, making
a time-leading index unnecessary. **Re-measure after Phase 3 before adding one** —
an index we do not need is just more write cost.

## Phase 5 — one-off reclaim (operator)

Deleting rows does not shrink the file; SQLite frees pages for reuse but only
`VACUUM` rebuilds it. Requires ~2× free space transiently (~1.5 GB against 43 GB
free) and locks the DB for the rebuild.

1. **Back up the DB first** — do not assume the host's own backups are current.
2. Stop the server process (the app can stay up; it only reads).
3. Delete beyond retention **in batches** — a single 1.3M-row `DELETE` builds one
   huge transaction and a very large WAL.
4. `VACUUM`.
5. Start the server process again, confirm `/api/health` and that a scan writes.

**Acceptance:** DB ≈ 20 MB, `/api/opportunities` well under 0.44 s, agent writing
one row per pool per hour.

## Sequencing

The non-custodial pivot (#24) is **merged but not deployed** — the VPS still runs
vault-era code. Recommended order:

1. Deploy the pivot on its own, confirm healthy (it is a large behavioural change
   and deserves a clean observation window).
2. Ship Phases 1–3 as one PR.
3. Then Phase 5, with the agent stopped.

Stacking a data-lifecycle change on top of an undeployed architectural pivot
would make any regression ambiguous. The extra days of growth are immaterial
(~78k rows/day against 1.37M already there).

## Risks

- **7-day MA quality:** 168 hourly points instead of 10,080 per-minute ones. For
  a 7-day average this is statistically indistinguishable and far less noisy.
- **`rotation.ts` 1-day lookback** needs ≥1 row in the last day; hourly gives 24.
- **Cold-start variance optimism** — see Phase 1.
- **`VACUUM` lock** — do it with the agent stopped; it is the only step that
  needs a window.
