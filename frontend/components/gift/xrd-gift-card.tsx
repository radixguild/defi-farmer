"use client";

import { CopyButton } from "@/components/copy-button";
import { GiftQr } from "./gift-qr";

/**
 * XRD gift rail — address, QR, copy. No send control, on purpose.
 *
 * Upstream (the Guild app) has a "send from your connected wallet" button here.
 * It is NOT ported, because in THIS app sending means building a manifest, and
 * the standing rule is that every manifest is Gateway-dry-run preview-gated
 * before it can reach a wallet (CLAUDE.md, services/dex/preview.ts). A gift
 * transfer is trivial to build and would still be the first unpreviewed money
 * path in the codebase. If a send control is ever wanted, route it through the
 * existing build → preview → sign lane rather than around it.
 *
 * The donor pastes or scans into their own wallet, exactly as they do for BTC.
 * There is no Radix equivalent of BIP-21 with broad wallet support, so the QR
 * carries the bare address — every Radix wallet's scanner reads that.
 *
 * `address` is already bech32m-checksum-validated by lib/gift — this component
 * never sees an unchecked destination.
 */
export function XrdGiftCard({ address }: { address: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <GiftQr value={address} label="Radix account address for gifts" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs text-muted-foreground">
          Scan with the Radix Wallet, or copy the address below and send any amount of XRD from
          your own wallet.
        </p>
        {/* Full address, never truncated — the clipboard fallback and the only
            way a donor can check what they pasted. */}
        <code className="block break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-primary">
          {address}
        </code>
        <CopyButton value={address} label="Copy address" />
      </div>
    </div>
  );
}
