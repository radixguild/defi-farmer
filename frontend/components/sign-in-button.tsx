"use client";

import { useState } from "react";
import { LogIn, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { useWallet } from "@/lib/hooks/use-wallet";
import { Button } from "@/components/ui/button";

function shortAddress(address: string): string {
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}

/**
 * ROLA session control. Renders nothing until a wallet is connected —
 * connecting is the ConnectWalletButton's job; this is the "prove it" step.
 */
export function SignInButton({ className }: { className?: string }) {
  const { connected, authed, authAddress, sessionMismatch, signIn, signOut } = useWallet();
  const [busy, setBusy] = useState(false);

  if (!connected && !authed) return null;

  if (!authed) {
    return (
      <Button
        size="sm"
        variant="outline"
        className={className}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await signIn();
          } finally {
            setBusy(false);
          }
        }}
      >
        <LogIn className="mr-2 h-4 w-4" />
        {busy ? "Check your wallet…" : "Sign in"}
      </Button>
    );
  }

  return (
    <div className={className}>
      <div
        className="flex items-center gap-2 text-xs"
        title={
          sessionMismatch
            ? "Signed in as an account the wallet no longer shares — sign in again with a shared account."
            : `Signed in as ${authAddress}`
        }
      >
        {sessionMismatch ? (
          <ShieldAlert className="h-4 w-4 text-risk-yellow shrink-0" />
        ) : (
          <ShieldCheck className="h-4 w-4 text-profit-green shrink-0" />
        )}
        <span className="truncate font-mono text-muted-foreground">
          {authAddress ? shortAddress(authAddress) : ""}
        </span>
        <button
          type="button"
          aria-label="Sign out"
          className="text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => void signOut()}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
