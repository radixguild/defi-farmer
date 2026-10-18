/**
 * The one rule that keeps the √ Connect button and the server session in step.
 * Pure, so it is unit-tested directly (tests/wallet-session.test.ts).
 *
 * Connecting IS signing in: the button's data request carries a ROLA challenge
 * and the provider's dataRequestControl verifies the proof on the server before
 * the toolkit accepts the login (lib/radix-provider.tsx). So the only legal
 * resting states are "connected with a server session for the shared account"
 * and "neither". Anything else is ended, never shown as a warning:
 *
 *   - the wallet shares nothing (the user disconnected in the button) while a
 *     session exists                     → sign out
 *   - the wallet shares an account that is not the session's account
 *                                         → sign out (and disconnect the button)
 *   - the wallet is connected but the server holds no session for it, e.g. the
 *     toolkit restored its state from storage after the cookie expired
 *                                         → sign out (and disconnect the button)
 *
 * Until the server has answered /api/auth/me ("hydrated"), the session is not
 * known yet and nothing is decided.
 */
export type SessionDecision = "keep" | "sign-out";

export function decideSession(
  sharedAccounts: readonly string[],
  sessionAddress: string | null,
  hydrated: boolean,
): SessionDecision {
  if (!hydrated) return "keep";
  if (sharedAccounts.length === 0) return sessionAddress ? "sign-out" : "keep";
  if (!sessionAddress) return "sign-out";
  return sharedAccounts.includes(sessionAddress) ? "keep" : "sign-out";
}
