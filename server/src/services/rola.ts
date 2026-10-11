/// Server-side ROLA (Radix Off-Ledger Auth) — ported from the Guild app's
/// implementation (battle-tested through the 2026-06-11 mainnet smoke).
///
/// - issueChallenge() → fresh 32-byte nonce, stored in-memory with a 60s TTL.
/// - verifyAndConsume(signedChallenge) → one-time-consumes the nonce, then
///   verifies the signature against the on-chain owner key via @radixdlt/rola
///   (canonical message build + Gateway lookup + signature check).
///
/// Identity = ACCOUNT address (SignedChallenge type "account"), not persona —
/// positions/portfolios are account-keyed on-chain (PHASE-3.1-DESIGN D1).
///
/// The nonce store is in-memory: nonces are 60s-lived and single-use, so
/// restart loss is harmless (user re-signs). Sessions, by contrast, live in
/// SQLite (services/sessions.ts).

import { randomBytes } from 'crypto';
import { Rola, type SignedChallenge } from '@radixdlt/rola';
import { CONFIG } from '../config.js';

export type { SignedChallenge };

const CHALLENGE_TTL_MS = 60_000;

const store = new Map<string, number>(); // challenge -> expires_at (ms epoch)

// Lazy janitor — drops expired nonces; .unref()'d so it never blocks exit.
let janitor: ReturnType<typeof setInterval> | null = null;
function ensureJanitor(): void {
  if (janitor) return;
  janitor = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of store) if (exp <= now) store.delete(k);
  }, 30_000);
  janitor.unref();
}

type RolaVerifier = (sc: SignedChallenge) => Promise<{ isErr: () => boolean; error?: { reason?: string } }>;

let rolaVerifier: RolaVerifier | null = null;

function getVerifier(): RolaVerifier {
  if (rolaVerifier) return rolaVerifier;
  const rola = Rola({
    applicationName: 'DeFi Farmer',
    dAppDefinitionAddress: CONFIG.DAPP_DEFINITION_ADDRESS,
    networkId: CONFIG.NETWORK_ID,
    expectedOrigin: CONFIG.ROLA_EXPECTED_ORIGIN,
  });
  // verifySignedChallenge returns a neverthrow ResultAsync — adapt it to the
  // plain shape the seam (and its test stubs) use.
  rolaVerifier = async (sc) => {
    const result = await rola.verifySignedChallenge(sc);
    return {
      isErr: () => result.isErr(),
      error: result.isErr()
        ? { reason: String((result.error as { reason?: unknown })?.reason ?? 'verification_failed') }
        : undefined,
    };
  };
  return rolaVerifier;
}

/// Test seam: the real verifier does a live Gateway owner-key lookup.
export function setVerifierForTests(v: RolaVerifier | null): void {
  rolaVerifier = v;
}

export function issueChallenge(): { challenge: string; expires_at: number } {
  ensureJanitor();
  const challenge = randomBytes(32).toString('hex');
  const expires_at = Date.now() + CHALLENGE_TTL_MS;
  store.set(challenge, expires_at);
  return { challenge, expires_at };
}

export type VerifyResult =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Verify a signed challenge AND consume the nonce (fail-closed):
 *   1. Nonce exists and is not expired.
 *   2. Proof shape is sane and is an account proof.
 *   3. ROLA signature verifies against the on-chain owner key.
 * The nonce is consumed BEFORE signature verification — a failed attempt
 * burns it, so proofs can never be replayed.
 */
export async function verifyAndConsume(signedChallenge: SignedChallenge): Promise<VerifyResult> {
  if (!signedChallenge || typeof signedChallenge !== 'object') {
    return { ok: false, error: 'missing_proof' };
  }
  const { challenge, address, type } = signedChallenge as SignedChallenge & { type?: string };
  if (typeof challenge !== 'string' || typeof address !== 'string') {
    return { ok: false, error: 'invalid_proof_shape' };
  }
  if (type !== 'account') {
    return { ok: false, error: 'proof_must_be_account' };
  }
  if (!/^account_(rdx|tdx_2_)1[a-z0-9]{20,80}$/.test(address)) {
    return { ok: false, error: 'invalid_account_address' };
  }
  const exp = store.get(challenge);
  if (exp === undefined) {
    return { ok: false, error: 'unknown_challenge' };
  }
  if (exp <= Date.now()) {
    store.delete(challenge);
    return { ok: false, error: 'challenge_expired' };
  }

  // Consume up front — even on signature failure it must not be reusable.
  store.delete(challenge);

  const result = await getVerifier()(signedChallenge);
  if (result.isErr()) {
    return { ok: false, error: `rola: ${result.error?.reason ?? 'verification_failed'}` };
  }
  return { ok: true, address };
}

/// Test seam for TTL manipulation.
export const _testHooks = { store, CHALLENGE_TTL_MS };
