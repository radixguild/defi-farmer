/**
 * PORTED from the Guild app (radixguild/guild: guild-app/src/lib/btc-address.ts)
 * — the gift rails are the same guard in every bigdev dapp, deliberately. Fix a
 * validation bug in BOTH or the two drift and one of them starts accepting an
 * address the other rejects. The Guild app is upstream.
 */
/**
 * btc-address.ts — Bitcoin mainnet address validation for the gift rail guard.
 *
 * WHY THIS IS STRICT: a BTC gift is irreversible and un-appealable. The gift
 * address is pasted into an env var once and then every donor's money follows
 * it forever, so this refuses to be a shape check — a single mistyped
 * character still *looks* exactly like an address. Anything this function
 * rejects renders nothing sendable (see gift.ts), which is the safe failure.
 *
 * WHAT IS ACTUALLY CHECKED — the gap is stated because it matters:
 *   - bc1… (segwit v0 / taproot v1 / future v2-v16): FULLY verified per
 *     BIP-173 + BIP-350 — bech32/bech32m checksum, witness version, program
 *     length, and padding. A one-character typo cannot pass.
 *   - 1… / 3… (legacy P2PKH / P2SH): charset + length ONLY. The base58check
 *     checksum is NOT verified — that needs SHA-256, which is async in the
 *     browser (SubtleCrypto) while this guard is synchronous at render. A
 *     typo in a legacy address CAN pass this. Every current hardware wallet
 *     issues bc1… by default, so prefer one; if a legacy address is used
 *     anyway, the operator scan-check in .env.example is the only backstop.
 *   - testnet (tb1…/bcrt1…/m…/n…/2…): rejected. This app is mainnet-only.
 *
 * Pinned against the official BIP-350 vectors in tests/gift-address.test.ts,
 * including the cases a naive "starts with bc1" check gets wrong.
 */

import { convertBits, verifyBech32 } from "./bech32";

export type BtcAddressKind = "segwit-v0" | "taproot-v1" | `segwit-v${number}` | "legacy";

export type BtcAddressResult =
  | { ok: true; kind: BtcAddressKind; checksumVerified: boolean }
  | { ok: false; reason: string };

/**
 * Legacy base58 P2PKH/P2SH. Base58 omits 0, O, I and l to kill lookalikes, so
 * the charset itself catches a chunk of transcription slips — but NOT all of
 * them (see the module header: no checksum here).
 */
const LEGACY_MAINNET = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** Testnet/regtest forms, matched only to reject them with a useful reason. */
const TESTNET_LEGACY = /^[mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/;

export function validateBtcMainnetAddress(input: string): BtcAddressResult {
  const addr = input.trim();
  if (!addr) return { ok: false, reason: "empty" };
  if (addr !== input) {
    // Surrounding whitespace usually means a copy-paste picked up more than the
    // address. Say so rather than silently trimming — the operator should fix
    // the source of truth, not have us guess at it.
    return { ok: false, reason: "has leading or trailing whitespace" };
  }

  const lower = addr.toLowerCase();
  if (lower.startsWith("tb1") || lower.startsWith("bcrt1") || TESTNET_LEGACY.test(addr)) {
    return { ok: false, reason: "is a testnet address — this app is mainnet-only" };
  }

  if (lower.startsWith("bc1")) return validateSegwit(addr);

  if (LEGACY_MAINNET.test(addr)) {
    return { ok: true, kind: "legacy", checksumVerified: false };
  }

  return { ok: false, reason: "is not a recognizable Bitcoin mainnet address" };
}

function validateSegwit(addr: string): BtcAddressResult {
  const decoded = verifyBech32(addr);
  if (!decoded) {
    return { ok: false, reason: "failed the bech32 checksum — check for a typo" };
  }
  if (decoded.hrp !== "bc") {
    return { ok: false, reason: `has human-readable part "${decoded.hrp}", expected "bc"` };
  }
  if (decoded.data.length === 0) {
    return { ok: false, reason: "has an empty data section" };
  }

  const version = decoded.data[0];
  if (version > 16) {
    return { ok: false, reason: `has invalid witness version ${version}` };
  }

  const program = convertBits(decoded.data.slice(1), 5, 8, false);
  if (!program) {
    return { ok: false, reason: "has invalid padding in its witness program" };
  }
  if (program.length < 2 || program.length > 40) {
    return { ok: false, reason: `has a ${program.length}-byte witness program (must be 2-40)` };
  }

  // The encoding is not cosmetic: BIP-350 assigns bech32 to v0 and bech32m to
  // v1+ precisely so an address whose version was corrupted fails the checksum
  // instead of resolving to a different, real, unspendable output.
  if (version === 0) {
    if (decoded.encoding !== "bech32") {
      return { ok: false, reason: "is a v0 address with a bech32m checksum (must be bech32)" };
    }
    if (program.length !== 20 && program.length !== 32) {
      return { ok: false, reason: `is a v0 address with a ${program.length}-byte program (must be 20 or 32)` };
    }
    return { ok: true, kind: "segwit-v0", checksumVerified: true };
  }

  if (decoded.encoding !== "bech32m") {
    return { ok: false, reason: `is a v${version} address with a bech32 checksum (must be bech32m)` };
  }
  if (version === 1) {
    return { ok: true, kind: "taproot-v1", checksumVerified: true };
  }
  return { ok: true, kind: `segwit-v${version}`, checksumVerified: true };
}
