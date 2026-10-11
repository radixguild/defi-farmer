"use client";

import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { AuditBadge } from "@/components/audit-badge";
import type { Opportunity } from "@/lib/types";

interface TrustPanelProps {
  opportunity: Opportunity;
}

/**
 * Consolidated "should I trust this pool?" surface for the opportunity detail
 * page. This is the dapp's load-bearing trust surface — the single screen the
 * user sees before they decide to deposit, so it must contain only claims we
 * can stand behind.
 *
 * The "Curated by DeFi Farmer" block was removed: its allowlist keyed on mock
 * `pool_rdx1…` addresses that matched zero live pools, and it asserted weekly
 * hand-review that never happened.
 */
export function TrustPanel({ opportunity }: TrustPanelProps) {
  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-3">
            Audit &amp; custody
          </p>
          <AuditBadge protocol={opportunity.protocol} variant="full" />
        </div>

        <div className="border-t pt-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Self-custody
          </p>
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-profit-green" />
            <p className="text-sm text-muted-foreground">
              This dapp never holds your keys. Every action you take is a
              manifest your own Radix Wallet signs. You can withdraw at any
              time without asking us. The Radix Wallet shows its own
              decoded view at sign time — verify it matches our preview.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
