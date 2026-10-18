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
import { decideSession } from "@/lib/wallet-session";

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
  /** The √ Connect button shares an account. */
  connected: boolean;
  accounts: WalletDataStateAccount[];
  sendTransaction: (input: SendTransactionInput) => SendTransactionResult | undefined;
  extensionDetected: boolean;
  /** True once a farmer_session exists (hydrated from /me, or set when the connect proof verified). */
  authed: boolean;
  /** The ROLA-verified account address behind the session, or null. */
  authAddress: string | null;
  /**
   * True when a server session exists. Connecting through the √ Connect button
   * IS the sign-in, so there is no separate step to run here; a caller that
   * gets false tells the user to connect.
   */
  ensureSession: () => Promise<boolean>;
  /** Clear the server session and disconnect the √ Connect button. */
  signOut: () => Promise<void>;
}

export const WalletContext = createContext<WalletContextValue>({
  connected: false,
  accounts: [],
  sendTransaction: () => undefined,
  extensionDetected: true,
  authed: false,
  authAddress: null,
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
 * Wallet state for the app, built on the standard Radix dApp Toolkit flow:
 *
 *   - The toolkit's own √ Connect button (components/connect-wallet-button.tsx,
 *     mounted once in the layout) is the only wallet UI: connect, the shared
 *     account and persona, update sharing, and disconnect all live there.
 *   - Its data request asks for exactly one account WITH a ROLA proof. The
 *     challenge comes from the backend (provideChallengeGenerator), and
 *     dataRequestControl posts the proof to /api/auth/verify BEFORE the toolkit
 *     accepts the login. A proof the server rejects fails the connect, so the
 *     button can never show an account the server has not verified.
 *   - decideSession (lib/wallet-session.ts) ends every other state: a
 *     disconnect in the button, a change to an account that is not the
 *     session's, or a restored connection with no live server session all sign
 *     out (server session cleared, button disconnected). There is no warning
 *     state to fall out of step with.
 */
export function RadixProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<WalletDataStateAccount[]>([]);
  const [extensionDetected, setExtensionDetected] = useState(true);
  const [authAddress, setAuthAddress] = useState<string | null>(null);
  const toolkitRef = useRef<RadixDappToolkitType | null>(null);
  // Refs mirror state for the toolkit callbacks, which outlive every render.
  const authAddressRef = useRef<string | null>(null);
  const sharedRef = useRef<string[]>([]);
  // decideSession runs only once BOTH sides have reported: the server
  // (/api/auth/me, or a verified connect) and the toolkit (its first
  // walletData$ emission, restored from storage). Deciding earlier would sign
  // out a valid session just because the other side had not loaded yet.
  const serverKnownRef = useRef(false);
  const walletKnownRef = useRef(false);

  const applyAuth = useCallback((address: string | null) => {
    authAddressRef.current = address;
    setAuthAddress(address);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const hadSession = authAddressRef.current !== null;
    applyAuth(null);
    // Never leave the button showing an account the server no longer backs.
    if (sharedRef.current.length > 0) toolkitRef.current?.disconnect();
    if (hadSession) {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // Local state is already clear; the cookie is HttpOnly and expires.
      }
    }
  }, [applyAuth]);

  const reconcile = useCallback(() => {
    const decision = decideSession(
      sharedRef.current,
      authAddressRef.current,
      serverKnownRef.current && walletKnownRef.current,
    );
    if (decision === "sign-out") void signOut();
  }, [signOut]);

  useEffect(() => {
    const hasExtension =
      typeof window !== "undefined" &&
      !!(window as unknown as Record<string, unknown>).radixWalletConnector;

    setExtensionDetected(hasExtension);

    // Hydrate an existing session (cookie) so refreshes stay signed in. Only a
    // definitive answer counts: 200 (a session) or 401 (none). A network error
    // or 5xx leaves the session unknown rather than signing anyone out.
    fetch("/api/auth/me")
      .then(async (res) => {
        if (serverKnownRef.current) return; // a connect already verified meanwhile
        if (res.ok) {
          const data = (await res.json()) as { address?: string | null };
          applyAuth(data.address ?? null);
          serverKnownRef.current = true;
        } else if (res.status === 401) {
          serverKnownRef.current = true;
        }
        reconcile();
      })
      .catch(() => {});

    let destroyed = false;
    let cleanup: (() => void) | undefined;

    import("@radixdlt/radix-dapp-toolkit").then(({ RadixDappToolkit, DataRequestBuilder }) => {
      if (destroyed) return;
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

      // The √ Connect button's request: one account, with proof of ownership.
      // One account because a session is bound to one ROLA-proven account; the
      // button's "update sharing" switches it, with a fresh proof.
      toolkit.walletApi.setRequestData(
        DataRequestBuilder.accounts().exactly(1).withProof()
      );

      // Every data response (connect, update sharing) is verified on the
      // server before the toolkit accepts it. Throwing rejects the login.
      toolkit.walletApi.dataRequestControl(async (walletData) => {
        const proof = walletData.proofs.find((p) => p.type === "account");
        if (!proof) throw new Error("No account proof in the wallet response");
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedChallenge: proof }),
        });
        if (!res.ok) throw new Error(`Sign-in verification failed (HTTP ${res.status})`);
        const { address } = (await res.json()) as { address: string };
        applyAuth(address);
        serverKnownRef.current = true;
      });

      // Set before subscribing: walletData$ can emit the restored state
      // synchronously inside subscribe(), and a sign-out decided there must be
      // able to disconnect this toolkit.
      toolkitRef.current = toolkit;
      const subscription = toolkit.walletApi.walletData$.subscribe((walletData) => {
        const next = walletData?.accounts ?? [];
        sharedRef.current = next.map((a) => a.address);
        walletKnownRef.current = true;
        setAccounts(next);
        reconcile();
      });

      cleanup = () => {
        subscription.unsubscribe();
        toolkit.destroy();
        toolkitRef.current = null;
      };
    });

    return () => {
      destroyed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendTransaction = useCallback(
    (input: SendTransactionInput) => {
      if (!toolkitRef.current) return undefined;
      return toolkitRef.current.walletApi.sendTransaction(input);
    },
    []
  );

  const ensureSession = useCallback(
    async (): Promise<boolean> => authAddressRef.current !== null,
    [],
  );

  const value: WalletContextValue = {
    connected: accounts.length > 0,
    accounts,
    sendTransaction,
    extensionDetected,
    authed: authAddress !== null,
    authAddress,
    ensureSession,
    signOut,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
