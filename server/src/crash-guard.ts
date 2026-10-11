/// Crash guard — global uncaught exception / unhandled rejection handlers.
///
/// Import as the FIRST line of your entry point (before any other imports):
///   import './crash-guard.js';
///
/// Logs full stack traces to a dedicated crash log file so crashes are
/// never silent. The process manager will still restart the server process,
/// but now you'll have the actual error in the logs instead of empty output.
///
/// Usage:
///   - Add `import './crash-guard.js';` at the top of each service's entry point
///   - Set CRASH_LOG_DIR env var to override log location (default: ./logs)
///   - Set CRASH_LOG_MAX_MB to limit log file size (default: 10)

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_DIR = process.env.CRASH_LOG_DIR || './logs';
const MAX_LOG_BYTES = (parseInt(process.env.CRASH_LOG_MAX_MB || '10', 10)) * 1024 * 1024;

// Ensure log directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

function crashLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `crash-${date}.log`);
}

function writeCrashLog(level: string, error: unknown, origin?: string): void {
  const timestamp = new Date().toISOString();
  const message = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack || '(no stack)'}`
    : String(error);

  const line = `[${timestamp}] ${level}${origin ? ` [origin: ${origin}]` : ''}\n${message}\n---\n`;

  const filePath = crashLogPath();

  try {
    // Rotate if too large
    const stat = fs.statSync(filePath).size;
    if (stat > MAX_LOG_BYTES) {
      fs.renameSync(filePath, `${filePath}.old`);
    }
  } catch { /* file doesn't exist yet */ }

  try {
    fs.appendFileSync(filePath, line);
  } catch {
    // Last resort: write to stderr
    process.stderr.write(line);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (error, origin) => {
  writeCrashLog('UNCAUGHT_EXCEPTION', error, origin);
  console.error('[crash-guard] UNCAUGHT EXCEPTION — see crash log for details');
  console.error(error.message);
  // Let the process die — the process manager will restart it. But now we have the log.
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  writeCrashLog('UNHANDLED_REJECTION', reason);
  console.error('[crash-guard] UNHANDLED REJECTION — see crash log for details');
  if (reason instanceof Error) console.error(reason.message);
  // Don't exit on unhandled rejection — Node.js warns but continues.
  // The promise rejection is logged; the service may still be functional.
});

// ─── Signal handlers for clean shutdown logging ───────────────────────────────

let shuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  writeCrashLog('SIGNAL', `Received ${signal} — shutting down gracefully`);
  console.log(`[crash-guard] Received ${signal}, shutting down`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

console.log('[crash-guard] Installed — uncaught exceptions will be logged to', crashLogPath());
