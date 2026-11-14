/// Operator deposit switch: pause DEPOSITS per venue kind or per pool, leaving
/// exits (withdraw) and position recording untouched.
///
/// Why it exists. A package pin (config.ts DEX_PACKAGE_ENV) is all-or-nothing:
/// unpinning a kind stops deposits AND app-built exits for every pool of that
/// kind, and pinning a package turns on every pool in it. This switch lets an
/// operator keep the pin (so exits keep building) while refusing deposits, for
/// a whole kind or for individual pools.
///
/// Scope. buildAndPreview consults it for action 'deposit' on LP pools resolved
/// by the pool-resolver. It is NOT consulted by withdraw, by recordDeposit, or by
/// the single-sided venue paths (native staking, LSULP, Weft), which never reach
/// the pool-resolver. It cannot enable anything: an unpinned or lookalike package
/// is refused by the resolver before this runs, and stays refused.
///
/// Configuration (comma-separated, whitespace and empty segments ignored):
///   DEX_DEPOSITS_DISABLED_KINDS  kinds from DEX_PACKAGE_ENV, e.g. caviarnine_weighted
///   DEX_DEPOSITS_DENY_POOLS      pool component_rdx1… addresses
///
/// FAIL CLOSED. If either value cannot be parsed in full (an unknown kind name, a
/// token that is not a component address), the switch is "invalid" and EVERY
/// deposit through buildAndPreview's pool path is refused until the value is
/// fixed. The server keeps running and exits keep working. See the PR / README
/// for why this beats a startup error.
///
/// Not cached: currentDepositSwitch() re-reads process.env on every call. The
/// environment of a running process does not change, so this costs nothing, and
/// it means no stale copy can outlive what the operator last set and restarted.

import {
  DEPOSIT_SWITCH_ENV, DEX_PACKAGE_ENV, type PinnedPoolKind,
} from '../../config.js';
import type { PoolKind } from './pool-resolver.js';

export type DepositSwitch =
  | {
      ok: true;
      pausedKinds: ReadonlySet<PinnedPoolKind>;
      deniedPools: ReadonlySet<string>;
    }
  | { ok: false; errors: string[] };

const KNOWN_KINDS = new Set<string>(Object.keys(DEX_PACKAGE_ENV));
/// Same shape rtm.ts accepts for a pool address, restricted to what a pool
/// component can be. Lowercase only, so an exact string match is a full match.
const POOL_ADDRESS_RE = /^component_rdx1[a-z0-9]{6,120}$/;

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/// Pure parser (unit-tested). Never throws; a bad value yields { ok: false }.
export function parseDepositSwitch(env: Record<string, string | undefined>): DepositSwitch {
  const errors: string[] = [];
  const pausedKinds = new Set<PinnedPoolKind>();
  for (const k of splitList(env[DEPOSIT_SWITCH_ENV.kinds])) {
    if (KNOWN_KINDS.has(k)) pausedKinds.add(k as PinnedPoolKind);
    else errors.push(`${DEPOSIT_SWITCH_ENV.kinds}: unknown kind '${k.slice(0, 60)}'`);
  }
  const deniedPools = new Set<string>();
  for (const p of splitList(env[DEPOSIT_SWITCH_ENV.pools])) {
    if (POOL_ADDRESS_RE.test(p)) deniedPools.add(p);
    else errors.push(`${DEPOSIT_SWITCH_ENV.pools}: '${p.slice(0, 60)}' is not a mainnet component_rdx1… address`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, pausedKinds, deniedPools };
}

/// The switch as the environment sets it right now. Deliberately uncached.
export function currentDepositSwitch(): DepositSwitch {
  return parseDepositSwitch(process.env);
}

/// The reason a deposit into `pool` must be refused, or undefined if the switch
/// allows it. The text is caller-facing (a 400), so it names no env var.
export function depositRefusal(
  sw: DepositSwitch, pool: { address: string; kind: PoolKind },
): string | undefined {
  if (!sw.ok) return 'deposits are unavailable: the deposit switch is misconfigured on the server';
  if (pool.kind !== 'unsupported' && sw.pausedKinds.has(pool.kind)) {
    return `deposits are paused for this venue (${pool.kind})`;
  }
  if (sw.deniedPools.has(pool.address)) return 'deposits are paused for this pool';
  return undefined;
}

/// One startup log so an operator can read back what the switch is doing.
/// Silent when nothing is paused and the value is valid.
export function logDepositSwitchStatus(
  sw: DepositSwitch = currentDepositSwitch(),
  log: Pick<Console, 'log' | 'error'> = console,
): void {
  if (!sw.ok) {
    for (const e of sw.errors) log.error(`[deposit-switch] INVALID ${e}`);
    log.error(
      '[deposit-switch] value not accepted: ALL pool deposits are refused until it is fixed ' +
        '(exits are not affected)',
    );
    return;
  }
  if (sw.pausedKinds.size === 0 && sw.deniedPools.size === 0) return;
  log.log(
    `[deposit-switch] deposits paused — kinds: ${[...sw.pausedKinds].join(',') || '(none)'}; ` +
      `pools: ${sw.deniedPools.size}`,
  );
}
