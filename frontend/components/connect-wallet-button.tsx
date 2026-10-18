"use client";

import { cn } from "@/lib/utils";

interface ConnectWalletButtonProps {
  className?: string;
}

/**
 * The Radix dApp Toolkit's own √ Connect button, and the app's only wallet UI.
 * It handles every state itself: desktop Connector-extension pairing, the mobile
 * deep link to the Radix Wallet app, the shared account and persona, update
 * sharing, and disconnect. Connecting is signing in (lib/radix-provider.tsx).
 *
 * Mount it ONCE (app/layout.tsx). The toolkit wires up only the first
 * `<radix-connect-button>` in the document, so a second copy anywhere, even a
 * hidden one, would render as a button that does nothing.
 */
export function ConnectWalletButton({ className }: ConnectWalletButtonProps) {
  return (
    <div className={cn("flex items-center", className)}>
      <radix-connect-button />
    </div>
  );
}
