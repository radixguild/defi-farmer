# Leak gate

The `leak gate` check looks for private material in changes to this public repository.
Secret scanning (`secret-scan`) looks for credential shapes; this looks for identity and
private work.

## What it refuses

- Branches whose name starts with `sdk-run/` or `audit/`, and merge commits that name one.
- Blocklisted terms, addresses and emails in added lines, file paths, commit identities and
  messages, and the PR title and body.
- macOS home-directory paths (the `Users` form, and its dash-mangled project-folder form).
  Linux and Windows home paths are not checked.
- New audit-shaped files (an audit directory, or a document with `audit`, `pentest` or
  `findings` in its name). Exceptions are `LEAK_GATE_AUDIT_ALLOW` in the workflow.
- On the maintainer's own PRs, a commit author or committer that is not a no-reply address and
  a known public handle.

It judges changes, not history already on `main`. File bytes are read as UTF-8, so compressed
or UTF-16 content will not match. It runs on pull requests and on pushes to `main`,
`sdk-run/**` and `audit/**`: other branches are not checked until a pull request opens, and
tags and pull request comments are not checked.

## The blocklist

It is private and is never committed here, in plain or hashed form. It is supplied as the
`PII_BLOCKLIST_JSON` secret:

```json
{ "entries": [ { "category": "phrase", "len": 12, "sha256": "<hex>" } ] }
```

Categories are `ipv4`, `email`, `phrase` and `chain-address`. The hash is SHA-256 of the
trimmed, lower-cased value (a phrase also has its whitespace collapsed; `len` is its length
after that).

The secret must be set twice: as an Actions secret and as a Dependabot secret. Without it the
check fails on every pushed branch and same-repository PR.

## Pull requests from forks

GitHub gives fork PRs no secrets. The branch, path and home-directory rules still run, the
blocklist does not, and the check **passes with a warning**. Before merging a fork PR a
maintainer runs the blocklist layer with the copy of the script from `main`, never the PR's:

```bash
git fetch origin main +pull/<N>/head:refs/remotes/pr/<N>
git show origin/main:.github/leak-gate.mjs > "$TMPDIR/leak-gate.mjs"
PII_BLOCKLIST_LOCAL_PATH=<private file> LEAK_GATE_HEAD=refs/remotes/pr/<N> node "$TMPDIR/leak-gate.mjs"
```

Check that the output says it judged at least one commit. If the workflow sets
`LEAK_GATE_AUDIT_ALLOW`, set the same value. This local run does not check the pull request's
title, body, branch name or commit identity rule: read those yourself.

## Limits

- A check cannot undo a push: anything pushed to a branch or PR here is already public.
- The commit identity rule runs on same-repository PRs only, not on pushes to `main`. A squash
  or direct push there is checked against the blocklist only.
- `[skip ci]` in a commit message skips the push run.
- Dependabot PR titles and bodies skip the home-path rule (they quote upstream notes).
- A PR can edit this script or its workflow. Read any change to `.github/` before merging.
- The log names the file, line and rule, not the matched value. A file name that itself
  matches is withheld.
