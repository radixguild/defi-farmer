/// Radix Transaction Manifest (RTM) primitives + input validators for the DEX
/// builders.
///
/// Every value interpolated into a manifest string passes a validator first —
/// the F13 anti-injection lesson, enforced at the builder layer (not just the
/// API). Addresses/amounts/ids are the only untrusted inputs; the allowed
/// character sets cannot contain a manifest-breaking quote, semicolon or paren.

// Radix addresses: <prefix>_rdx1<bech32>. Only lowercase alphanumerics after the
// prefix — structurally incapable of holding an injection character. `validator`
// is included for native-staking deposits (the stake target is a validator_rdx1…
// Component, not a pool).
const ADDRESS_RE = /^(account|component|resource|pool|validator)_rdx1[a-z0-9]{6,120}$/;
// Positive decimal, no exponent / sign / leading zero / trailing dot (≤ engine precision).
const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
// NonFungibleLocalId canonical string forms (delimiters included). None of these
// charsets can contain a manifest-breaking quote/paren/semicolon, so each is
// interpolated verbatim inside NonFungibleLocalId("…"). Ociswap Precision LP =
// integer (#421#); CaviarNine QuantaSwap receipt = ruid ({16hex-16hex-16hex-16hex}).
const NFLID_INTEGER = /^#\d{1,39}#$/;
const NFLID_RUID = /^\{[0-9a-f]{16}-[0-9a-f]{16}-[0-9a-f]{16}-[0-9a-f]{16}\}$/;
const NFLID_STRING = /^<[A-Za-z0-9_]{1,64}>$/;
const NFLID_BYTES = /^\[[0-9a-f]{2,128}\]$/;
// A bare integer (no delimiters) — how position-recorder stores an Ociswap id;
// normalized to #n# here so both storage shapes reach the builder.
const BARE_INT_RE = /^\d{1,39}$/;
// Signed i32 tick for Ociswap PrecisionPool (left/right bounds).
const I32_RE = /^-?\d{1,10}$/;
// Unsigned u32 bin id for CaviarNine QuantaSwap.
const U32_RE = /^\d{1,10}$/;

export function assertAddress(s: string, label = 'address'): string {
  if (typeof s !== 'string' || !ADDRESS_RE.test(s)) throw new Error(`Invalid ${label}: '${String(s).slice(0, 40)}'`);
  return s;
}
export function assertAmount(s: string, label = 'amount'): string {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) throw new Error(`Invalid ${label}: '${String(s).slice(0, 40)}'`);
  return s;
}
/// Validate a NonFungibleLocalId and return it in canonical string form (with
/// delimiters). Accepts integer/ruid/string/bytes forms, plus a bare integer
/// which is normalized to #n#.
export function assertNfLocalId(s: string, label = 'localId'): string {
  if (typeof s === 'string' && BARE_INT_RE.test(s)) return `#${s}#`;
  if (
    typeof s === 'string' &&
    (NFLID_INTEGER.test(s) || NFLID_RUID.test(s) || NFLID_STRING.test(s) || NFLID_BYTES.test(s))
  ) {
    return s;
  }
  throw new Error(`Invalid ${label}: '${String(s).slice(0, 50)}'`);
}
export function assertI32(n: number, label = 'tick'): number {
  if (!Number.isInteger(n) || !I32_RE.test(String(n)) || n < -2147483648 || n > 2147483647) {
    throw new Error(`Invalid ${label}: '${n}'`);
  }
  return n;
}
export function assertU32(n: number, label = 'bin'): number {
  if (!Number.isInteger(n) || !U32_RE.test(String(n)) || n < 0 || n > 4294967295) {
    throw new Error(`Invalid ${label}: '${n}'`);
  }
  return n;
}

/// RTM instruction fragments. Each returns one `;`-terminated instruction.
export const rtm = {
  /// No default amount: builders reach this only through optionalLockFee.
  lockFee: (account: string, amount: string) =>
    `CALL_METHOD Address("${assertAddress(account, 'account')}") "lock_fee" Decimal("${assertAmount(amount, 'lockFee')}");`,
  withdraw: (account: string, resource: string, amount: string) =>
    `CALL_METHOD Address("${assertAddress(account, 'account')}") "withdraw" Address("${assertAddress(resource, 'resource')}") Decimal("${assertAmount(amount)}");`,
  withdrawNonFungible: (account: string, resource: string, id: string) =>
    `CALL_METHOD Address("${assertAddress(account, 'account')}") "withdraw_non_fungibles" Address("${assertAddress(resource, 'resource')}") Array<NonFungibleLocalId>(NonFungibleLocalId("${assertNfLocalId(id)}"));`,
  takeAll: (resource: string, bucket: string) =>
    `TAKE_ALL_FROM_WORKTOP Address("${assertAddress(resource, 'resource')}") Bucket("${bucket}");`,
  takeFrom: (resource: string, amount: string, bucket: string) =>
    `TAKE_FROM_WORKTOP Address("${assertAddress(resource, 'resource')}") Decimal("${assertAmount(amount)}") Bucket("${bucket}");`,
  takeNonFungible: (resource: string, id: string, bucket: string) =>
    `TAKE_NON_FUNGIBLES_FROM_WORKTOP Address("${assertAddress(resource, 'resource')}") Array<NonFungibleLocalId>(NonFungibleLocalId("${assertNfLocalId(id)}")) Bucket("${bucket}");`,
  /// Deposit a fee bucket to a treasury component (non-custodial pass-through).
  /// try_deposit_or_abort so a treasury deposit-rule can never silently swallow.
  depositFee: (treasury: string, bucket: string) =>
    `CALL_METHOD Address("${assertAddress(treasury, 'treasury')}") "try_deposit_or_abort" Bucket("${bucket}") Enum<0u8>();`,
  depositBatch: (account: string) =>
    `CALL_METHOD Address("${assertAddress(account, 'account')}") "deposit_batch" Expression("ENTIRE_WORKTOP");`,
};

/// THE fee rule for every builder (LP and single-sided, deposit and exit):
/// a manifest locks no fee of its own unless the caller asks for one.
///
/// The app hands each manifest to the Radix Wallet through RDT
/// `sendTransaction`. The wallet adds the fee lock itself, from the account
/// the user picks. Radix's "Conforming Manifest Types" doc says a dApp's
/// manifest stub need not lock a fee and that one which does will generally
/// be rejected by the wallet. The Gateway preview (the sign-gate) needs no
/// lock either: it runs with `use_free_credit` (gateway.ts previewTransaction).
///
/// `lockFee` is for a manifest that never goes through the wallet, such as a
/// notarised submit from a CLI. Nothing in the app sets it.
export function optionalLockFee(account: string, lockFee: string | undefined): string[] {
  return lockFee === undefined ? [] : [rtm.lockFee(account, lockFee)];
}

/// i32 tick literal for a method arg, e.g. `166708i32` (Ociswap PrecisionPool).
export function i32Arg(n: number, label = 'tick'): string {
  return `${assertI32(n, label)}i32`;
}

export interface BinPosition {
  bin: number;
  amountX: string;
  amountY: string;
}

/// CaviarNine QuantaSwap positions arg:
/// `Array<Tuple>(Tuple(<bin>u32, Decimal("x"), Decimal("y")), …)`.
export function quantaPositionsArg(positions: BinPosition[]): string {
  if (positions.length === 0) throw new Error('quantaPositionsArg: empty positions');
  const tuples = positions.map(
    (p) =>
      `Tuple(${assertU32(p.bin, 'bin')}u32, Decimal("${assertAmount(p.amountX, 'amountX')}"), Decimal("${assertAmount(p.amountY, 'amountY')}"))`,
  );
  return `Array<Tuple>(${tuples.join(', ')})`;
}

/// Join instruction fragments into a manifest (one per line, trailing newline).
export function manifest(...instructions: string[]): string {
  return instructions.join('\n') + '\n';
}
