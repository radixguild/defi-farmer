import { AgentStatus } from "@/lib/types";

export const mockAgentStatus: AgentStatus = {
  running: true,
  halted: false,
  lastScan: Date.now() - 60000,
  errorCount: 0,
  circuitBreaker: {
    errorTimestamps: [],
    tripped: false,
    trippedAt: null,
  },
  pendingTx: 0,
};
