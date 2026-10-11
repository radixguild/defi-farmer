import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, setTestDb } from '../src/db/schema';
import { startApi, resetRateLimits } from '../src/api';
import {
  issueChallenge,
  verifyAndConsume,
  setVerifierForTests,
  _testHooks,
  type SignedChallenge,
} from '../src/services/rola';
import { createSession, getSession, deleteSession } from '../src/services/sessions';
import type { AgentLoop } from '../src/agent/loop';

const ADDRESS = 'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy';

const verifierOk = async () => ({ isErr: () => false });
const verifierFail = async () => ({ isErr: () => true, error: { reason: 'invalid_signature' } });

function makeProof(challenge: string, address: string = ADDRESS): SignedChallenge {
  return {
    address,
    type: 'account',
    challenge,
    proof: { publicKey: 'aa'.repeat(32), signature: 'bb'.repeat(32), curve: 'curve25519' },
  } as SignedChallenge;
}

let testDb: Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  setTestDb(testDb);
  _testHooks.store.clear();
  setVerifierForTests(verifierOk);
  resetRateLimits();
});

afterAll(() => {
  setVerifierForTests(null);
  setTestDb(null);
  testDb?.close();
});

describe('rola service', () => {
  test('issueChallenge returns a 64-hex nonce with a future expiry', () => {
    const { challenge, expires_at } = issueChallenge();
    expect(challenge).toMatch(/^[a-f0-9]{64}$/);
    expect(expires_at).toBeGreaterThan(Date.now());
    expect(_testHooks.store.has(challenge)).toBe(true);
  });

  test('verifyAndConsume succeeds and consumes the nonce', async () => {
    const { challenge } = issueChallenge();
    const result = await verifyAndConsume(makeProof(challenge));
    expect(result).toEqual({ ok: true, address: ADDRESS });
    expect(_testHooks.store.has(challenge)).toBe(false);
  });

  test('a nonce cannot be replayed', async () => {
    const { challenge } = issueChallenge();
    await verifyAndConsume(makeProof(challenge));
    const replay = await verifyAndConsume(makeProof(challenge));
    expect(replay).toEqual({ ok: false, error: 'unknown_challenge' });
  });

  test('a failed signature still burns the nonce', async () => {
    setVerifierForTests(verifierFail);
    const { challenge } = issueChallenge();
    const first = await verifyAndConsume(makeProof(challenge));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toContain('rola:');

    setVerifierForTests(verifierOk);
    const retry = await verifyAndConsume(makeProof(challenge));
    expect(retry).toEqual({ ok: false, error: 'unknown_challenge' });
  });

  test('expired nonce is rejected', async () => {
    const { challenge } = issueChallenge();
    _testHooks.store.set(challenge, Date.now() - 1);
    const result = await verifyAndConsume(makeProof(challenge));
    expect(result).toEqual({ ok: false, error: 'challenge_expired' });
  });

  test('non-account proofs are rejected', async () => {
    const { challenge } = issueChallenge();
    const proof = { ...makeProof(challenge), type: 'persona' } as unknown as SignedChallenge;
    const result = await verifyAndConsume(proof);
    expect(result).toEqual({ ok: false, error: 'proof_must_be_account' });
  });

  test('malformed account addresses are rejected', async () => {
    const { challenge } = issueChallenge();
    const result = await verifyAndConsume(makeProof(challenge, 'account_rdx1; DROP TABLE sessions'));
    expect(result).toEqual({ ok: false, error: 'invalid_account_address' });
  });
});

describe('sessions service', () => {
  test('createSession stores only the token hash', () => {
    const { token } = createSession(ADDRESS);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const rows = testDb.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
  });

  test('getSession resolves a live token and rejects unknown tokens', () => {
    const { token } = createSession(ADDRESS);
    expect(getSession(token)?.user_address).toBe(ADDRESS);
    expect(getSession('0'.repeat(64))).toBeNull();
    expect(getSession('')).toBeNull();
  });

  test('expired sessions do not resolve', () => {
    const { token } = createSession(ADDRESS);
    testDb.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run();
    expect(getSession(token)).toBeNull();
  });

  test('deleteSession revokes the token', () => {
    const { token } = createSession(ADDRESS);
    deleteSession(token);
    expect(getSession(token)).toBeNull();
  });
});

// --- HTTP-level auth flow ---

const TEST_PORT = 19877;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const OPERATOR = process.env.API_AUTH_TOKEN!;

function mockAgent(): AgentLoop {
  return {
    getState: () => ({ running: true, halted: false, lastScan: 0, errors: [], circuitBreaker: {}, pendingTx: 0 }),
    halt: () => {},
    start: () => {},
    isHalted: () => false,
  } as unknown as AgentLoop;
}

let server: ReturnType<typeof startApi> | null = null;

describe('auth API flow', () => {
  beforeAll(() => {
    server = startApi(mockAgent(), TEST_PORT);
  });
  afterAll(() => {
    server?.stop?.(true);
    server = null;
  });

  async function signIn(): Promise<string> {
    const chRes = await fetch(`${BASE}/api/auth/challenge`);
    expect(chRes.status).toBe(200);
    const { challenge } = (await chRes.json()) as { challenge: string };

    const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedChallenge: makeProof(challenge) }),
    });
    expect(verifyRes.status).toBe(200);
    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('farmer_session=');
    expect(setCookie).toContain('HttpOnly');
    const token = setCookie.match(/farmer_session=([a-f0-9]{64})/)?.[1];
    expect(token).toBeTruthy();
    return `farmer_session=${token}`;
  }

  test('challenge → verify → session cookie → /api/auth/me', async () => {
    const cookie = await signIn();
    const meRes = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    expect(((await meRes.json()) as { address: string }).address).toBe(ADDRESS);
  });

  test('verify with an invalid signature returns 401', async () => {
    setVerifierForTests(verifierFail);
    const { challenge } = (await (await fetch(`${BASE}/api/auth/challenge`)).json()) as {
      challenge: string;
    };
    const res = await fetch(`${BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedChallenge: makeProof(challenge) }),
    });
    expect(res.status).toBe(401);
  });

  test('session-tier endpoint rejects anonymous callers', async () => {
    const res = await fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  test('operator Bearer satisfies the session tier', async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(res.status).toBe(200);
  });

  test('/api/config is operator-tier (F17)', async () => {
    const anon = await fetch(`${BASE}/api/config`);
    expect(anon.status).toBe(401);
    const op = await fetch(`${BASE}/api/config`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(op.status).toBe(200);
  });

  test('logout revokes the session', async () => {
    const cookie = await signIn();
    const out = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });
});
