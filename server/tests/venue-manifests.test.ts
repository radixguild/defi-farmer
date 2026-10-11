import { describe, test, expect } from 'bun:test';
import {
  detectVenue, buildStakeDeposit, buildWeftSupplyDeposit, buildLsulpDeposit,
  buildStakeUnstake, buildStakeClaim, buildWeftSupplyWithdraw, buildLsulpWithdraw,
  UNBONDING_EPOCHS, UNBONDING_DAYS, UNSTAKE_NOTICE,
} from '../src/services/dex/venue-manifests';
import { LSULP_RESOURCE } from '../src/services/lsu-pool';
import { pickTopValidator, pickLsulpValidator } from '../src/services/dex/build-service';
import { XRD_STAKING_ADDRESS } from '../src/services/staking';
import { WEFT_V2_LENDING_COMPONENT } from '../src/services/weft';
import { LSU_POOL_COMPONENT } from '../src/services/lsu-pool';
import type { ValidatorRow } from '../src/services/validator-board';

const ACCT = 'account_rdx128lggt503h7m2dhzqnrkkqv4zklxcjmdggr8xxtqy8e47p7fkmd8cx';
const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const VALIDATOR = 'validator_rdx1swt8pyg3qs0ra3472jd23hx0520yyz665ypgmc2r7xa33mq9488atw';
const LSU_RES = 'resource_rdx1thuy5j23qjskmqjq2700am2w63yn47daplvvhnw6ece3y02ft3aske';

describe('detectVenue', () => {
  test('classifies the three single-sided venues, else null', () => {
    expect(detectVenue(XRD_STAKING_ADDRESS)).toBe('native_stake');
    expect(detectVenue(`weft-v2:${XRD}`)).toBe('weft_lending');
    expect(detectVenue(LSU_POOL_COMPONENT)).toBe('lsulp');
    // a real LP pool component → not a venue (goes to the pool-resolver)
    expect(detectVenue('component_rdx1cptxxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxfaucet')).toBeNull();
    expect(detectVenue('')).toBeNull();
  });
});

describe('buildStakeDeposit', () => {
  test('native validator stake: withdraw XRD → takeAll → validator.stake → deposit_batch', () => {
    const m = buildStakeDeposit(ACCT, VALIDATOR, '100');
    expect(m).not.toContain('lock_fee'); // the wallet locks the fee itself
    expect(m).toContain(`"withdraw" Address("${XRD}") Decimal("100")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${XRD}") Bucket("bucket_xrd")`);
    expect(m).toContain(`Address("${VALIDATOR}") "stake" Bucket("bucket_xrd")`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
    // no LP/pool concepts leak in
    expect(m).not.toContain('add_liquidity');
  });

  test('rejects a non-decimal amount', () => {
    expect(() => buildStakeDeposit(ACCT, VALIDATOR, '1; DROP')).toThrow();
  });

  test('rejects a non-validator address in the validator slot', () => {
    expect(() => buildStakeDeposit(ACCT, ACCT.replace('account', 'notaprefix'), '100')).toThrow();
  });
});

describe('buildWeftSupplyDeposit', () => {
  test('Weft supply: deposit(Array<Bucket>[xrd]) to the lending component', () => {
    const m = buildWeftSupplyDeposit(ACCT, '250');
    expect(m).toContain(`"withdraw" Address("${XRD}") Decimal("250")`);
    expect(m).toContain(`Address("${WEFT_V2_LENDING_COMPONENT}") "deposit" Array<Bucket>(Bucket("bucket_xrd"))`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
  });
});

describe('buildLsulpDeposit', () => {
  test('two legs: stake XRD → take LSU → add_liquidity(LSU, None) → deposit_batch', () => {
    const m = buildLsulpDeposit(ACCT, VALIDATOR, LSU_RES, '100');
    // leg 1: mint the LSU
    expect(m).toContain(`Address("${VALIDATOR}") "stake" Bucket("bucket_xrd")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${LSU_RES}") Bucket("bucket_lsu")`);
    // leg 2: LSU → LSULP, None credit_proof
    expect(m).toContain(`Address("${LSU_POOL_COMPONENT}") "add_liquidity" Bucket("bucket_lsu") Enum<0u8>()`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
    // ordering: stake must come before add_liquidity
    expect(m.indexOf('"stake"')).toBeLessThan(m.indexOf('add_liquidity'));
  });
});

// ── exits ─────────────────────────────────────────────────────────────────────
//
// Shapes are pinned against the real committed mainnet transactions cited in the
// builder docblocks, because the dry-run cannot tell a right manifest from a
// plausible one: an unstake that spends the wrong resource, or an LSULP exit
// built with add_liquidity's arity, either fails loudly or — worse — succeeds
// somewhere the user did not intend.

const CLAIM_NFT = 'resource_rdx1nta23ustrhrwncyhflmz8y845tq2e648g5hvlpulexvlx4atxvwd40';
const CLAIM_ID = '{d6823bcd82ad7ce3-4264293749495db4-eaaa7ff718f20713-b5c3927546aa80ea}';
const W2_XRD = 'resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz';

describe('unbonding constants', () => {
  test('2016 epochs at 300 s/epoch is exactly 7 days', () => {
    expect(UNBONDING_EPOCHS).toBe(2016);
    expect(UNBONDING_DAYS).toBe(7);
  });
  test('the unstake notice says it does NOT return XRD and needs a second signature', () => {
    expect(UNSTAKE_NOTICE).toContain('does NOT return XRD');
    expect(UNSTAKE_NOTICE).toMatch(/second "claim" transaction/);
  });
});

describe('buildStakeUnstake (phase 1 of 2)', () => {
  test('spends the STAKE UNIT, not XRD, and calls validator.unstake', () => {
    const m = buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '42.5');
    expect(m).toContain(`"withdraw" Address("${LSU_RES}") Decimal("42.5")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${LSU_RES}") Bucket("bucket_lsu")`);
    expect(m).toContain(`Address("${VALIDATOR}") "unstake" Bucket("bucket_lsu")`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
    // The classic wrong build: unstaking by withdrawing XRD.
    expect(m).not.toContain(XRD);
    expect(m).not.toContain('"stake"');
  });

  test('omits lock_fee by default (the wallet adds its own), emits it only on request', () => {
    expect(buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '1')).not.toContain('lock_fee');
    expect(buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '1', { lockFee: '5' }))
      .toContain(`"lock_fee" Decimal("5")`);
  });

  test('rejects a zero amount — a valid no-op the dry-run would pass', () => {
    expect(() => buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '0')).toThrow(/greater than zero/);
    expect(() => buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '0.000')).toThrow(/greater than zero/);
  });

  test('rejects injection and malformed inputs', () => {
    expect(() => buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '1"); CALL_METHOD (')).toThrow();
    expect(() => buildStakeUnstake(ACCT, 'not_an_address', LSU_RES, '1')).toThrow();
    expect(() => buildStakeUnstake(ACCT, VALIDATOR, 'nonsense', '1')).toThrow();
  });
});

describe('buildStakeClaim (phase 2 of 2)', () => {
  test('burns the claim NFT via claim_xrd', () => {
    const m = buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, CLAIM_ID);
    expect(m).toContain(
      `"withdraw_non_fungibles" Address("${CLAIM_NFT}") Array<NonFungibleLocalId>(NonFungibleLocalId("${CLAIM_ID}"))`,
    );
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${CLAIM_NFT}") Bucket("bucket_claim")`);
    expect(m).toContain(`Address("${VALIDATOR}") "claim_xrd" Bucket("bucket_claim")`);
    expect(m).toContain(`"deposit_batch" Expression("ENTIRE_WORKTOP")`);
  });

  test('accepts the RUID local-id form validator claims actually use', () => {
    expect(() => buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, CLAIM_ID)).not.toThrow();
    // and refuses a malformed id rather than interpolating it
    expect(() => buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, '{nope}')).toThrow();
    expect(() => buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, '"); EVIL (')).toThrow();
  });

  test('an unstake and its claim target the same validator — the pair ships together', () => {
    const unstake = buildStakeUnstake(ACCT, VALIDATOR, LSU_RES, '10');
    const claim = buildStakeClaim(ACCT, VALIDATOR, CLAIM_NFT, CLAIM_ID);
    expect(unstake).toContain(VALIDATOR);
    expect(claim).toContain(VALIDATOR);
  });
});

describe('buildWeftSupplyWithdraw', () => {
  test('mirrors the supply builder: spend w2 units, call withdraw(Array<Bucket>)', () => {
    const m = buildWeftSupplyWithdraw(ACCT, W2_XRD, '477573.353329640598269389');
    expect(m).toContain(`"withdraw" Address("${W2_XRD}") Decimal("477573.353329640598269389")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${W2_XRD}") Bucket("bucket_w2")`);
    expect(m).toContain(`Address("${WEFT_V2_LENDING_COMPONENT}") "withdraw" Array<Bucket>(Bucket("bucket_w2"))`);
    // spends the receipt token, never the underlying
    expect(m).not.toContain(`"withdraw" Address("${XRD}")`);
  });

  test('rejects zero and a bad deposit-unit resource', () => {
    expect(() => buildWeftSupplyWithdraw(ACCT, W2_XRD, '0')).toThrow(/greater than zero/);
    expect(() => buildWeftSupplyWithdraw(ACCT, 'not_a_resource', '1')).toThrow();
  });
});

describe('buildLsulpWithdraw', () => {
  test('remove_liquidity takes THREE args — bucket, target LSU, None', () => {
    const m = buildLsulpWithdraw(ACCT, '1000', LSU_RES);
    expect(m).toContain(`"withdraw" Address("${LSULP_RESOURCE}") Decimal("1000")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${LSULP_RESOURCE}") Bucket("bucket_lsulp")`);
    expect(m).toContain(
      `Address("${LSU_POOL_COMPONENT}") "remove_liquidity" Bucket("bucket_lsulp") Address("${LSU_RES}") Enum<0u8>()`,
    );
    // default terminus is the LSU: no unbonding is started without asking
    expect(m).not.toContain('"unstake"');
  });

  test('exitTo xrd chains unstake at the SAME validator in one signed tx', () => {
    const m = buildLsulpWithdraw(ACCT, '1000', LSU_RES, VALIDATOR);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP Address("${LSU_RES}") Bucket("bucket_lsu")`);
    expect(m).toContain(`Address("${VALIDATOR}") "unstake" Bucket("bucket_lsu")`);
    // ordering: redeem before unstake, sweep last
    expect(m.indexOf('remove_liquidity')).toBeLessThan(m.indexOf('"unstake"'));
    expect(m.indexOf('"unstake"')).toBeLessThan(m.indexOf('deposit_batch'));
  });

  test('rejects zero, a bad target LSU and a bad unstake validator', () => {
    expect(() => buildLsulpWithdraw(ACCT, '0', LSU_RES)).toThrow(/greater than zero/);
    expect(() => buildLsulpWithdraw(ACCT, '1', 'garbage')).toThrow();
    expect(() => buildLsulpWithdraw(ACCT, '1', LSU_RES, 'garbage')).toThrow();
  });
});

// ── validator selection ───────────────────────────────────────────────────────
function row(over: Partial<ValidatorRow>): ValidatorRow {
  return {
    address: 'validator_rdx1' + 'a'.repeat(20),
    name: null, stakeXrd: 0, effectiveFeePct: 0, staleFeePct: null,
    feeFieldsDisagree: false, redemptionRate: 1, realizedApyPct: null,
    paysNothing: false, zeroDisclosedByFee: false, activeInEpoch: true, ...over,
  };
}

describe('pickTopValidator (native staking)', () => {
  test('picks the top realized payer that is active and paying', () => {
    const rows = [
      row({ address: 'validator_rdx1' + 'b'.repeat(20), realizedApyPct: 8, activeInEpoch: false }), // inactive → skip
      row({ address: 'validator_rdx1' + 'c'.repeat(20), realizedApyPct: 6.2, activeInEpoch: true, paysNothing: false }),
      row({ address: 'validator_rdx1' + 'd'.repeat(20), realizedApyPct: 0, activeInEpoch: true, paysNothing: true }),
    ];
    expect(pickTopValidator(rows)?.address).toBe('validator_rdx1' + 'c'.repeat(20));
  });
});

describe('pickLsulpValidator (LSU Pool acceptance)', () => {
  test('picks the highest-STAKE active paying validator (not the top yield)', () => {
    const rows = [
      row({ address: 'validator_rdx1' + 'e'.repeat(20), realizedApyPct: 20, stakeXrd: 1_000, activeInEpoch: true }), // high yield, tiny stake
      row({ address: 'validator_rdx1' + 'f'.repeat(20), realizedApyPct: 6, stakeXrd: 200_000_000, activeInEpoch: true }), // big active
      row({ address: 'validator_rdx1' + '0'.repeat(20), realizedApyPct: 30, stakeXrd: 500_000_000, activeInEpoch: false }), // biggest but INACTIVE → rejected by pool
    ];
    expect(pickLsulpValidator(rows)?.address).toBe('validator_rdx1' + 'f'.repeat(20));
  });
});
