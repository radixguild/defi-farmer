/**
 * The gift-rail guard: what it accepts as a destination, and what it refuses.
 *
 * This is the only thing standing between a mistyped env var and every donor's
 * money going somewhere unrecoverable, so it is tested against the official
 * BIP-173 / BIP-350 vectors rather than against a few addresses that happen to
 * look right. The invalid vectors matter more than the valid ones: each is a
 * string a naive "starts with bc1" check would wave through.
 *
 * Kept in step with the Guild app (radixguild/guild, upstream). A bug fixed there and not
 * here means the two apps disagree about what a valid address is.
 */

import { describe, expect, test } from "bun:test";
import { verifyBech32, convertBits } from "@/lib/gift/bech32";
import { validateBtcMainnetAddress } from "@/lib/gift/btc-address";
import { validateGiftDestination, bip21Uri, FORBIDDEN_XRD_DESTINATIONS } from "@/lib/gift";

// BIP-350 §Test vectors — valid segwit addresses (mainnet subset).
const VALID_SEGWIT = [
  "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
  "BC1SW50QGDZ25J",
  "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
];

// BIP-350 §Invalid address — every one of these LOOKS like an address.
const INVALID_SEGWIT: [string, string][] = [
  ["bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4", "invalid checksum (bech32 instead of bech32m)"],
  ["BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R", "invalid character in checksum"],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "bech32 checksum on a v1 address"],
  ["BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "invalid program length for witness v0"],
  ["bc1gmk9yu", "empty data section"],
];

describe("bech32 / bech32m verification", () => {
  test("accepts the official valid vectors", () => {
    for (const addr of VALID_SEGWIT) {
      expect(verifyBech32(addr), addr).not.toBeNull();
    }
  });

  test("rejects mixed case rather than normalizing it", () => {
    // BIP-173 treats mixed case as invalid. Normalizing would mean validating
    // a string the operator did not actually supply.
    expect(verifyBech32("bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBeNull();
  });

  test("rejects non-printable and non-ASCII characters", () => {
    expect(verifyBech32("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ")).toBeNull();
  });

  test("convertBits refuses non-zero padding when unpacking", () => {
    // pad=false is the BIP-173 rule for 5→8; leftover bits must be zero.
    expect(convertBits([31, 31], 5, 8, false)).toBeNull();
  });
});

describe("validateBtcMainnetAddress", () => {
  test("accepts the official valid segwit vectors", () => {
    for (const addr of VALID_SEGWIT) {
      const r = validateBtcMainnetAddress(addr);
      expect(r.ok, `${addr} → ${r.ok ? "" : r.reason}`).toBe(true);
    }
  });

  test("rejects every official invalid vector", () => {
    for (const [addr, why] of INVALID_SEGWIT) {
      expect(validateBtcMainnetAddress(addr).ok, `${addr} (${why})`).toBe(false);
    }
  });

  test("a single-character typo in a real address is caught", () => {
    // The whole reason the checksum is verified rather than the shape.
    const real = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const typo = real.replace("qw508", "qw509");
    expect(validateBtcMainnetAddress(real).ok).toBe(true);
    expect(validateBtcMainnetAddress(typo).ok).toBe(false);
  });

  test("rejects testnet with a reason that says so", () => {
    const r = validateBtcMainnetAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("testnet");
  });

  test("rejects surrounding whitespace instead of trimming it", () => {
    const r = validateBtcMainnetAddress(" bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ");
    expect(r.ok).toBe(false);
  });

  test("legacy addresses pass on shape but are flagged unverified", () => {
    // Documented gap: no base58check here (needs async SHA-256). The flag is
    // the honest signal — a typo in a legacy address CAN pass.
    const r = validateBtcMainnetAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("legacy");
      expect(r.checksumVerified).toBe(false);
    }
  });

  test("taproot is verified, and reports checksumVerified", () => {
    const r = validateBtcMainnetAddress(
      "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("taproot-v1");
      expect(r.checksumVerified).toBe(true);
    }
  });
});

describe("validateGiftDestination — the rail guard", () => {
  // A real P2WPKH destination, kept as a vector so the guard is proven against
  // the shape actually used in production, not only against spec examples.
  const REAL_BTC = "bc1qdfwn86z7c4zxy0usq5z7cat8a09aex6pvz8azw";

  test("accepts a real mainnet P2WPKH gift address", () => {
    const r = validateGiftDestination("btc", REAL_BTC);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
  });

  test("rejects a Radix address pasted into the BTC rail", () => {
    expect(validateGiftDestination("btc", "account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx").ok).toBe(false);
  });

  test("rejects a component_ address pasted into the XRD rail", () => {
    // The length pin exists for exactly this: a component/resource address is
    // still valid bech32m, so only the prefix and length reject it.
    const r = validateGiftDestination("xrd", "component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva");
    expect(r.ok).toBe(false);
  });

  test("rejects a Radix account with a one-character typo", () => {
    // Deliberately NOT one of the ecosystem's own accounts: those are on the
    // forbidden list below, so using one as the positive control would couple
    // this checksum test to the denylist and fail for the wrong reason.
    const real = "account_rdx16y6spuy7pvxj3v9ruezge6dvnvjkjja70wmv8fa4c73n4csl9p3pr5";
    expect(validateGiftDestination("xrd", real).ok).toBe(true);
    const typo = real.replace("6y6spuy", "6y6spuz");
    const r = validateGiftDestination("xrd", typo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("checksum");
  });

  // A checksum proves "not a typo", never "the account you meant". Both of
  // these are valid live mainnet accounts that can still turn up in the
  // ecosystem's repos and docs, which is precisely what makes them plausible
  // paste errors.
  describe("forbidden destinations", () => {
    test("rejects the retired server account", () => {
      const r = validateGiftDestination(
        "xrd",
        "account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("retired account");
    });

    test("rejects the orphaned old dApp definition — no key exists for it", () => {
      const r = validateGiftDestination(
        "xrd",
        "account_rdx128y6j78mt0aqv6372evz28hrxp8mn06ccddkr7xppc88hyvynvjdwr",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("unrecoverable");
    });

    test("every forbidden address is itself well-formed", () => {
      // If one were malformed it would be rejected by the checksum anyway and
      // its denylist entry would be dead weight hiding a stale address.
      for (const addr of Object.keys(FORBIDDEN_XRD_DESTINATIONS)) {
        expect(addr, `${addr} is not 66 chars`).toHaveLength(66);
        expect(verifyBech32(addr)?.encoding, `${addr} fails bech32m`).toBe("bech32m");
      }
    });
  });

  test("rejects a stokenet account on the XRD rail", () => {
    expect(validateGiftDestination("xrd", "account_tdx_2_129qeystv8tufmkmjrry2vf6zbmnm5hfvhkywmvc9edcst8pdgnp62s").ok).toBe(false);
  });

  test("rejects the empty string and whitespace", () => {
    expect(validateGiftDestination("xrd", "").ok).toBe(false);
    expect(validateGiftDestination("btc", "   ").ok).toBe(false);
  });
});

describe("bip21Uri", () => {
  const ADDR = "bc1qdfwn86z7c4zxy0usq5z7cat8a09aex6pvz8azw";

  test("omits the amount entirely when none is given", () => {
    expect(bip21Uri(ADDR)).toBe(`bitcoin:${ADDR}`);
  });

  test("carries a plain decimal amount and a label", () => {
    const uri = bip21Uri(ADDR, "0.001", "DeFi Farmer");
    expect(uri).toBe(`bitcoin:${ADDR}?amount=0.001&label=DeFi+Farmer`);
  });

  test("refuses to build a URI for an invalid address", () => {
    // A scannable URI for a wrong address is the worst possible output here.
    expect(() => bip21Uri("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toThrow();
  });

  test("refuses an exponential amount", () => {
    // Some wallets read 1e-4 as an empty amount and send nothing.
    expect(() => bip21Uri(ADDR, "1e-4")).toThrow();
  });
});
