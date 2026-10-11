# Provenance

This public repository was cut on 2026-10-10 as **one squashed commit** from the private
repository `bigdevxrd/defi-farmer` at commit `7b31f7e6a355c8c0316885b958a2160452806e74` (142
commits, 2026-04 to 2026-10). The private repository is kept, never rewritten, as the
resolver for every commit SHA and PR number (`#46`, `#55`, and so on) cited in comments
and docs here.

## Why one commit

The private history carries operator-only material: deployment and host details, runbooks,
internal state and review documents, and commits under several author e-mail identities.
Rewriting that history would have broken every SHA reference in the project's own records,
so the public tree starts fresh instead. Real history accrues here from this commit on.

## What was left out

An exact-set allowlist decided what ships. Excluded: the internal status document and the
dated review and go-live documents, the operator's session notes, the deploy script, the
PM2 process file, the health cron, the token and dApp-definition rotation tooling with its
manifest templates, and agent-workflow scratch files. Nothing excluded changes how the code
here builds, tests or runs.

## What was changed for publication

Comments and docs that named private sibling systems were reworded, with no code path
changed; `license` fields were added to the three `package.json` files; the README,
STATE.md, CONTRIBUTING.md, a short CLAUDE.md and this file were written for the public
tree. This file is the only one whose text differs from the source commit: the date, SHA
and commit count above are stamped at export time.

## Identity

Every commit in this repository is authored and committed as
`bigdev <bigdevxrd@users.noreply.github.com>`.

## Checks run before publication

- `git ls-files` equals the export manifest.
- Raw grep for private-system names, home paths and host identifiers: 0 hits.
- gitleaks over the history and over the working tree: 0 findings.
- Typecheck, the full test suite and `next build` green in a cold clone.
