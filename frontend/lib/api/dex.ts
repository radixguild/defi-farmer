/**
 * Client for the non-custodial real-DEX endpoints:
 *   GET  /api/dex/pool-info  — resolved pool identity + range suggestion
 *   POST /api/dex/build      — resolve → range → build → GATEWAY-PREVIEW
 * Both are public tier and reach the backend through the same-origin catch-all
 * proxy (app/api/[...path]/route.ts). Money moves only when the USER signs the
 * returned manifest in their own wallet.
 */

export class DexApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DexApiError";
  }
}

export interface RangeSuggestion {
  multiple: number;
  concentration: number;
  timeInRange: number;
  feeApr: number;
  ilApr: number;
  exitsPerYear: number;
  rerangeApr: number;
  netApr: number;
}

export interface DexPoolInfo {
  address: string;
  kind:
    | "ociswap_basic"
    | "ociswap_precision"
    | "caviarnine_weighted"
    | "caviarnine_quantaswap"
    | "defiplaza_pair"
    // Single-sided venues (one XRD amount, no range, no second leg).
    | "native_stake"
    | "weft_lending"
    | "lsulp"
    | "unsupported";
  protocol: string;
  concentrated: boolean;
  tokenX: string;
  tokenY: string;
  lpKind: "fungible" | "nft" | "defiplaza";
  shortage?: string;
  suggestion?: RangeSuggestion;
  relAnnualVol?: number;
}

export interface DexMovement {
  resource: string;
  /** Signed decimal string: negative leaves the account, positive is received. */
  amount: string;
}

export interface DexPreview {
  ok: boolean;
  status: string;
  error?: string;
  feeXrd?: string;
  movements: DexMovement[];
}

/** A Stake Claim NFT in the unbonding queue. Amount is FIXED at unstake time. */
export interface StakeClaim {
  validator: string;
  claimNftResource: string;
  localId: string;
  claimEpoch: number;
  claimAmountXrd: string;
  currentEpoch: number;
  epochsRemaining: number;
  ready: boolean;
  /** ISO-8601 estimate of when `ready` flips; null once ready. */
  readyAtEstimate: string | null;
}

export interface DexBuildResult {
  manifest: string;
  preview: DexPreview;
  pool: {
    address: string;
    kind: string;
    protocol: string;
    tokenX: string;
    tokenY: string;
    concentrated: boolean;
  };
  range?: { left: number; right: number } | { bins: number[] };
  /** DefiPlaza: the single-sided add needs the other token too — re-request with coAmount. */
  needsCoLiquidity?: { otherToken: string };
  /**
   * Plain-language warning that MUST be shown beside the preview. Set on exits
   * that do not simply return XRD — above all an unstake, which returns a claim
   * receipt and locks the XRD for ~7 days. The dry-run cannot express this: an
   * unstake previews perfectly happily and still leaves the user with no XRD.
   */
  notice?: string;
  /** action:"claim" only — what the claim is worth and when it unlocks. */
  claim?: StakeClaim;
}

export interface DexBuildRequest {
  action: "deposit" | "withdraw" | "claim";
  account: string;
  poolAddress: string;
  // deposit — two-sided + concentrated:
  amountX?: string;
  amountY?: string;
  range?: { multiple?: number; below?: number; above?: number; loPrice?: string; hiPrice?: string };
  // deposit — DefiPlaza single-sided:
  inputToken?: string;
  inputAmount?: string;
  coAmount?: string;
  // withdraw:
  lpAmount?: string;
  lpToken?: string;
  localId?: string;
  // single-sided venue exits:
  /** Native staking: the validator to unstake from / claim at. */
  validator?: string;
  /** LSULP exit terminus: "lsu" (instant, default) or "xrd" (starts unbonding). */
  exitTo?: "lsu" | "xrd";
}

export interface StakeClaimsResult {
  account: string;
  claims: StakeClaim[];
}

async function handle<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!res.ok) {
    throw new DexApiError(body?.error ?? `HTTP ${res.status}`, res.status);
  }
  if (!body) throw new DexApiError("Empty response from server", res.status);
  return body;
}

export async function getPoolInfo(address: string): Promise<DexPoolInfo> {
  const res = await fetch(`/api/dex/pool-info?address=${encodeURIComponent(address)}`);
  return handle<DexPoolInfo>(res);
}

export async function buildDex(request: DexBuildRequest): Promise<DexBuildResult> {
  const res = await fetch("/api/dex/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return handle<DexBuildResult>(res);
}

/**
 * The signed-in account's pending Stake Claim NFTs (the unbonding queue).
 * Session tier — the cookie is same-origin, so no address is passed.
 */
export async function getStakeClaims(): Promise<StakeClaimsResult> {
  const res = await fetch("/api/holdings/claims");
  return handle<StakeClaimsResult>(res);
}
