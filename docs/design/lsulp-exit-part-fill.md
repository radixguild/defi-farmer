# LSULP exit part-fill: design note

Status: proposal, awaiting owner ruling. Money path (exit manifests and the sign gate).
Date: 2026-11-07. Code at `main` 84f70ed.

## Problem

An LSULP exit calls the CaviarNine LSU pool `remove_liquidity(lsulp, target_lsu, None)`. The caller
names the validator LSU to be paid in (`pickLsulpValidator`, `build-service.ts`). If the pool's main
vault for that LSU holds less than the exit owes, the pool does **not** panic. It pays what it has and
returns the unfilled LSULP to the caller, and the Gateway dry-run reports `Succeeded`.

Consequences:
- The sign gate (`previewManifest`, `ok === (status === 'Succeeded')`) passes a transaction that does
  less than the user asked for. This is the "valid-but-wrong" class CONTRIBUTING.md rule 2 warns about.
- No funds are lost: the unfilled LSULP is swept back by `deposit_batch`.
- With `exitTo='xrd'` the chained `unstake` covers only the part-filled LSU, so the user starts far less
  unbonding than requested, and nothing in the UI says so.
- Two code comments claimed the opposite (the dry-run fails). Both are corrected in this PR.

Exposure today: zero known users. Per the maintenance write-up the picked LSU has about 554k LSU of
main-vault depth, so only a very large exit (order of 554k LSULP) would hit it.

## Evidence

From the 2026-11-06 maintenance write-up (public Gateway, 2026-11-05 ~22:15 UTC, epoch 355865, preview
only; NOT re-run for this note, see "Unknown"):
- `remove_liquidity(500 LSULP, target=<an LSU the pool was short of>, None)` returned `Succeeded`.
  The caller received 1.9225 LSU **plus 498.0686 LSULP back**. The pool's main vault for that LSU held
  exactly 1.923893 LSU. The reserve vault (6313 LSU) is not used for exits.

Re-verified read-only for this note (mainnet Gateway, `state_version` 567836947, 2026-11-07T00:42:26Z,
epoch 356182):
- Pool `component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp`, `vaults` KVS
  `internal_keyvaluestore_rdx1kpsclrglzaenllnq5ad9epurwax5wfd98gg72mkmq96czky9zu9k3z`: 82 LSU entries.
- The LSU the picker uses (`resource_rdx1thuy5j23qjskmqjq2700am2w63yn47daplvvhnw6ece3y02ft3aske`, vault
  `internal_vault_rdx1tqglpl4hgle0vjeskmzhq7pg7humylg4aqs3cw0j4era5r4248ph5s`) holds
  **554,764.287 LSU**, matching the write-up's 554,764.
- The deepest vaults hold 4.8M to 5.8M LSU each, roughly 10x the picked one. So choosing the exit LSU by
  depth would raise the ceiling a lot today.
- Pool `dex_valuation_xrd` at that state version: 116,983,152 XRD (context only).

## Options

### A. Sign gate refuses a preview that returns LSULP (recommended, implemented here)

After the dry-run of an LSULP exit, require the account's NET LSULP movement to equal `-amount`.
Any LSULP coming back means a part-fill: the preview is converted to `ok:false, status:'Refused'`
with a user-facing reason that names the returned amount. Applies to `exitTo` 'lsu' and 'xrd'.

Why: it checks the actual ledger result, so it does not depend on our reading of pool state, still
works if depth moves between build and sign, and also covers any other cause of a partial fill. It is a
few lines in the existing gate, local to the exit path, and fail-closed.

Failure modes:
- Over-refusal: a user above the depth threshold gets a refusal, not a part-fill, and no automatic
  alternative. They must exit in smaller parts (which also depletes the same vault) or wait.
- If the pool ever returns LSULP dust on a legitimate full fill, that exit would be refused. Not
  observed; unknown. Chosen on purpose as fail-closed.
- The modal heading still reads "The ledger rejected this transaction in dry-run" for a refusal; the
  specific reason is shown beneath it. Frontend copy not changed (kept small).

### B. Pick the exit LSU by pool main-vault depth

Read the `vaults` KVS balances and choose a validator whose LSU depth covers the exit.

Failure modes:
- It is a prediction, not a check. Depth can change between build and sign, so it still needs A as the
  backstop; it is not an alternative to A.
- Units: depth is in LSU, the request in LSULP. The conversion (pool price) is unverified here, so the
  threshold could be mis-set; the write-up's 554k figure treats them roughly 1:1 (inferred).
- Extra Gateway reads per build (82 vaults), plus new code and mocks on a money path.
- For `exitTo='xrd'` the unstake validator changes from the deposit-side pick, with a different Stake
  Claim NFT. The exit would still be one transaction, but that is a behaviour change.
- An exit larger than any single vault would need several `remove_liquidity` calls; not verified.

## Recommendation

Ship A now. It removes the silent under-fill and costs nothing for any exit that fills fully. Treat B as
a later usability improvement (so large exits succeed instead of being refused), to be designed with the
LSULP to LSU conversion verified against mainnet and with A kept as the gate.

## Unknown

- The original 500 LSULP preview was not re-run: it needs a preview-only `from` account holding LSULP,
  and this note does not use or name a third-party account. Only the vault depth was re-verified.
- LSULP to LSU conversion at exit, hence the exact LSULP size at which today's picked LSU runs short
  (approx 554k per the write-up, inferred).
- Whether a full fill ever returns residual LSULP.
- Whether a chained `unstake` after a part-fill behaves differently on the ledger than in the preview
  (only the preview was observed).
