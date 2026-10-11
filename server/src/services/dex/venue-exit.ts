/// Ledger reads the single-sided venue EXITS need, plus the pure math that turns
/// a Stake Claim NFT into "can I claim this yet, and when".
///
/// Split from venue-manifests.ts on purpose: the builders there are pure string
/// assembly and stay unit-testable without a Gateway, while everything here
/// touches the network. The rule this module enforces is the same one
/// docs/DEX-INTEGRATION.md opens with — DO NOT TRUST THE CALLER'S LABELS.
/// An exit is spending real positions, so every resource address that reaches a
/// manifest is resolved from the issuing entity's own state:
///   - a validator's stake unit  ← validator.state.stake_unit_resource_address
///   - a validator's claim NFT   ← validator.state.claim_token_resource_address
///   - Weft's deposit unit       ← the V2 pool KVS entry's deposit_unit_res_address
/// A caller that passes a mismatched resource cannot make us build against it.

import type { GatewayClient } from '../gateway.js';
import { WEFT_V2_LENDING_COMPONENT } from '../weft.js';
import { EPOCH_SECONDS, UNBONDING_EPOCHS } from './venue-manifests.js';

const XRD_RESOURCE =
  'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';

/// Thrown when the ledger cannot answer — kept separate from a caller-input
/// error so the API can map it to 502 rather than 400.
export class VenueExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueExitError';
  }
}

// ─── validator resources ──────────────────────────────────────────────────────

export interface ValidatorExitResources {
  validator: string;
  /// The resource an unstake SPENDS (never XRD).
  lsuResource: string;
  /// The resource an unstake RETURNS and a claim spends.
  claimNftResource: string;
}

interface ValidatorStateResponse {
  items?: Array<{
    details?: {
      state?: {
        stake_unit_resource_address?: string;
        claim_token_resource_address?: string;
      };
    };
  }>;
}

/// Both exit resources for a validator, straight from its own state. Verified
/// field names against mainnet 2026-08-13.
export async function resolveValidatorExitResources(
  gw: GatewayClient,
  validator: string,
): Promise<ValidatorExitResources> {
  const resp = await gw.post<ValidatorStateResponse>('/state/entity/details', {
    addresses: [validator],
    aggregation_level: 'Global',
  });
  const state = resp.items?.[0]?.details?.state;
  const lsuResource = state?.stake_unit_resource_address;
  const claimNftResource = state?.claim_token_resource_address;
  if (!lsuResource || !claimNftResource) {
    throw new VenueExitError(`could not resolve stake unit / claim NFT resources for ${validator}`);
  }
  return { validator, lsuResource, claimNftResource };
}

// ─── Weft deposit unit ────────────────────────────────────────────────────────

interface KvsFieldsResponse {
  items?: Array<{ details?: { state?: { fields?: Array<{ field_name?: string; value?: string }> } } }>;
}
interface KvsKeysResponse {
  items?: Array<{ key?: { raw_hex?: string; programmatic_json?: { value?: string } } }>;
}
interface KvsDataResponse {
  entries?: Array<{
    value?: { programmatic_json?: { fields?: Array<{ field_name?: string; value?: string }> } };
  }>;
}

/// Weft V2's deposit-unit resource for `underlying` (w2-XRD for XRD). Resolved
/// through the component → `resource_pools` KVS → the entry's
/// `deposit_unit_res_address`, the same chain weft.ts walks for yield, so a Weft
/// redeploy cannot leave us building against a stale receipt token. Verified
/// 2026-08-13: XRD → resource_rdx1th0gjs6…, which is exactly the token the two
/// cited real committed withdrawals spend.
export async function resolveWeftDepositUnit(
  gw: GatewayClient,
  underlying: string = XRD_RESOURCE,
): Promise<string> {
  const component = await gw.post<KvsFieldsResponse>('/state/entity/details', {
    addresses: [WEFT_V2_LENDING_COMPONENT],
  });
  const kvsAddress = component.items?.[0]?.details?.state?.fields?.find(
    (f) => f.field_name === 'resource_pools',
  )?.value;
  if (typeof kvsAddress !== 'string' || !kvsAddress.startsWith('internal_keyvaluestore_')) {
    throw new VenueExitError('could not resolve the Weft V2 resource_pools store');
  }

  const keys = await gw.post<KvsKeysResponse>('/state/key-value-store/keys', {
    key_value_store_address: kvsAddress,
  });
  const keyHex = (keys.items ?? []).find(
    (i) => i.key?.programmatic_json?.value === underlying,
  )?.key?.raw_hex;
  if (!keyHex) throw new VenueExitError(`Weft V2 has no pool for ${underlying}`);

  const data = await gw.post<KvsDataResponse>('/state/key-value-store/data', {
    key_value_store_address: kvsAddress,
    keys: [{ key_hex: keyHex }],
  });
  const unit = data.entries?.[0]?.value?.programmatic_json?.fields?.find(
    (f) => f.field_name === 'deposit_unit_res_address',
  )?.value;
  if (typeof unit !== 'string' || !unit.startsWith('resource_')) {
    throw new VenueExitError('could not resolve the Weft V2 deposit unit resource');
  }
  return unit;
}

/// Cached `resolveWeftDepositUnit`, for callers that need the identity rather
/// than a fresh read — above all the holdings classifier, which would otherwise
/// pay three extra Gateway round-trips on every account refresh to learn a value
/// that only changes if Weft redeploys its lending component.
///
/// The build path deliberately does NOT use this: a manifest is worth a fresh
/// read, because spending against a stale receipt token is a real loss and one
/// extra round-trip is not.
const WEFT_UNIT_TTL_MS = 12 * 3600_000;
let weftUnitCache: { unit: string; at: number } | null = null;
let weftUnitInflight: Promise<string> | null = null;

export function _clearWeftUnitCache(): void {
  weftUnitCache = null;
  weftUnitInflight = null;
}

export async function getWeftDepositUnitCached(
  gw: GatewayClient,
  nowMs: number = Date.now(),
): Promise<string> {
  if (weftUnitCache && nowMs - weftUnitCache.at < WEFT_UNIT_TTL_MS) return weftUnitCache.unit;
  if (!weftUnitInflight) {
    weftUnitInflight = resolveWeftDepositUnit(gw)
      .then((unit) => {
        weftUnitCache = { unit, at: nowMs };
        return unit;
      })
      .finally(() => {
        weftUnitInflight = null;
      });
  }
  return weftUnitInflight;
}

// ─── stake claims ─────────────────────────────────────────────────────────────

export interface StakeClaim {
  validator: string;
  claimNftResource: string;
  localId: string;
  /// Epoch at which claim_xrd starts succeeding.
  claimEpoch: number;
  /// XRD the claim is worth — FIXED at unstake time. It does not keep accruing.
  claimAmountXrd: string;
  currentEpoch: number;
  epochsRemaining: number;
  ready: boolean;
  /// Best-effort wall-clock estimate for when `ready` flips, ISO-8601 UTC.
  /// null once ready. An ESTIMATE: epochs are ~300 s but not clock-locked.
  readyAtEstimate: string | null;
}

/// Pure readiness math, unit-tested without a Gateway. `nowMs` is injected so a
/// test is not at the mercy of the clock.
export function claimReadiness(
  input: {
    validator: string; claimNftResource: string; localId: string;
    claimEpoch: number; claimAmountXrd: string;
  },
  currentEpoch: number,
  nowMs: number,
): StakeClaim {
  const epochsRemaining = Math.max(0, input.claimEpoch - currentEpoch);
  const ready = epochsRemaining === 0;
  return {
    ...input,
    currentEpoch,
    epochsRemaining,
    ready,
    readyAtEstimate: ready
      ? null
      : new Date(nowMs + epochsRemaining * EPOCH_SECONDS * 1000).toISOString(),
  };
}

/// Human sentence for a pending claim — the UI's unbonding copy, generated from
/// the claim's own numbers rather than a hardcoded "about a week".
export function claimCopy(claim: StakeClaim): string {
  if (claim.ready) {
    return `Ready to claim: ${claim.claimAmountXrd} XRD. Sign the claim transaction to receive it.`;
  }
  const days = (claim.epochsRemaining * EPOCH_SECONDS) / 86_400;
  return (
    `Unbonding: ${claim.claimAmountXrd} XRD becomes claimable at epoch ${claim.claimEpoch}, ` +
    `${claim.epochsRemaining} epochs away (~${days.toFixed(1)} days). ` +
    `The amount is already fixed and earns no further rewards; the delay cannot be shortened.`
  );
}

interface AccountNfResponse {
  items?: Array<{
    non_fungible_resources?: {
      items?: Array<{
        resource_address?: string;
        explicit_metadata?: { items?: Array<{ key?: string; value?: { typed?: { value?: string } } }> };
        vaults?: { items?: Array<{ items?: string[] }> };
      }>;
    };
  }>;
}

interface NfDataResponse {
  non_fungible_ids?: Array<{
    non_fungible_id?: string;
    is_burned?: boolean;
    data?: {
      programmatic_json?: { fields?: Array<{ field_name?: string; value?: string }> };
    };
  }>;
}

/// Every Stake Claim NFT an account holds, with its readiness.
///
/// Without this the claim BUILDER is unreachable in-app: a user who unstakes has
/// no way to discover the local id of the receipt they must spend a week later,
/// and "we built you an unstake you can never claim through us" is precisely the
/// half-built state this closes. Stake claims are identified structurally — an
/// NFT resource whose on-ledger `validator` metadata points at a validator — the
/// same classification holdings.ts uses for LSUs, and the reason a scam token
/// cannot impersonate one is that the claim is then read from THAT validator's
/// own claim resource.
export async function readStakeClaims(
  gw: GatewayClient,
  account: string,
  nowMs: number = Date.now(),
): Promise<StakeClaim[]> {
  const resp = await gw.post<AccountNfResponse>('/state/entity/details', {
    addresses: [account],
    aggregation_level: 'Vault',
    opt_ins: { non_fungible_include_nfids: true, explicit_metadata: ['validator'] },
  });

  const candidates: Array<{ resource: string; validator: string; ids: string[] }> = [];
  for (const r of resp.items?.[0]?.non_fungible_resources?.items ?? []) {
    const validator = r.explicit_metadata?.items?.find((m) => m.key === 'validator')?.value?.typed?.value;
    const resource = r.resource_address;
    if (!resource || !validator || !validator.startsWith('validator_')) continue;
    const ids = (r.vaults?.items ?? []).flatMap((v) => v.items ?? []);
    if (ids.length > 0) candidates.push({ resource, validator, ids });
  }
  if (candidates.length === 0) return [];

  // Cross-check each candidate against the validator's OWN claim resource before
  // reading any data — metadata alone is a claim, not proof.
  const validators = [...new Set(candidates.map((c) => c.validator))];
  const vResp = await gw.post<{
    items?: Array<{ address?: string; details?: { state?: { claim_token_resource_address?: string } } }>;
  }>('/state/entity/details', { addresses: validators, aggregation_level: 'Global' });
  const claimResourceOf = new Map<string, string>();
  for (const v of vResp.items ?? []) {
    const claim = v.details?.state?.claim_token_resource_address;
    if (v.address && claim) claimResourceOf.set(v.address, claim);
  }

  const currentEpoch = await gw.getCurrentEpoch();
  const out: StakeClaim[] = [];
  for (const c of candidates) {
    if (claimResourceOf.get(c.validator) !== c.resource) continue; // not a real stake claim
    const data = await gw.post<NfDataResponse>('/state/non-fungible/data', {
      resource_address: c.resource,
      non_fungible_ids: c.ids,
    });
    for (const item of data.non_fungible_ids ?? []) {
      if (item.is_burned || !item.non_fungible_id) continue;
      const fields = item.data?.programmatic_json?.fields ?? [];
      const claimEpoch = Number(fields.find((f) => f.field_name === 'claim_epoch')?.value);
      const claimAmountXrd = fields.find((f) => f.field_name === 'claim_amount')?.value;
      if (!Number.isFinite(claimEpoch) || typeof claimAmountXrd !== 'string') continue;
      out.push(
        claimReadiness(
          {
            validator: c.validator,
            claimNftResource: c.resource,
            localId: item.non_fungible_id,
            claimEpoch,
            claimAmountXrd,
          },
          currentEpoch,
          nowMs,
        ),
      );
    }
  }
  // Claimable first, then soonest.
  out.sort((a, b) => a.epochsRemaining - b.epochsRemaining);
  return out;
}

/// Read one specific claim, for the build path's pre-flight gate.
export async function readStakeClaim(
  gw: GatewayClient,
  validator: string,
  claimNftResource: string,
  localId: string,
  nowMs: number = Date.now(),
): Promise<StakeClaim> {
  const data = await gw.post<NfDataResponse>('/state/non-fungible/data', {
    resource_address: claimNftResource,
    non_fungible_ids: [localId],
  });
  const item = data.non_fungible_ids?.[0];
  if (!item || item.is_burned) {
    throw new VenueExitError('that stake claim does not exist or has already been claimed');
  }
  const fields = item.data?.programmatic_json?.fields ?? [];
  const claimEpoch = Number(fields.find((f) => f.field_name === 'claim_epoch')?.value);
  const claimAmountXrd = fields.find((f) => f.field_name === 'claim_amount')?.value;
  if (!Number.isFinite(claimEpoch) || typeof claimAmountXrd !== 'string') {
    throw new VenueExitError('could not read the stake claim contents');
  }
  const currentEpoch = await gw.getCurrentEpoch();
  return claimReadiness(
    { validator, claimNftResource, localId, claimEpoch, claimAmountXrd },
    currentEpoch,
    nowMs,
  );
}

export { UNBONDING_EPOCHS, EPOCH_SECONDS };
