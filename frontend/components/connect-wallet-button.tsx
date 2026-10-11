"use client";

import { useWallet } from "@/lib/hooks/use-wallet";
import { cn } from "@/lib/utils";

interface ConnectWalletButtonProps {
  className?: string;
}

export function ConnectWalletButton({ className }: ConnectWalletButtonProps) {
  const { connected, accounts } = useWallet();

  if (connected && accounts.length > 0) {
    const address = accounts[0].address;
    const truncated = `${address.slice(0, 12)}...${address.slice(-6)}`;
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="h-2 w-2 rounded-full bg-profit-green" />
          <span className="font-mono text-xs">{truncated}</span>
        </div>
      </div>
    );
  }

  // Always render RDT's own connect button — it handles every state itself:
  // desktop Connector-extension pairing AND the mobile deep-link to the Radix
  // Wallet app. This used to sit behind a `window.radixWalletConnector` probe
  // that dead-ended BOTH desktop-without-connector and every mobile user on a
  // static "Install" link, so the button that actually connects never rendered.
  return (
    <div className={cn("flex items-center", className)}>
      <radix-connect-button />
    </div>
  );
}
