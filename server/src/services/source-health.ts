/// Per-source health for the external data sources the agent reads.
///
/// WHY: a scanner that failed, or quietly returned nothing, used to vanish from
/// the index with no trace outside the server log. DefiPlaza did exactly that:
/// its Gateway path found no pairs (they moved into KeyValueStores the scan
/// cannot list) and returned [] without throwing, so the agent reported
/// errorCount 0 while a whole venue was missing. Each source now records its
/// last success, its last failure and a coarse failure kind.
///
/// Public vs operator: the public /api/status gets the kind only (DF-8 — raw
/// failure text carries upstream URLs and statuses); the operator state gets
/// the message too.

export type SourceErrorKind =
  | 'http_status'       // upstream answered with a non-2xx status
  | 'timeout'           // no answer in time
  | 'bad_response'      // answered, but not in the shape we read
  | 'empty'             // answered fine, but with zero usable rows
  | 'price_unavailable' // one or more prices could not be read
  | 'error';            // anything else

export interface SourceHealth {
  /// True when the most recent attempt succeeded.
  ok: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorKind: SourceErrorKind | null;
  /// Rows (or prices) the most recent successful attempt produced.
  lastRows: number | null;
  /// Raw failure text. Operator-only — never put this on a public route.
  lastError: string | null;
}

export type PublicSourceHealth = Omit<SourceHealth, 'lastError'>;

/// A scanner can throw this to name its failure kind precisely.
export class SourceError extends Error {
  constructor(public readonly kind: SourceErrorKind, message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

const health = new Map<string, SourceHealth>();

function entry(source: string): SourceHealth {
  let h = health.get(source);
  if (!h) {
    h = { ok: false, lastSuccessAt: null, lastErrorAt: null, lastErrorKind: null, lastRows: null, lastError: null };
    health.set(source, h);
  }
  return h;
}

export function recordSourceOk(source: string, rows: number, now: number = Date.now()): void {
  const h = entry(source);
  h.ok = true;
  h.lastSuccessAt = now;
  h.lastRows = rows;
}

export function recordSourceError(
  source: string,
  kind: SourceErrorKind,
  message: string,
  now: number = Date.now(),
): void {
  const h = entry(source);
  h.ok = false;
  h.lastErrorAt = now;
  h.lastErrorKind = kind;
  h.lastError = message.slice(0, 300);
}

/// Map a thrown value to a failure kind. SourceError names its own kind; for
/// anything else, read the message the way our fetch helpers word it.
export function classifySourceError(err: unknown): SourceErrorKind {
  if (err instanceof SourceError) return err.kind;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/abort|timeout|timed out/i.test(msg)) return 'timeout';
  if (/SyntaxError|JSON|shape/i.test(msg)) return 'bad_response';
  // Our scanners word these as "<Source> returned 404" / "Ociswap /pools 500".
  if (/\b[45]\d\d\b/.test(msg)) return 'http_status';
  return 'error';
}

/// Record the outcome of one source attempt: rows > 0 is a success, zero rows
/// is the silent failure this module exists to surface, a throw is classified.
export function recordSourceOutcome(
  source: string,
  outcome: { rows: number } | { error: unknown },
  now: number = Date.now(),
): void {
  if ('error' in outcome) {
    const e = outcome.error;
    recordSourceError(source, classifySourceError(e), e instanceof Error ? e.message : String(e), now);
  } else if (outcome.rows > 0) {
    recordSourceOk(source, outcome.rows, now);
  } else {
    recordSourceError(source, 'empty', 'source returned 0 rows', now);
  }
}

/// Full health, incl. raw failure text — operator routes only.
export function getSourceHealth(): Record<string, SourceHealth> {
  const out: Record<string, SourceHealth> = {};
  for (const [k, v] of health) out[k] = { ...v };
  return out;
}

/// The public shape: no raw failure text (DF-8).
export function getPublicSourceHealth(): Record<string, PublicSourceHealth> {
  const out: Record<string, PublicSourceHealth> = {};
  for (const [k, v] of health) {
    const { lastError: _omit, ...pub } = v;
    out[k] = pub;
  }
  return out;
}

/// Tests only.
export function resetSourceHealthForTests(): void {
  health.clear();
}
