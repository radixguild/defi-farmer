"use client";

import { ShieldCheck, ShieldQuestion, ShieldAlert, Landmark } from "lucide-react";
import { getAuditInfo } from "@/lib/audit-data";
import { cn } from "@/lib/utils";

interface AuditBadgeProps {
  protocol: string;
  /** "compact" — pill on the card. "full" — labelled row on the detail page. */
  variant?: "compact" | "full";
  className?: string;
}

/**
 * Renders what we actually know about a protocol's security posture.
 *
 * This used to render a green "Audited · <firm>" shield for every protocol from
 * a hardcoded table whose report links 404'd. It now renders "Audit unverified"
 * in a neutral tone unless a real, resolving audit is on file — an honest
 * absence of a claim rather than a comfortable false one. Neutral, not red:
 * unverified means we have not checked, which is different from knowing there
 * is no audit.
 */
export function AuditBadge({
  protocol,
  variant = "compact",
  className,
}: AuditBadgeProps) {
  const info = getAuditInfo(protocol);

  const tone =
    info.status === "verified"
      ? {
          text: "text-profit-green",
          icon: ShieldCheck,
          label: `Audited · ${info.auditFirm}`,
        }
      : info.status === "protocol-native"
      ? {
          text: "text-profit-green",
          icon: Landmark,
          label: "Radix protocol · no contract risk",
        }
      : info.status === "none"
      ? {
          text: "text-loss-red",
          icon: ShieldAlert,
          label: "No public audit",
        }
      : {
          text: "text-muted-foreground",
          icon: ShieldQuestion,
          label: "Audit unverified",
        };

  const Icon = tone.icon;

  if (variant === "compact") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium",
          tone.text,
          className,
        )}
        title={info.custodyDisclosure}
      >
        <Icon className="h-3 w-3" />
        {tone.label}
      </span>
    );
  }

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", tone.text)} />
      <div className="flex-1">
        <p className="text-sm font-medium">{tone.label}</p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {info.custodyDisclosure}
        </p>
        {info.status === "verified" && info.auditUrl && (
          <a
            href={info.auditUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline mt-1 inline-block"
          >
            Read audit · {info.auditDate}
          </a>
        )}
        {info.status !== "verified" && info.protocolUrl && (
          <a
            href={info.protocolUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline mt-1 inline-block"
          >
            Check {info.protocolLabel} yourself
          </a>
        )}
      </div>
    </div>
  );
}
