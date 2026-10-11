/**
 * gift.ts — Gift destinations and the hard guard that keeps them dark.
 *
 * PORTED from the Guild app (radixguild/guild: guild-app/src/lib/gift.ts),
 * which is upstream. Two deliberate differences, both narrowing:
 *   - Two rails, not four. Stripe and PayPal are NOT supported here: the
 *     ecosystem decision is crypto rails only, and a validator with no UI
 *     behind it would be a silent trap ("I set the URL and nothing rendered").
 *     If a fiat rail is ever wanted, port the link-out guard from upstream
 *     TOGETHER with its card — never one without the other.
 *   - No send-from-connected-wallet control, so the XRD amount helpers
 *     (XRD_PRESETS / isSendableXrdAmount / formatXrdAmountForDisplay) are not
 *     ported. This app shows an address and a QR; the donor sends from their
 *     own wallet, same as the BTC rail. Adding a send control here means
 *     building a manifest, and this app's rule is that every manifest is
 *     Gateway-dry-run preview-gated (see CLAUDE.md) — that is a real lane,
 *     not a component tweak.
 *
 * ── THE GUARD ────────────────────────────────────────────────────────────
 * Every destination is supplied by bigdev via env. Nothing sendable renders
 * until one is configured AND validates, per rail, independently.
 *
 * There is deliberately NO separate NEXT_PUBLIC_FEATURE_GIFT flag. Gate a
 * surface on an env var only when the var's presence genuinely IS the
 * condition the surface depends on. Here it exactly is — no address means
 * there is nowhere to send — so "configured" and "live" are one truth
 * condition that cannot drift. A second flag could only disagree with reality.
 *
 * INVALID IS TREATED AS UNSET. A malformed destination goes dark rather than
 * rendering something sendable, because the failure modes are not symmetric:
 * a dark rail collects no gifts, a wrong rail eats them. Set-but-rejected is
 * loud (see the warning below) so a typo shows up at build time on the VPS
 * instead of looking like "the page just doesn't work".
 *
 * NEVER hard-code a destination here. Nothing in this file may invent an
 * address — an unset rail is dark, full stop, and a placeholder shown as real
 * is the exact bug this module exists to prevent.
 */

import { validateBtcMainnetAddress } from "./btc-address";
import { verifyBech32 } from "./bech32";

export type GiftRail = "xrd" | "btc";

/**
 * Read as static literals, never process.env[key] — Next inlines
 * NEXT_PUBLIC_* at build time only for statically analyzable references, and a
 * dynamic lookup would silently produce undefined in the browser bundle (i.e.
 * a rail that works on the server and is dark on the client).
 */
const RAW: Record<GiftRail, string> = {
  xrd: process.env.NEXT_PUBLIC_GIFT_XRD_ADDRESS || "",
  btc: process.env.NEXT_PUBLIC_GIFT_BTC_ADDRESS || "",
};

export type Validation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Addresses that are perfectly well-formed and must never receive a gift.
 *
 * A checksum proves an address is not a typo. It cannot prove it is the
 * account you MEANT — and both of these are valid, live, 66-character mainnet
 * accounts that can still turn up in the ecosystem's repos and docs, which is
 * exactly what makes them plausible copy-paste mistakes into a gift env var.
 *
 * Denying at validation, not in review, is deliberate: the guard already
 * treats invalid as unset, so a mistake here goes dark and loud instead of
 * quietly collecting other people's money into an unspendable account.
 *
 * Ported from the upstream Guild app named in the header, which carries the
 * same list, as do the sibling apps. Add an entry in all of them or the apps
 * disagree about what is a valid destination.
 */
export const FORBIDDEN_XRD_DESTINATIONS: Record<string, string> = {
  // Retired; holds no authority (verified on-chain 2026-10-11). Never use.
  "account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx":
    "is a retired account that holds no authority and must never be used, " +
    "so a gift sent there would be unrecoverable",
  // Orphaned old dApp definition: no key exists for it.
  "account_rdx128y6j78mt0aqv6372evz28hrxp8mn06ccddkr7xppc88hyvynvjdwr":
    "is an orphaned old dApp definition with no key, so anything sent to it " +
    "is unrecoverable",
};

/**
 * Radix account address: bech32m-checksummed, so a single mistyped character
 * is caught rather than merely shape-matched. Length is pinned at 66 (the
 * Babylon account form) — the checksum is the real check, the length just
 * rejects a component_/resource_ address pasted into the account slot.
 */
function validateXrdAccount(addr: string): Validation {
  if (addr !== addr.trim()) return { ok: false, reason: "has leading or trailing whitespace" };
  if (!addr.startsWith("account_rdx1")) {
    return { ok: false, reason: 'must be a Radix mainnet account address (starts with "account_rdx1")' };
  }
  if (addr.length !== 66) {
    return { ok: false, reason: `is ${addr.length} characters, expected 66` };
  }
  const decoded = verifyBech32(addr);
  if (!decoded || decoded.encoding !== "bech32m") {
    return { ok: false, reason: "failed the bech32m checksum — check for a typo" };
  }
  if (decoded.hrp !== "account_rdx") {
    return { ok: false, reason: `has human-readable part "${decoded.hrp}", expected "account_rdx"` };
  }
  const forbidden = FORBIDDEN_XRD_DESTINATIONS[addr];
  if (forbidden) return { ok: false, reason: forbidden };
  return { ok: true, value: addr };
}

function validateBtc(addr: string): Validation {
  const r = validateBtcMainnetAddress(addr);
  return r.ok ? { ok: true, value: addr } : { ok: false, reason: r.reason };
}

const VALIDATORS: Record<GiftRail, (v: string) => Validation> = {
  xrd: validateXrdAccount,
  btc: validateBtc,
};

/**
 * The guard itself, as a pure function of (rail, raw string).
 *
 * Exported so the accept/reject rules can be tested against arbitrary input.
 * The env plumbing below freezes its result at module load, which is correct
 * for the app and untestable by construction — so the rules live here, where a
 * test can reach them, and the loop below is the only thing left that env can
 * affect. Nothing in the render path may call this directly: use
 * giftDestination(), which only ever returns a value that passed.
 */
export function validateGiftDestination(rail: GiftRail, raw: string): Validation {
  return VALIDATORS[rail](raw);
}

const ENV_NAMES: Record<GiftRail, string> = {
  xrd: "NEXT_PUBLIC_GIFT_XRD_ADDRESS",
  btc: "NEXT_PUBLIC_GIFT_BTC_ADDRESS",
};

const RAILS: GiftRail[] = ["xrd", "btc"];

/** Destinations that are set AND valid. Anything absent here must not render. */
const RESOLVED: Partial<Record<GiftRail, string>> = {};
/** Set-but-rejected rails, kept so the failure can be reported, never rendered. */
const REJECTED: { rail: GiftRail; env: string; reason: string }[] = [];

for (const rail of RAILS) {
  const raw = RAW[rail];
  if (!raw) continue;
  const result = validateGiftDestination(rail, raw);
  if (result.ok) RESOLVED[rail] = result.value;
  else REJECTED.push({ rail, env: ENV_NAMES[rail], reason: result.reason });
}

// Fail loudly, once, at module load — which for a NEXT_PUBLIC_* var means at
// `next build` on the VPS, where bigdev will actually see it. Silence here
// would turn a typo into "I set the address and the page is still empty".
// The value is never logged back: it is public by design, but echoing a
// rejected string invites copying the broken one out of the log.
if (REJECTED.length > 0) {
  for (const r of REJECTED) {
    console.warn(`[gift] ${r.env} is set but ${r.reason} — the ${r.rail.toUpperCase()} gift rail stays OFF.`);
  }
}

/** The destination for a rail, or null when it is unset/invalid (i.e. dark). */
export function giftDestination(rail: GiftRail): string | null {
  return RESOLVED[rail] ?? null;
}

export function isGiftRailLive(rail: GiftRail): boolean {
  return RESOLVED[rail] !== undefined;
}

/** True only if at least one rail has a real destination. Gates the whole route. */
export function isGiftPageLive(): boolean {
  return RAILS.some(isGiftRailLive);
}

export function liveGiftRails(): GiftRail[] {
  return RAILS.filter(isGiftRailLive);
}

/** Set-but-rejected rails. For operator surfaces and tests — never for donors. */
export function giftDiagnostics(): readonly { rail: GiftRail; env: string; reason: string }[] {
  return REJECTED;
}

/**
 * Preset amounts. Round numbers, deliberately NOT pegged to a price feed: a
 * donation page should not depend on a market endpoint to render, and a stale
 * "≈ $50" is a worse lie than no dollar figure at all. Strings, not numbers,
 * so no float artifact can reach a BIP-21 amount.
 */
export const BTC_PRESETS = ["0.0005", "0.001", "0.005"] as const;

/**
 * BIP-21 payment URI. The address is embedded verbatim after validation; label
 * and message are percent-encoded via URLSearchParams.
 *
 * `amount` is in BTC and MUST be a plain decimal string — BIP-21 requires it,
 * and wallets differ in how they handle exponential notation (some silently
 * read 1e-4 as an empty amount). Callers pass BTC_PRESETS values; anything
 * that is not a plain decimal throws rather than producing a URI a wallet
 * might misread.
 */
export function bip21Uri(address: string, amount?: string, label?: string): string {
  if (validateBtcMainnetAddress(address).ok === false) {
    throw new Error("bip21Uri: refusing to build a URI for an invalid address");
  }
  const params = new URLSearchParams();
  if (amount !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      throw new Error(`bip21Uri: amount must be a plain decimal string, got "${amount}"`);
    }
    params.set("amount", amount);
  }
  if (label) params.set("label", label);
  const query = params.toString();
  return `bitcoin:${address}${query ? `?${query}` : ""}`;
}
