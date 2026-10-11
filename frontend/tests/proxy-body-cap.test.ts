/**
 * DF-6: the /api/* proxy must not buffer a body larger than the backend would
 * accept. A declared Content-Length over the cap is refused unread; a
 * streamed (chunked, no Content-Length) body is cut off at the cap.
 */
import { describe, test, expect } from "bun:test";
import { readBodyCapped, MAX_PROXY_BODY_BYTES } from "../lib/server/proxy-guard";

function streamOf(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  // highWaterMark 0: the stream pulls only when a reader asks, so `pulled`
  // counts real reads rather than the stream's own prefetch.
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.();
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe("readBodyCapped", () => {
  test("cap matches the backend's 100 KB limit", () => {
    expect(MAX_PROXY_BODY_BYTES).toBe(102_400);
  });

  test("a normal JSON body passes through intact", async () => {
    const body = JSON.stringify({ action: "deposit", amount: "1.5", note: "héllo" });
    const r = await readBodyCapped(new Request("http://x/api/dex/build", { method: "POST", body }));
    expect(r).toEqual({ ok: true, text: body });
  });

  test("an empty body is ok", async () => {
    const r = await readBodyCapped(new Request("http://x/api/auth/logout", { method: "POST" }));
    expect(r).toEqual({ ok: true, text: "" });
  });

  test("a declared Content-Length over the cap is refused without reading", async () => {
    let pulled = 0;
    const req = new Request("http://x/api/dex/build", {
      method: "POST",
      headers: { "content-length": String(MAX_PROXY_BODY_BYTES + 1) },
      body: streamOf([new Uint8Array(10)], () => pulled++),
      duplex: "half", // a stream body needs duplex (not in lib.dom's RequestInit)
    } as RequestInit);
    const r = await readBodyCapped(req);
    expect(r).toEqual({ ok: false, reason: "too_large" });
    expect(pulled).toBe(0);
  });

  test("a garbage Content-Length is refused, not read as 0", async () => {
    const req = new Request("http://x/api/dex/build", {
      method: "POST",
      headers: { "content-length": "lots" },
      body: "{}",
    });
    // Request may normalise the header; whatever reaches the guard, a
    // non-numeric declared length must never pass as "small".
    const declared = req.headers.get("content-length");
    const r = await readBodyCapped(req);
    if (declared === "lots") expect(r).toEqual({ ok: false, reason: "too_large" });
    else expect(r.ok).toBe(true);
  });

  test("a streamed body with no Content-Length is cut off at the cap", async () => {
    const chunk = new Uint8Array(16 * 1024);
    let pulled = 0;
    const many = Array.from({ length: 200 }, () => chunk); // ~3.2 MB offered
    const req = new Request("http://x/api/dex/build", {
      method: "POST",
      body: streamOf(many, () => pulled++),
      duplex: "half", // a stream body needs duplex (not in lib.dom's RequestInit)
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const r = await readBodyCapped(req);
    expect(r).toEqual({ ok: false, reason: "too_large" });
    // stopped soon after the cap, not after the whole 3.2 MB
    expect(pulled).toBeLessThan(20);
  });

  test("exactly the cap is accepted", async () => {
    const body = "a".repeat(MAX_PROXY_BODY_BYTES);
    const r = await readBodyCapped(new Request("http://x/api/dex/build", { method: "POST", body }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.length).toBe(MAX_PROXY_BODY_BYTES);
  });
});
