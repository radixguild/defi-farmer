/**
 * PORTED from the Guild app (radixguild/guild: guild-app/src/lib/bech32.ts) —
 * the gift rails are the same guard in every bigdev dapp, deliberately. Fix a
 * validation bug in BOTH or the two drift and one of them starts accepting an
 * address the other rejects. The Guild app is upstream.
 */
/**
 * bech32.ts — Bech32 / Bech32m checksum verification (BIP-173, BIP-350).
 *
 * Exists for ONE job: the gift rails' hard guard. A gift destination is
 * copy-pasted into an env var once and then every donor's money follows it,
 * so "looks like an address" is not good enough — a single mistyped character
 * still looks like an address, and BTC sent there is gone forever. The
 * checksum is what turns a shape check into a real one.
 *
 * Both rails need it, which is why this is a shared module rather than a
 * Bitcoin detail: Radix Babylon addresses (account_rdx1…) and modern Bitcoin
 * addresses (bc1…) are both Bech32m. tests/gift-address.test.ts pins it
 * against the official BIP-173/BIP-350 vectors AND against the real gift
 * destinations, so a broken verifier fails CI rather than silently rejecting
 * every real address (which would look like "gifts went dark"). Keep that
 * path right: it is the only vector coverage for this file.
 *
 * Verification only — this deliberately cannot ENCODE an address. Nothing here
 * should ever be able to produce a destination that bigdev did not supply.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** Bech32 checksum constant (BIP-173). */
const BECH32_CONST = 1;
/** Bech32m checksum constant (BIP-350). */
const BECH32M_CONST = 0x2bc830a3;

export type Bech32Encoding = "bech32" | "bech32m";

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Decode a Bech32(m) string into its human-readable part and 5-bit data
 * (checksum included), or null if the string is not well-formed.
 *
 * Rejects mixed case outright rather than normalizing: BIP-173 treats mixed
 * case as invalid, and a destination that only validates after we "helpfully"
 * rewrite it is a destination we are guessing at.
 */
function decodeRaw(input: string): { hrp: string; data: number[] } | null {
  if (input.length < 8) return null;
  const hasLower = input !== input.toUpperCase();
  const hasUpper = input !== input.toLowerCase();
  if (hasLower && hasUpper) return null;
  const s = input.toLowerCase();
  // Printable-ASCII only (BIP-173 §Bech32); guards against control chars and
  // any non-ASCII lookalike smuggled into an env var.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const sep = s.lastIndexOf("1");
  // hrp must be non-empty and at least 6 data chars must follow (the checksum).
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  return { hrp, data };
}

/**
 * Verify a Bech32/Bech32m string and report which variant it satisfies.
 * Returns null when the string is malformed or the checksum does not match —
 * i.e. when we must not treat it as an address.
 */
export function verifyBech32(input: string): { hrp: string; data: number[]; encoding: Bech32Encoding } | null {
  const raw = decodeRaw(input);
  if (!raw) return null;
  const chk = polymod(hrpExpand(raw.hrp).concat(raw.data));
  const encoding: Bech32Encoding | null =
    chk === BECH32_CONST ? "bech32" : chk === BECH32M_CONST ? "bech32m" : null;
  if (!encoding) return null;
  return { hrp: raw.hrp, data: raw.data.slice(0, -6), encoding };
}

/**
 * Regroup bits (e.g. the 5-bit Bech32 alphabet → 8-bit bytes). `pad` follows
 * the BIP-173 reference: padding is allowed when packing up, forbidden when
 * unpacking down (leftover bits must be zero and fewer than 5).
 */
export function convertBits(
  data: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}
