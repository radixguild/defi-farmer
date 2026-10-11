/// DeFi Farmer — Server Entry Point
/// Starts the agent loop and optional API server.

import './crash-guard.js'; // MUST be first import — logs uncaught exceptions
import { AgentLoop } from './agent/loop.js';
import { CONFIG } from './config.js';
import { getDb, closeDb } from './db/schema.js';
import { startApi } from './api.js';

async function main() {
  console.log('DeFi Farmer v0.1.0');
  console.log('==================');

  // Validate critical config at startup — triggers lazy init via requireEnv() (H4).
  // Non-custodial: no signing key at all — the agent never signs, so there is
  // no key/account to validate here (money moves only when the user signs).
  void CONFIG.API_AUTH_TOKEN;
  console.log('[config] Configuration validated (advisor — non-custodial, no signing)');

  // Initialize database
  getDb();
  console.log('[db] Database initialized');

  // Start agent
  const agent = new AgentLoop();
  agent.start();

  // Start API server
  startApi(agent);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[shutdown] Stopping...');
    agent.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  console.log('[main] Agent running. Press Ctrl+C to stop.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  closeDb();
  process.exit(1);
});
