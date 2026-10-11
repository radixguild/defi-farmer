"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  RadixDappToolkit as RadixDappToolkitType,
  SendTransactionInput,
  SendTransactionResult,
  WalletDataStateAccount,
} from "@radixdlt/radix-dapp-toolkit";

/** Matches @radixdlt/rola's SignedChallenge — sent to POST /api/auth/verify. */
export type SignedChallenge = {
  address: string;
  type: "account";
  challenge: string;
  proof: {
    publicKey: string;
    signature: string;
    curve: "curve25519" | "secp256k1";
  };
};

export interface WalletContextValue {
  connected: boolean;
  accounts: WalletDataStateAccount[];
  sendTransaction: (input: SendTransactionInput) => SendTransactionResult | undefined;
  extensionDetected: boolean;
  /** True once a farmer_session exists (hydrated from /me or set via signIn). */
  authed: boolean;
  /** The ROLA-verified account address behind the session, or null. */
  authAddress: string | null;
  /**
   * True when the session's account is NOT among the accounts the wallet
   * currently shares. Ported from the Guild app (2026-06-11 mainnet smoke):
   * actions that bind a tx to the session identity should block on this.
   * Normally self-heals — the provider drops such sessions on wallet change.
   */
  sessionMismatch: boolean;
  /** ROLA sign-in: wallet signature → POST /verify → session cookie. False on cancel/failure. */
  signIn: () => Promise<boolean>;
  /** No-op if already authed, else runs signIn. Call before session-tier writes. */
  ensureSession: () => Promise<boolean>;
  /** Clear the server session and local auth state. */
  signOut: () => Promise<void>;
}

export const WalletContext = createContext<WalletContextValue>({
  connected: false,
  accounts: [],
  sendTransaction: () => undefined,
  extensionDetected: true,
  authed: false,
  authAddress: null,
  sessionMismatch: false,
  signIn: async () => false,
  ensureSession: async () => false,
  signOut: async () => {},
});

const NETWORK_ID = parseInt(
  process.env.NEXT_PUBLIC_RADIX_NETWORK_ID || "1",
  10
);
// Must match the server's DAPP_DEFINITION_ADDRESS and the address in
// /.well-known/radix.json — the wallet verifies the claim in both directions.
const DAPP_DEFINITION_ADDRESS =
  process.env.NEXT_PUBLIC_DAPP_DEFINITION_ADDRESS ||
  "account_rdx12yp8wps97gzj9w6fq022xzdcw540qettg39neumev7mla6k9lggfna";

/**
 * Decide what happens to the session when the wallet's shared-account set
 * changes. Pure; ported verbatim from the Guild app's useWallet (unit-tested
 * there; every branch traces to a 2026-06-11 mainnet smoke incident):
 *   - no shared accounts          → drop (wallet disconnected)
 *   - no session                  → keep (nothing to drop)
 *   - session account not shared  → drop (its authority was removed)
 *   - primary changed to a new value that isn't the session's account → drop
 *   - otherwise                   → keep (proving a non-first account must
 *     NOT drop the session — accounts[0]-equality logout-looped
 *     multi-account wallets, guild #151)
 */
export function decideSession(
  shared: string[],
  sessionAddress: string | null,
  prevPrimary: string | null,
): "drop" | "keep" {
  if (shared.length === 0) return "drop";
  if (!sessionAddress) return "keep";
  if (!shared.includes(sessionAddress)) return "drop";
  const newPrimary = shared[0];
  if (prevPrimary !== null && newPrimary !== prevPrimary && sessionAddress !== newPrimary) {
    return "drop";
  }
  return "keep";
}

export function RadixProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<WalletDataStateAccount[]>([]);
  const [extensionDetected, setExtensionDetected] = useState(true);
  const [authAddress, setAuthAddress] = useState<string | null>(null);
  const toolkitRef = useRef<RadixDappToolkitType | null>(null);
  // Refs mirror auth/primary state for the walletData$ subscription — the
  // subscription outlives every render, so closures over state go stale.
  const authAddressRef = useRef<string | null>(null);
  const prevPrimaryRef = useRef<string | null>(null);

  const applyAuth = useCallback((address: string | null) => {
    authAddressRef.current = address;
    setAuthAddress(address);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Local state clears regardless; the cookie is HttpOnly and expires.
    }
    applyAuth(null);
  }, [applyAuth]);

  useEffect(() => {
    const hasExtension =
      typeof window !== "undefined" &&
      !!(window as unknown as Record<string, unknown>).radixWalletConnector;

    setExtensionDetected(hasExtension);

    // Hydrate an existing session (cookie) so refreshes stay signed in.
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { address?: string | null } | null) => {
        if (data?.address) applyAuth(data.address);
      })
      .catch(() => {});

    import("@radixdlt/radix-dapp-toolkit").then(({ RadixDappToolkit, DataRequestBuilder }) => {
      const toolkit = RadixDappToolkit({
        networkId: NETWORK_ID,
        dAppDefinitionAddress: DAPP_DEFINITION_ADDRESS,
        applicationName: "DeFi Farmer",
        applicationVersion: "1.0.0",
      });

      // ROLA challenges come from the backend so verify() can consume the
      // exact nonce it issued.
      toolkit.walletApi.provideChallengeGenerator(async () => {
        const res = await fetch("/api/auth/challenge");
        const { challenge } = (await res.json()) as { challenge: string };
        return challenge;
      });

      toolkit.walletApi.setRequestData(
        DataRequestBuilder.accounts().atLeast(1)
      );

      const subscription = toolkit.walletApi.walletData$.subscribe((walletData) => {
        const next = walletData?.accounts ?? [];
        setAccounts(next);

        // Session guard (see decideSession).
        const shared = next.map((a) => a.address);
        const decision = decideSession(shared, authAddressRef.current, prevPrimaryRef.current);
        prevPrimaryRef.current = shared[0] ?? null;
        if (decision === "drop" && authAddressRef.current) {
          void signOut();
        }
      });

      toolkitRef.current = toolkit;

      return () => {
        subscription.unsubscribe();
        toolkit.destroy();
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendTransaction = useCallback(
    (input: SendTransactionInput) => {
      if (!toolkitRef.current) return undefined;
      return toolkitRef.current.walletApi.sendTransaction(input);
    },
    []
  );

  const signIn = useCallback(async (): Promise<boolean> => {
    const toolkit = toolkitRef.current;
    if (!toolkit) return false;

    const { DataRequestBuilder } = await import("@radixdlt/radix-dapp-toolkit");
    const result = await toolkit.walletApi.sendOneTimeRequest(
      DataRequestBuilder.accounts().exactly(1).withProof(),
    );
    if (result.isErr()) {
      console.error("[auth] wallet rejected the sign-in request", result.error);
      return false;
    }
    // RDT 2.x surfaces proofs at the top level; an account request with
    // .withProof() yields proofs[0].type === "account" in rola's shape.
    const proof = result.value.proofs?.[0] as SignedChallenge | undefined;
    if (!proof || proof.type !== "account") return false;

    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedChallenge: proof }),
    });
    if (!res.ok) {
      console.error("[auth] verify failed", res.status);
      return false;
    }
    const { address } = (await res.json()) as { address: string };
    applyAuth(address);
    return true;
  }, [applyAuth]);

  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (authAddressRef.current) return true;
    return signIn();
  }, [signIn]);

  const sessionMismatch =
    authAddress !== null &&
    accounts.length > 0 &&
    !accounts.some((a) => a.address === authAddress);

  const value: WalletContextValue = {
    connected: accounts.length > 0,
    accounts,
    sendTransaction,
    extensionDetected,
    authed: authAddress !== null,
    authAddress,
    sessionMismatch,
    signIn,
    ensureSession,
    signOut,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
