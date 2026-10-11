// Types ported from src/api-client.ts for the frontend

export interface CircuitBreakerState {
  errorTimestamps: number[];
  tripped: boolean;
  trippedAt: number | null;
}

/// GET /api/status — the PUBLIC reduced shape (DF-8): an error COUNT, never
/// the raw error strings. The full agent state is operator-only
/// (/api/agent/state).
export interface AgentStatus {
  running: boolean;
  halted: boolean;
  lastScan: number;
  errorCount: number;
  circuitBreaker: CircuitBreakerState;
  pendingTx: number;
}

export interface Position {
  id: number;
  pool_address: string;
  protocol: string;
  pool_name: string;
  deposited_xrd: number;
  current_value_xrd: number;
  apy_7d_ma: number;
  status: string;
  deposited_at: string;
  receipt_resource: string | null;
  /** Receipt NFT local ID — needed to build withdraw manifests. Supplied by server when available. */
  receipt_id: string | null;
  /** Fungible-LP positions (Basic/Weighted/DefiPlaza): the LP amount received — drives the withdraw. */
  lp_amount: string | null;
}

export interface Opportunity {
  pool_address: string;
  protocol: string;
  pool_name: string;
  /**
   * Composite 0-100 quality score from the server scorer. NOT a risk rating
   * and NOT a yield figure — it blends net APY, TVL stability, IL risk,
   * diversity and data quality. Never headline this; rank on
   * `risk_adjusted_return` and show `net_apy_ma_7d` as the number.
   */
  score: number;
  /** GROSS fee APY, before impermanent loss. Never show this alone. */
  apy_7d_ma: number;
  /**
   * Fee APY MINUS expected impermanent loss — what the position is actually
   * projected to return. This is the honest headline number and may be
   * negative; on Radix today it usually is.
   */
  net_apy_ma_7d: number;
  /** Expected annualised IL, as a negative percentage. 0 for IL-free venues. */
  estimated_il: number;
  /** 0-100 IL risk, higher = more divergence risk. */
  il_risk_score: number;
  /** Net return penalised by IL risk and volatility — the ranking signal. */
  risk_adjusted_return: number;
  tvl_usd: number;
  /**
   * True when the pair is classified stablecoin-ish by the scorer. This is a
   * pair-composition flag, NOT an audit status — the API previously served it
   * under the name `audited`, which it never was.
   */
  is_stable: boolean;
  /**
   * How the position earns. Drives whether IL is even applicable:
   * `amm-lp` carries IL; `staking` and `lending` are IL-free by construction.
   */
  yield_kind?: YieldKind;
  computed_at: string;
}

export type YieldKind = "amm-lp" | "staking" | "lending";

export interface PoolSnapshot {
  pool_address: string;
  tvl_usd: number;
  apy_7d_ma: number;
  scanned_at: string;
}

export interface RotationEntry {
  id: number;
  from_pool: string;
  to_pool: string;
  from_protocol: string;
  to_protocol: string;
  amount_xrd: number;
  reason: string;
  status: string;
  proposed_at: string;
}

export interface AppConfig {
  NETWORK_ID: number;
  GATEWAY_URL: string;
  SCAN_INTERVAL_MS: number;
  MIN_REBALANCE_DIFF_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  MAX_GAS_XRD: number;
  ROTATION_REVIEW_INTERVAL_MS: number;
  ROTATION_COOLDOWN_MS: number;
  AUTO_EXECUTE_THRESHOLD_XRD: number;
  APY_DROP_EXIT_PCT: number;
  TVL_DROP_EXIT_PCT: number;
  API_PORT: number;
  MIN_TVL_THRESHOLD: number;
}

export interface HarvestResult {
  success: boolean;
  message: string;
}

export interface RotationActionResult {
  success: boolean;
  id: number;
  status: string;
}

// ─── Validator board (GET /api/validators) ──────────────────────────────────
// What every validator ACTUALLY paid, measured as Δredemption from the
// ledger. Server semantics that the UI must respect: realizedApyPct 0 is a
// REAL value (the validator keeps everything) while null means "could not
// measure" — the two must never render the same.

export interface ValidatorRow {
  address: string;
  name: string | null;
  stakeXrd: number;
  /** The fee actually in force. */
  effectiveFeePct: number | null;
  /** The lazily-applied display field — shown only to expose divergence. */
  staleFeePct: number | null;
  feeFieldsDisagree: boolean;
  redemptionRate: number | null;
  realizedApyPct: number | null;
  paysNothing: boolean;
  /**
   * paysNothing at a VISIBLE 100% fee — a disclosed product (lottery, fund,
   * treasury), not a trap. Must render differently from the anomaly
   * (pays nothing while claiming a sub-100% fee).
   */
  zeroDisclosedByFee: boolean;
  /** In the current active set. An inactive zero-payer is expected. */
  activeInEpoch: boolean;
}

export interface ValidatorBoard {
  measuredAt: string;
  windowDays: number;
  rows: ValidatorRow[];
  /** Total active zero-payers (disclosed + anomalous). Do NOT headline this. */
  activeZeroPayerCount: number;
  activeZeroPayerStakeXrd: number;
  /** Visible 100% fee — zero payout is the stated product. */
  activeDisclosedZeroCount: number;
  activeDisclosedZeroStakeXrd: number;
  /** Claims a sub-100% fee, pays nothing — the real finding. */
  activeAnomalousZeroCount: number;
  activeAnomalousZeroStakeXrd: number;
  activeCount: number;
}

// ─── Account holdings (GET /api/holdings) ───────────────────────────────────
// What the ledger says the account holds — including stake and LP this app
// never recorded. xrdValue null means "could not price", which must never
// render as 0.

export type HoldingKind =
  | "xrd"
  | "validator-stake"
  | "lsulp"
  /** Weft V2 deposit unit (w2-XRD). `detail` is the `weft-v2:…` venue id. */
  | "weft-lending"
  | "pool-lp"
  | "unknown";

export interface Holding {
  resource: string;
  amount: string;
  kind: HoldingKind;
  label: string;
  detail: string | null;
  xrdValue: number | null;
  redemptionRate: number | null;
}

export interface HoldingsResult {
  account: string;
  holdings: Holding[];
  xrdValueTotal: number;
  unconvertibleCount: number;
}
