/**
 * The Content-Security-Policy must let the standard √ Connect button finish on
 * a phone. There the dApp Toolkit deep-links to the Radix Wallet app and then
 * POSTs to the Radix Connect relay to collect the wallet's response; a CSP
 * without the relay in connect-src blocks that fetch and the connect never
 * completes. Checked against the toolkit source (2.3.0): the relay base URL is
 * hard-coded in RadixConnectRelayModule.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELAY = "https://radix-connect-relay.radixdlt.com";

const nextConfig = require("../next.config.js") as {
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
};

async function directive(name: string): Promise<string[]> {
  const rules = await nextConfig.headers();
  const all = rules.find((r) => r.source === "/:path*");
  const csp = all?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found ? found.split(/\s+/).slice(1) : [];
}

describe("Content-Security-Policy", () => {
  test("connect-src allows the Radix Connect relay (mobile √ Connect)", async () => {
    expect(await directive("connect-src")).toContain(RELAY);
  });

  test("connect-src stays an explicit list: no wildcards, no bare schemes", async () => {
    for (const source of await directive("connect-src")) {
      expect(source.includes("*"), source).toBe(false);
      expect(/^[a-z]+:$/.test(source), source).toBe(false);
    }
  });

  test("the relay origin is the one the installed toolkit actually calls", () => {
    const toolkit = readFileSync(
      join(import.meta.dir, "..", "node_modules", "@radixdlt", "radix-dapp-toolkit", "dist", "index.js"),
      "utf8",
    );
    expect(toolkit).toContain(`baseUrl: "${RELAY}"`);
  });
});
