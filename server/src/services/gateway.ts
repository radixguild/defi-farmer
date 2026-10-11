/// Radix Gateway API client — pool scanning, position tracking, tx verification.
/// Uses BigInt-safe parsing. Never uses parseFloat for token amounts.
///
/// Resilience: 30s AbortController timeout per request, exponential backoff
/// with full jitter on transient failures (5xx, network errors). 4xx errors
/// are never retried. Max 3 retries, total worst-case ~105s per call.

import { CONFIG } from '../config.js';

/// Pair risk attached by the enricher (pool-enricher.ts) — feeds the IL/risk
/// math in scorer/calculators. 'default' = the skeptical prior used when the
/// price feed had no usable history for the pair.
export interface PoolRisk {
  /// Daily stdev of log returns, averaged over the two tokens.
  volatility: number;
  /// Correlation of the tokens' daily returns (−1..1).
  correlation: number;
  /// Annualized vol of the A/B price ratio.
  relAnnualVol: number;
  /// Expected annual IL % (negative), E[IL] ≈ −σ_rel²/8.
  estimatedIlPct: number;
  source: 'live' | 'default';
}

/// How a venue produces yield. Decides whether impermanent loss applies at all:
/// 'amm-lp' holds two assets and suffers divergence loss, while 'staking'
/// (native XRD validator delegation, LSU pools) and 'lending' (single-asset
/// supply) cannot diverge against themselves and are IL-free by construction.
/// Charging those the IL model's estimate would understate them by ~12-20%/yr.
export type YieldKind = 'amm-lp' | 'staking' | 'lending';

export interface PoolInfo {
  address: string;
  name: string;
  tokenA: string;
  tokenB: string;
  tvl: string; // string to preserve precision
  apy: number; // percentage, ok as float for display
  protocol: string;
  audited: boolean;
  apySource: 'live' | 'estimated' | 'unknown';
  /// Length in days of the window `apy` was measured over, when the scanner
  /// measured one. Set it and the scorer will NOT re-average the figure across
  /// its own 7-day snapshot window — a realized 30d yield is already smooth,
  /// and averaging it again yields a number that matches neither the window the
  /// row is named for nor the venue. Leave undefined for a spot/instantaneous
  /// APY, which does want the 7d moving average.
  apyWindowDays?: number;
  /// Defaults to 'amm-lp' when a scanner does not say — the conservative
  /// choice, since it applies IL rather than silently waiving it.
  yieldKind?: YieldKind;
  /// Runtime-resolved blueprint kind (dex/pool-resolver) — 'unsupported' pools
  /// are excluded from scoring/allocation (the deposit builder refuses them).
  kind?: import('./dex/pool-resolver.js').PoolKind;
  risk?: PoolRisk;
}

interface TransactionStatus {
  status: 'CommittedSuccess' | 'CommittedFailure' | 'Pending' | 'Unknown';
  epoch: number;
  events: Record<string, unknown>[];
}

export interface CommittedTx {
  status: string;
  affectedEntities: string[];
  fungible: Array<{ entity: string; resource: string; change: string }>;
  nonFungible: Array<{ entity: string; resource: string; added: string[]; removed: string[] }>;
}

interface BalanceChange {
  resourceAddress: string;
  amount: string; // string — never parse as float
}

// ─── Entity-details (Global) shapes — for pool blueprint resolution ────────────
// Programmable state comes back as a recursive field tree; native pools expose
// pool_unit_resource_address + vaults; internal vaults expose resource_address.

export interface GwStateField {
  field_name?: string;
  kind?: string;
  value?: string;
  variant_name?: string;
  variant_id?: number;
  fields?: GwStateField[];
}

export interface GwEntityItem {
  address: string;
  details?: {
    type?: string;
    blueprint_name?: string;
    package_address?: string;
    state?: {
      fields?: GwStateField[];
      // native TwoResourcePool / internal vault shapes:
      pool_unit_resource_address?: string;
      vaults?: Array<{ resource_address?: string }>;
      resource_address?: string;
    };
  };
  metadata?: { items?: Array<{ key: string; value?: { typed?: { value?: string } } }> };
}

// ─── Transaction preview shapes (the sign-gate) ───────────────────────────────

export interface PreviewResourceChange {
  resource_address: string;
  component_entity?: { entity_address?: string };
  amount: string; // signed decimal string — negative = leaving the account
}

export interface PreviewResponse {
  receipt?: {
    status?: string; // 'Succeeded' | 'Failed' | 'Rejected'
    error_message?: string | null;
    fee_summary?: Record<string, string>;
  };
  resource_changes?: Array<{ index: number; resource_changes: PreviewResourceChange[] }>;
}

// ─── Retry helpers ────────────────────────────────────────────────────────────

const RETRY_MAX = 3;
const RETRY_BASE_MS = 1000;       // 1s initial backoff
const RETRY_MAX_MS = 30_000;      // 30s cap
const FETCH_TIMEOUT_MS = 30_000;  // per-request timeout

/** Errors that should be retried (transient). Everything else fails fast. */
function isRetryable(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const msg = String(err);
  if (/socket.*closed|fetch failed|network.*error|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
  if (/5\d\d/.test(msg)) return true;
  if (/429/.test(msg)) return true;
  return false;
}

/** Exponential backoff with full jitter. */
function backoff(attempt: number): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt));
  return Math.random() * exp; // full jitter
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with retry + backoff. Never retries 4xx. */
async function fetchRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  maxRetries: number = RETRY_MAX,
): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`Gateway ${url} failed: ${resp.status} ${resp.statusText}`);
      }
      if (!resp.ok) {
        throw new Error(`Gateway ${url} failed: ${resp.status} ${resp.statusText}`);
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      if (!isRetryable(err)) throw err;
      const delay = backoff(attempt);
      console.warn(`[gateway] Retry ${attempt + 1}/${maxRetries} for ${url} in ${Math.round(delay)}ms: ${String(err).slice(0, 120)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

// ─── GatewayClient ────────────────────────────────────────────────────────────

export class GatewayClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = CONFIG.GATEWAY_URL;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetchRetry(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json() as Promise<T>;
  }

  /// Get current epoch
  async getCurrentEpoch(): Promise<number> {
    const data = await this.post<{ ledger_state: { epoch: number } }>(
      '/status/gateway-status',
      {}
    );
    return data.ledger_state.epoch;
  }

  /// Get component state (vault balances, etc.)
  async getComponentState(address: string): Promise<Record<string, unknown>> {
    return this.post('/state/entity/details', {
      addresses: [address],
      aggregation_level: 'Vault',
      opt_ins: { explicit_metadata: ['name'] },
    });
  }

  /// Get account token balances.
  ///
  /// Two shape facts this must respect (it silently returned [] for every
  /// account until 2026-08-10, caught by the first live caller):
  ///   - the response nests under items[0] — there is no top-level
  ///     fungible_resources on the envelope;
  ///   - only Global aggregation carries a per-resource `amount`; Vault
  ///     aggregation returns {vaults:{items:[…]}} with NO aggregate field.
  async getAccountBalances(account: string): Promise<BalanceChange[]> {
    const data = await this.post<{
      items?: Array<{
        fungible_resources?: { items?: { resource_address?: string; amount?: string }[] };
      }>;
    }>('/state/entity/details', {
      addresses: [account],
      aggregation_level: 'Global',
    });

    return (data.items?.[0]?.fungible_resources?.items ?? []).flatMap((item) =>
      item.resource_address && item.amount !== undefined
        ? [{ resourceAddress: item.resource_address, amount: item.amount }]
        : [],
    );
  }

  /// Submit a compiled transaction
  async submitTransaction(compiledHex: string): Promise<{ intentHash: string; duplicate: boolean }> {
    const data = await this.post<{ duplicate: boolean }>('/transaction/submit', {
      notarized_transaction_hex: compiledHex,
    });
    return {
      intentHash: '',
      duplicate: data.duplicate || false,
    };
  }

  /// Poll transaction status until committed or timeout
  async waitForCommit(
    intentHash: string,
    timeoutMs: number = 90_000,
    intervalMs: number = 3_000
  ): Promise<TransactionStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await this.post<{ status: string; epoch?: number }>(
        '/transaction/status',
        { intent_hash: intentHash },
      );
      if (data.status === 'CommittedSuccess') {
        return { status: 'CommittedSuccess', epoch: data.epoch || 0, events: [] };
      }
      if (data.status === 'CommittedFailure') {
        return { status: 'CommittedFailure', epoch: 0, events: [] };
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { status: 'Unknown', epoch: 0, events: [] };
  }

  /// Get committed transaction details with balance changes
  async getTransactionDetails(intentHash: string): Promise<{
    balanceChanges: BalanceChange[];
    events: Record<string, unknown>[];
  }> {
    const data = await this.post<{
      transaction: {
        balance_changes?: { fungible_balance_changes?: Record<string, Record<string, string>> };
        receipt?: { events?: { data?: unknown }[] };
      };
    }>('/transaction/committed-details', {
      intent_hash: intentHash,
      opt_ins: { balance_changes: true, receipt_events: true },
    });

    const balanceChanges: BalanceChange[] = [];
    const fungibleChanges = data.transaction?.balance_changes?.fungible_balance_changes || {};
    for (const [, resources] of Object.entries(fungibleChanges)) {
      for (const [resourceAddr, amount] of Object.entries(resources)) {
        balanceChanges.push({ resourceAddress: resourceAddr, amount });
      }
    }
    return {
      balanceChanges,
      events: (data.transaction?.receipt?.events || []) as Record<string, unknown>[],
    };
  }

  /// Committed-details with per-entity fungible + non-fungible changes and
  /// affected entities — what position recording (D5) verifies against.
  /// Unlike getTransactionDetails above, this keeps the entity dimension:
  /// "WHO received the receipt NFT" is the whole point.
  async getCommittedTransaction(intentHash: string): Promise<CommittedTx> {
    const data = await this.post<{
      transaction?: {
        transaction_status?: string;
        affected_global_entities?: string[];
        balance_changes?: {
          fungible_balance_changes?: Array<{
            entity_address?: string;
            resource_address?: string;
            balance_change?: string;
          }>;
          non_fungible_balance_changes?: Array<{
            entity_address?: string;
            resource_address?: string;
            added?: string[];
            removed?: string[];
          }>;
        };
      };
    }>('/transaction/committed-details', {
      intent_hash: intentHash,
      opt_ins: { balance_changes: true, affected_global_entities: true },
    });

    const tx = data.transaction ?? {};
    const bc = tx.balance_changes ?? {};
    return {
      status: tx.transaction_status ?? 'Unknown',
      affectedEntities: tx.affected_global_entities ?? [],
      fungible: (bc.fungible_balance_changes ?? []).map((c) => ({
        entity: c.entity_address ?? '',
        resource: c.resource_address ?? '',
        change: c.balance_change ?? '0',
      })),
      nonFungible: (bc.non_fungible_balance_changes ?? []).map((c) => ({
        entity: c.entity_address ?? '',
        resource: c.resource_address ?? '',
        added: c.added ?? [],
        removed: c.removed ?? [],
      })),
    };
  }

  /// Entity details with GLOBAL aggregation — for pool blueprint resolution
  /// (dex/pool-resolver.ts). Callers read details.blueprint_name / package_address
  /// / state.fields, and native-pool state (pool_unit_resource_address, vaults).
  async entityDetailsGlobal(
    addresses: string[],
    optIns: Record<string, unknown> = {},
  ): Promise<{ items: GwEntityItem[] }> {
    return this.post('/state/entity/details', {
      addresses,
      aggregation_level: 'Global',
      opt_ins: optIns,
    });
  }

  /// Dry-run a manifest against current ledger state — NO signature, NO key,
  /// NO submission, NO state change (the non-custodial safety keystone). Gate
  /// signing on receipt.status === 'Succeeded'; resource_changes is the exact
  /// per-account movement the wallet will show. `end_epoch_exclusive` (not
  /// inclusive) is load-bearing — an unknown field is silently dropped and the
  /// request fails InvalidEpochRange.
  async previewTransaction(manifest: string, epoch: number): Promise<PreviewResponse> {
    return this.post('/transaction/preview', {
      manifest,
      start_epoch_inclusive: epoch,
      end_epoch_exclusive: epoch + 10,
      tip_percentage: 0,
      nonce: 1,
      signer_public_keys: [],
      flags: {
        use_free_credit: true,
        assume_all_signature_proofs: true,
        skip_epoch_check: true,
      },
    });
  }

  /// Batch-read entity details for multiple addresses
  async batchEntityDetails(addresses: string[]): Promise<{
    items: Array<{
      address: string;
      details?: {
        state?: {
          fields?: Array<{ field_name?: string; value?: string; type_name?: string; entries?: unknown[] }>;
        };
      };
      fungible_resources?: {
        items: Array<{
          resource_address: string;
          vaults?: { items: Array<{ amount: string }> };
        }>;
      };
      metadata?: {
        items: Array<{ key: string; value: { typed: { value: string } } }>;
      };
    }>;
  }> {
    return this.post('/state/entity/details', {
      addresses,
      aggregation_level: 'Vault',
      opt_ins: { explicit_metadata: ['name', 'symbol'] },
    });
  }
}

// ─── Shared fetch helper for non-Gateway HTTP calls ───────────────────────────

/**
 * Resilient fetch for external APIs (Ociswap, DefiPlaza stats).
 * Uses the same retry+backoff strategy as GatewayClient.post.
 */
export async function resilientFetch(
  url: string,
  timeoutMs: number = 15_000,
  maxRetries: number = 2,
): Promise<Response> {
  return fetchRetry(url, {}, timeoutMs, maxRetries);
}
