# Security policy

This repository is a non-custodial DeFi yield advisor for Radix: it reads public
on-chain and DEX state, scores yield opportunities net of impermanent loss, and builds
transaction manifests that the connected wallet's own user reviews and signs. The
server never holds a signing key, a vault, or custody of user funds — see the README
and `STATE.md`.

That changes what a security finding here looks like, but it doesn't remove the
category. A bug that gets a user to sign a manifest which does something other than
what the UI represents, a bug that exposes one wallet's data to another, or a bug that
lets a different origin impersonate this dApp to a connected wallet are all real harms,
even though the app itself never custodies anything.

## What counts as a finding here

Anything that could get a user to sign a manifest that does something other than what
they were shown, expose one wallet's data or session to another, grant operator-level
access without authorization, or let a different origin impersonate this dApp to a
wallet — specifically:

- The manifest-building and Gateway dry-run preview code that gates what a user is ever
  asked to sign (`server/src/services/dex/`, especially `preview.ts`, `build-service.ts`
  and the concentrated-math in `concentrated.ts`).
- The auth model — ROLA proof verification (`server/src/services/rola.ts`), the
  `farmer_session` cookie, and the operator/Bearer tier — anything that lets one wallet
  read or act on another wallet's rows, or reach operator-only control without being an
  authorized operator.
- The dApp-definition / origin-claim identity (`frontend/public/.well-known/radix.json`
  and the `claimed_websites` binding) — anything that could let another site impersonate
  this dApp to a wallet.
- The frontend wallet-connect and signing flow (`frontend/`) more generally.

## Reporting a security issue

**Do not open a public GitHub issue, and do not describe the finding in a commit
message, PR description, or anywhere else visible outside a private channel.** Use
GitHub's private vulnerability-reporting flow on this repository (Security tab →
Report a vulnerability) if it is enabled for you, or reach the maintainer (@bigdevxrd)
through whatever private channel you already have. If neither is available to you, a
GitHub issue that asks only for a private contact method — with no detail about the
finding itself — is a fine way to start that conversation.

Include what you found, the affected file(s) or endpoint, and, if you have one, a
reproduction. A local or Stokenet repro is strongly preferred over anything
demonstrated against the live deployment — see "What not to do" below.

If you are not sure whether something rises to this level, treat it as if it does until
it's been looked at. Coordinated disclosure costs nothing if the finding turns out to be
benign; the reverse mistake — a live issue discussed in public before it's fixed — is
not recoverable, and this is a single-operator project with no dedicated security team,
so there is no fast fallback if that happens.

## Expected response time

The maintainer will acknowledge a report within 5 business days and work a fix before
any public discussion. This is a single-operator project with no on-call rotation —
treat that number as a target, not a guarantee. There is no funded bug-bounty program;
reports are still welcome and handled the same way regardless of whether a reward is on
offer.

## What an external reporter should not do

- **Do not test against the live production deployment.** It is a real, deployed
  service that real wallets connect to; treat it like any other production system you
  don't own. Reproduce locally (`bun run dev`, `bun run agent` — see the README quick
  start) or against Stokenet instead.
- **Do not submit a real transaction — deposit, withdraw, or otherwise — against
  mainnet to demonstrate a finding.** A manifest or preview-gate bug can be shown by
  constructing and dry-run-previewing a manifest without ever signing or broadcasting
  it; this app's own preview gate and the public Radix Gateway `/transaction/preview`
  endpoint both do that for free.
- **Do not attempt to access, enumerate, or modify another wallet's session or
  positions** on the live deployment.
- **Do not disclose publicly** — including in this repo's issues or PRs — before the
  maintainer has had a chance to address the report.

## What this policy does not cover

General usage questions, feature requests, yield-scoring or strategy disagreements, and
non-security bugs in the app, the CI, or the docs are fine as a public issue.
