/// SQLite-backed sessions for ROLA-authenticated users.
/// Raw tokens live only in the HttpOnly cookie; the DB stores sha256(token),
/// so a DB read never yields a usable credential. 30-day fixed expiry,
/// last_seen_at bumped on use (observability, not sliding renewal — simple).

import { createHash, randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';

export const SESSION_COOKIE = 'farmer_session';
const SESSION_TTL_DAYS = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface Session {
  user_address: string;
}

/// Create a session for a ROLA-verified address. Returns the RAW token —
/// the only time it exists outside the cookie.
export function createSession(userAddress: string): { token: string; maxAgeSeconds: number } {
  const db = getDb();
  // Opportunistic purge — keeps the table from accumulating dead rows
  // without needing a background job.
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

  const token = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_address, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_DAYS} days'))`,
  ).run(hashToken(token), userAddress);
  return { token, maxAgeSeconds: SESSION_TTL_DAYS * 86_400 };
}

/// Resolve a raw token to a live session, or null.
export function getSession(token: string): Session | null {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT user_address FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')",
    )
    .get(hashToken(token)) as { user_address: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?").run(
    hashToken(token),
  );
  return { user_address: row.user_address };
}

export function deleteSession(token: string): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
