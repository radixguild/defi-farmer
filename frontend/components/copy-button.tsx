"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

// Small client leaf: copies a value to the clipboard with a brief "Copied"
// confirmation. Written for the gift destinations — hence `value`, not `url`.
//
// CONTRACT: the value must ALSO be rendered next to the button, so manual copy
// still works when the Clipboard API is unavailable (insecure context, denied
// permission). The catch below is deliberately silent — a failed copy has no
// error UI, and the visible value is the entire fallback. On /gift this
// matters more than usual: a donor who cannot copy the address must be able to
// read it and type it.
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the visible value remains the fallback.
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={copy} className="shrink-0 gap-2">
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
