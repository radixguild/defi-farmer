/// BigInt-safe fixed-point decimal (18 dp) — the Radix engine's precision.
/// Never parseFloat a token amount; all money math goes through here.

const DP = 18;
const ONE = 10n ** BigInt(DP);

export function toScaled(s: string): bigint {
  const neg = s.startsWith('-');
  const t = neg ? s.slice(1) : s;
  const [int, frac = ''] = t.split('.');
  const scaled = BigInt((int || '0') + (frac + '0'.repeat(DP)).slice(0, DP));
  return neg ? -scaled : scaled;
}

export function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(DP + 1, '0');
  const int = a.slice(0, -DP);
  const frac = a.slice(-DP).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

/// a * b, both decimal strings → decimal string (truncated toward zero to 18 dp).
export function mulDecimal(a: string, b: string): string {
  return fromScaled((toScaled(a) * toScaled(b)) / ONE);
}

/// a - b, decimal strings → decimal string.
export function subDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b));
}

/// a + b, decimal strings → decimal string.
export function addDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

/// Sum of decimal strings → decimal string.
export function sumDecimals(xs: string[]): string {
  return fromScaled(xs.reduce((acc, x) => acc + toScaled(x), 0n));
}

/// a / n where n is a positive integer count → decimal string (truncated toward
/// zero to 18 dp). Used to split an amount evenly across bins; the caller assigns
/// the truncation remainder to one bin so the parts sum back to exactly `a`.
export function divByCount(a: string, n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`divByCount: bad count ${n}`);
  return fromScaled(toScaled(a) / BigInt(n));
}
