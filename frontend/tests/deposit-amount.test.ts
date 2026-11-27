/**
 * The deposit form's amount checks (lib/deposit-amount.ts). They mirror the
 * server's deposit guard so the form can explain a refusal before a round
 * trip; the server stays the authority (server/tests/deposit-guard.test.ts).
 */
import { describe, test, expect } from "bun:test";
import { depositAmountProblems, XRD_RESOURCE } from "../lib/deposit-amount";

const BTC = "resource_rdx1tbtceightdecimalsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const WHOLE = "resource_rdx1twholeunitsonlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const xrd = (amount: string) => ({ amount, resource: XRD_RESOURCE, label: "XRD", divisibility: 18 });
const btc = (amount: string) => ({ amount, resource: BTC, label: "BTC", divisibility: 8 });
const whole = (amount: string) => ({ amount, resource: WHOLE, label: "WHOLE", divisibility: 0 });

describe("depositAmountProblems — divisibility", () => {
  test("8 decimals pass, 9 are flagged", () => {
    expect(depositAmountProblems([btc("0.00000001"), xrd("10")], "10")).toEqual([]);
    expect(depositAmountProblems([btc("0.000000001"), xrd("10")], "10")).toEqual([
      "BTC allows at most 8 decimal places",
    ]);
  });

  test("zero divisibility: whole units only", () => {
    expect(depositAmountProblems([whole("3"), xrd("10")], "10")).toEqual([]);
    expect(depositAmountProblems([whole("3.0"), xrd("10")], "10")).toEqual([]);
    expect(depositAmountProblems([whole("3.5"), xrd("10")], "10")).toEqual(["WHOLE takes whole units only"]);
  });

  test("unknown divisibility is left to the server", () => {
    expect(depositAmountProblems([{ ...btc("0.000000001"), divisibility: undefined }, xrd("10")], "10")).toEqual([]);
  });

  test("exponent forms from a number input are flagged", () => {
    expect(depositAmountProblems([xrd("1e-7")], "10")).toEqual(["XRD: enter a plain decimal number"]);
  });
});

describe("depositAmountProblems — minimum", () => {
  test("boundary at 10 XRD, exact (no float rounding)", () => {
    expect(depositAmountProblems([xrd("10")], "10")).toEqual([]);
    expect(depositAmountProblems([xrd("9.999999999999999999")], "10")).toEqual(["The minimum deposit is 10 XRD"]);
  });

  test("no XRD sent", () => {
    expect(depositAmountProblems([btc("0.5"), xrd("")], "10")).toEqual([
      "The minimum deposit is 10 XRD, and this deposit sends no XRD",
    ]);
  });

  test("nothing typed yet → no message", () => {
    expect(depositAmountProblems([xrd(""), btc("")], "10")).toEqual([]);
  });
});
