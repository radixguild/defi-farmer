/// Operator deposit switch — the pure parser, the refusal rule and the startup
/// read-back. The end-to-end behaviour (deposit refused before any preview,
/// withdraw still builds, repo-default pins) is in dex-build-service.test.ts.
import { describe, test, expect, afterEach } from 'bun:test';
import {
  parseDepositSwitch, depositRefusal, currentDepositSwitch, logDepositSwitchStatus,
  type DepositSwitch,
} from '../src/services/dex/deposit-switch';
import { DEPOSIT_SWITCH_ENV } from '../src/config';

const KINDS = DEPOSIT_SWITCH_ENV.kinds;
const POOLS = DEPOSIT_SWITCH_ENV.pools;
const POOL_A = 'component_rdx1cpoolaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const POOL_B = 'component_rdx1cpoolbxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function valid(sw: DepositSwitch) {
  if (!sw.ok) throw new Error(`expected a valid switch, got errors: ${sw.errors.join('; ')}`);
  return sw;
}

describe('parseDepositSwitch', () => {
  test('unset, empty, whitespace and bare commas → valid and nothing paused', () => {
    for (const env of [{}, { [KINDS]: '', [POOLS]: '' }, { [KINDS]: '  ', [POOLS]: ' , ,' }]) {
      const sw = valid(parseDepositSwitch(env));
      expect(sw.pausedKinds.size).toBe(0);
      expect(sw.deniedPools.size).toBe(0);
    }
  });

  test('comma lists are trimmed and de-duplicated; a trailing comma is fine', () => {
    const sw = valid(parseDepositSwitch({
      [KINDS]: ' caviarnine_weighted , defiplaza_pair,caviarnine_weighted,',
      [POOLS]: `${POOL_A}, ${POOL_B} ,`,
    }));
    expect([...sw.pausedKinds].sort()).toEqual(['caviarnine_weighted', 'defiplaza_pair']);
    expect([...sw.deniedPools].sort()).toEqual([POOL_A, POOL_B]);
  });

  test('every kind that can be pinned can be paused', () => {
    const all = 'ociswap_basic,ociswap_precision,caviarnine_weighted,caviarnine_quantaswap,defiplaza_pair';
    expect(valid(parseDepositSwitch({ [KINDS]: all })).pausedKinds.size).toBe(5);
  });

  test('an unknown or mis-cased kind makes the whole value invalid, naming the bad token', () => {
    for (const bad of ['caviarnine_weigthed', 'CaviarNine_Weighted', 'unsupported', 'native_stake', 'all', '*']) {
      const sw = parseDepositSwitch({ [KINDS]: `defiplaza_pair,${bad}` });
      expect(sw.ok).toBe(false);
      if (!sw.ok) expect(sw.errors.join(' ')).toContain(bad);
    }
  });

  test('a pool entry that is not a mainnet component address makes the value invalid', () => {
    const bad = [
      'account_rdx1c9dka8al9kd0a93q8ag4mjs3fzassqef0lk6hg757tqfma5hu0n3gy', // wrong entity type
      'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
      'component_tdx_2_1cstokenet', // not mainnet
      'COMPONENT_RDX1CPOOLAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // upper case
      'component_rdx1',
      'not-an-address',
    ];
    for (const b of bad) {
      const sw = parseDepositSwitch({ [POOLS]: `${POOL_A},${b}` });
      expect(sw.ok).toBe(false);
    }
  });

  test('one bad entry invalidates the good ones beside it (all-or-nothing)', () => {
    const sw = parseDepositSwitch({ [KINDS]: 'defiplaza_pair,nope', [POOLS]: POOL_A });
    expect(sw.ok).toBe(false);
  });
});

describe('depositRefusal', () => {
  const sw = valid(parseDepositSwitch({ [KINDS]: 'caviarnine_weighted', [POOLS]: POOL_A }));

  test('a paused kind is refused, an unlisted kind is not', () => {
    expect(depositRefusal(sw, { address: POOL_B, kind: 'caviarnine_weighted' })).toMatch(/deposits are paused for this venue/);
    expect(depositRefusal(sw, { address: POOL_B, kind: 'defiplaza_pair' })).toBeUndefined();
    expect(depositRefusal(sw, { address: POOL_B, kind: 'ociswap_precision' })).toBeUndefined();
  });

  test('a denied pool is refused even when its kind is not paused; other pools of that kind are not', () => {
    expect(depositRefusal(sw, { address: POOL_A, kind: 'ociswap_basic' })).toMatch(/deposits are paused for this pool/);
    expect(depositRefusal(sw, { address: POOL_B, kind: 'ociswap_basic' })).toBeUndefined();
  });

  test('an invalid switch refuses every pool, whatever its kind', () => {
    const bad = parseDepositSwitch({ [KINDS]: 'nope' });
    for (const kind of ['ociswap_basic', 'ociswap_precision', 'caviarnine_weighted', 'caviarnine_quantaswap', 'defiplaza_pair'] as const) {
      expect(depositRefusal(bad, { address: POOL_B, kind })).toMatch(/misconfigured/);
    }
  });

  test('the caller-facing text names no env var', () => {
    const texts = [
      depositRefusal(sw, { address: POOL_B, kind: 'caviarnine_weighted' }),
      depositRefusal(sw, { address: POOL_A, kind: 'ociswap_basic' }),
      depositRefusal(parseDepositSwitch({ [KINDS]: 'nope' }), { address: POOL_B, kind: 'ociswap_basic' }),
    ];
    for (const t of texts) expect(t).not.toMatch(/DEX_|_ENV|process\.env/);
  });
});

describe('currentDepositSwitch — not cached', () => {
  const saved = { k: process.env[KINDS], p: process.env[POOLS] };
  afterEach(() => {
    if (saved.k === undefined) delete process.env[KINDS]; else process.env[KINDS] = saved.k;
    if (saved.p === undefined) delete process.env[POOLS]; else process.env[POOLS] = saved.p;
  });

  test('follows the environment on every call', () => {
    delete process.env[KINDS];
    expect(valid(currentDepositSwitch()).pausedKinds.size).toBe(0);
    process.env[KINDS] = 'defiplaza_pair';
    expect([...valid(currentDepositSwitch()).pausedKinds]).toEqual(['defiplaza_pair']);
    process.env[KINDS] = 'nope';
    expect(currentDepositSwitch().ok).toBe(false);
    delete process.env[KINDS];
    expect(valid(currentDepositSwitch()).pausedKinds.size).toBe(0);
  });
});

describe('logDepositSwitchStatus', () => {
  function capture() {
    const lines: string[] = [];
    return {
      lines,
      log: { log: (m: string) => lines.push(`log:${m}`), error: (m: string) => lines.push(`error:${m}`) },
    };
  }

  test('silent when nothing is paused', () => {
    const c = capture();
    logDepositSwitchStatus(parseDepositSwitch({}), c.log);
    expect(c.lines).toEqual([]);
  });

  test('reads back what is paused', () => {
    const c = capture();
    logDepositSwitchStatus(parseDepositSwitch({ [KINDS]: 'defiplaza_pair', [POOLS]: POOL_A }), c.log);
    expect(c.lines).toEqual(['log:[deposit-switch] deposits paused — kinds: defiplaza_pair; pools: 1']);
  });

  test('an invalid value is logged at error level, per bad token, with the consequence', () => {
    const c = capture();
    logDepositSwitchStatus(parseDepositSwitch({ [KINDS]: 'nope', [POOLS]: 'junk' }), c.log);
    expect(c.lines.every((l) => l.startsWith('error:'))).toBe(true);
    expect(c.lines.join('\n')).toContain("unknown kind 'nope'");
    expect(c.lines.join('\n')).toContain("'junk'");
    expect(c.lines.join('\n')).toMatch(/ALL pool deposits are refused/);
  });
});
