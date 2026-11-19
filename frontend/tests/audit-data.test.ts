import { describe, test, expect } from "bun:test";
import { getAuditInfo, isAudited } from "../lib/audit-data";

describe("audit-data venue status", () => {
  test("CaviarNine is marked sunset, never plain audited", () => {
    const c9 = getAuditInfo("caviarnine");
    expect(c9.venueStatus).toBe("sunset");
    expect(c9.venueLabel).toMatch(/exit only/i);
    expect(c9.venueSource).toMatch(/^https:\/\//);
    expect(isAudited("caviarnine")).toBe(false);
  });

  test("Weft is marked exploited with a public source, never plain audited", () => {
    const weft = getAuditInfo("weft");
    expect(weft.venueStatus).toBe("exploited");
    expect(weft.venueLabel).toMatch(/unverified/i);
    expect(weft.venueSource).toBe("https://defillama.com/hacks");
    expect(isAudited("weft")).toBe(false);
  });

  test("live venues carry no venue status", () => {
    for (const p of ["ociswap", "defiplaza", "radix"]) {
      expect(getAuditInfo(p).venueStatus).toBeUndefined();
    }
  });
});
