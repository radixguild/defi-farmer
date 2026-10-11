"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { BTC_PRESETS, bip21Uri } from "@/lib/gift";
import { GiftQr } from "./gift-qr";

const ANY = "any" as const;

/**
 * BTC gift rail. A BIP-21 URI carries the amount, so unlike the XRD rail the
 * QR changes as the donor picks a preset — scan and the amount is already
 * filled in. "Any amount" drops the amount parameter entirely rather than
 * sending a zero.
 *
 * PRIVACY, stated plainly because donors deserve to know: this is ONE static
 * address. Every gift to it is publicly linkable to every other, forever, and
 * to whoever else has seen it. Rotating per donor (BIP-47 payment codes, or an
 * xpub with a fresh derived address per view) is deliberately NOT built — it
 * needs key material this app must never hold. The page says so out loud
 * rather than letting a donor assume otherwise.
 *
 * `address` is already validated by lib/gift (bech32-checksummed for bc1…) —
 * this component never sees an unchecked destination.
 */
export function BtcGiftCard({ address }: { address: string }) {
  const [amount, setAmount] = useState<string>(ANY);
  const uri = bip21Uri(address, amount === ANY ? undefined : amount, "DeFi Farmer");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {BTC_PRESETS.map((p) => (
          <Button
            key={p}
            type="button"
            variant={amount === p ? "default" : "outline"}
            size="sm"
            onClick={() => setAmount(p)}
          >
            {p} BTC
          </Button>
        ))}
        <Button
          type="button"
          variant={amount === ANY ? "default" : "outline"}
          size="sm"
          onClick={() => setAmount(ANY)}
        >
          Any amount
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <GiftQr
          value={uri}
          label={
            amount === ANY
              ? "Bitcoin address for gifts"
              : `Bitcoin payment code for ${amount} BTC`
          }
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">
            Scan with a Bitcoin wallet
            {amount === ANY ? "" : ` — the ${amount} BTC amount is filled in for you`}, or copy
            the address below.
          </p>
          {/* Full address, never truncated — the clipboard fallback and the
              only way a donor can check what they pasted. */}
          <code className="block break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-primary">
            {address}
          </code>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={address} label="Copy address" />
            {/* A bitcoin: link opens a desktop/mobile wallet if one is
                registered for the scheme, and does nothing otherwise — which is
                why the address and QR above are not conditional on it. */}
            <a
              href={uri}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")}
            >
              Open in wallet
            </a>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        One static address — gifts to it are publicly linkable on the Bitcoin ledger. Per-donor
        addresses are not implemented.
      </p>
    </div>
  );
}
