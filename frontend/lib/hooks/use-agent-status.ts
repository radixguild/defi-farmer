"use client";

import { AgentStatus } from "@/lib/types";
import { mockAgentStatus } from "@/lib/mocks";
import { useFetch } from "./use-fetch";

// Agent state (running, errors, circuit breaker) drives the operator alert
// dot — fast refresh so the UI feels live during incidents.
export function useAgentStatus() {
  return useFetch<AgentStatus>("/api/status", mockAgentStatus, {
    refreshIntervalMs: 10_000,
  });
}
