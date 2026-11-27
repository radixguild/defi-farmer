/**
 * Deposit form checks that mirror the server's deposit guard
 * (server/src/services/dex/deposit-guard.ts): an amount may not be finer than
 * its token's divisibility, and a deposit must send at least the minimum in
 * XRD. A convenience only — the server enforces both on every build and is the
 * authority; this lets the form say so before a round trip.
 *
 * Exact decimal maths (BigInt at 18 dp), never parseFloat, for the comparisons.
 */

export const XRD_RESOURCE =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

const PLAIN_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export interface FormLeg {
  /** What the user typed ("" = left empty). */
  amount: string;
  resource: string;
  /** Shown in the message, e.g. the token symbol. */
  label: string;
  /** From pool-info; undefined when the server could not read it. */
  divisibility?: number;
}

function scaled(s: string): bigint {
  const [int, frac = ""] = s.split(".");
  return BigInt((int || "0") + (frac + "0".repeat(18)).slice(0, 18));
}

export function decimalPlaces(amount: string): number {
  return (amount.split(".")[1] ?? "").replace(/0+$/, "").length;
}

/**
 * Problems with the typed amounts, as short sentences for the form. Empty
 * array = nothing the form can see is wrong. Empty and zero legs are skipped
 * (a concentrated deposit may leave one side empty).
 */
export function depositAmountProblems(legs: FormLeg[], minDepositXrd?: string): string[] {
  const problems: string[] = [];
  const live: FormLeg[] = [];
  for (const leg of legs) {
    const a = leg.amount.trim();
    if (a === "") continue;
    if (!PLAIN_DECIMAL.test(a)) {
      problems.push(`${leg.label}: enter a plain decimal number`);
      continue;
    }
    if (decimalPlaces(a) > 18 || scaled(a) === BigInt(0)) continue;
    live.push({ ...leg, amount: a });
    if (leg.divisibility !== undefined && decimalPlaces(a) > leg.divisibility) {
      problems.push(
        leg.divisibility === 0
          ? `${leg.label} takes whole units only`
          : `${leg.label} allows at most ${leg.divisibility} decimal places`,
      );
    }
  }
  if (minDepositXrd && problems.length === 0 && live.length > 0) {
    const xrd = live.filter((l) => l.resource === XRD_RESOURCE);
    if (xrd.length === 0) {
      problems.push(`The minimum deposit is ${minDepositXrd} XRD, and this deposit sends no XRD`);
    } else if (xrd.some((l) => scaled(l.amount) < scaled(minDepositXrd))) {
      problems.push(`The minimum deposit is ${minDepositXrd} XRD`);
    }
  }
  return problems;
}
