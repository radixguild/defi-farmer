# Leak gate

The `leak gate` check stops private material reaching this public repository.
Secret scanning (`secret-scan`) looks for credential shapes; this looks for identity and
private work.

## What it refuses

- Branches named `sdk-run/*` or `audit/*`, and merge commits that name one.
- Blocklisted terms, addresses and emails in added lines, file paths, commit identities and
  messages, and the PR title and body.
- Home-directory paths.
- New audit-shaped files (an audit directory, or a document with `audit`, `pentest` or
  `findings` in its name). Exceptions are `LEAK_GATE_AUDIT_ALLOW` in the workflow.
- On the maintainer's own PRs, a commit author or committer that is not a no-reply address and
  a known public handle.

It does not scan binary file contents, and it judges changes, not history already on `main`.

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
git fetch origin main pull/<N>/head
git show origin/main:.github/leak-gate.mjs > "$TMPDIR/leak-gate.mjs"
PII_BLOCKLIST_LOCAL_PATH=<private file> LEAK_GATE_HEAD=FETCH_HEAD node "$TMPDIR/leak-gate.mjs"
```

## Limits

- A check cannot undo a push: anything pushed to a branch or PR here is already public.
- A PR can edit this script or its workflow. Read any change to `.github/` before merging.
- The log names the file, line and rule, never the matched value.
