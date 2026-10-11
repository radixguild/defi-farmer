"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type HealthStatus = "healthy" | "warning" | "critical";

interface HealthDotProps {
  status: HealthStatus;
  className?: string;
}

const statusColors: Record<HealthStatus, string> = {
  healthy: "bg-profit-green",
  warning: "bg-risk-yellow",
  critical: "bg-loss-red",
};

const statusLabels: Record<HealthStatus, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
};

export function HealthDot({ status, className }: HealthDotProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={statusLabels[status]}
    >
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full",
          statusColors[status]
        )}
      />
      <span className="text-xs text-muted-foreground">
        {statusLabels[status]}
      </span>
    </span>
  );
}
