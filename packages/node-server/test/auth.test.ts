// Session token + rate limiter tests (auth layer, MemoryRedis-backed).

import { describe, it, expect } from "vitest";
import { MemoryRedis } from "../src/redis/memory.js";
import { Redis } from "../src/redis/index.js";
import { issueSessionToken, validateSessionToken, SESSION_TTL_SECONDS } from "../src/auth/session.js";
import { consumeRateLimit } from "../src/auth/ratelimit.js";

const SECRET = Buffer.alloc(32, 7).fill(0);

describe("session tokens", () => {
  it("issues and validates round trip", () => {
    const token = issueSessionToken("3000000000000001", SECRET);
    expect(validateSessionToken(token, SECRET)).toBe("3000000000000001");
  });

  it("rejects tampered payloads and wrong keys", () => {
    const token = issueSessionToken("3000000000000001", SECRET);
    const [id, exp, sig] = token.split(".");
    const forged = `${"3999999999999999"}.${exp}.${sig}`;
    expect(validateSessionToken(forged, SECRET)).toBeNull();
    expect(validateSessionToken(token, Buffer.alloc(32, 9))).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = issueSessionToken("3000000000000001", SECRET);
    const future = new Date(Date.now() + (SESSION_TTL_SECONDS + 60) * 1000);
    const realNow = Date.now;
    vi_stubNow(future.getTime());
    try {
      expect(validateSessionToken(token, SECRET)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("rate limiter", () => {
  it("allows under the cap, rejects over it (shared window per IP)", async () => {
    const rds = new Redis(new MemoryRedis());
    const mk = () => consumeRateLimit(rds, { keyPrefix: "account", max: 3, windowMs: 60_000, id: "1.2.3.4" });
    expect(await mk()).toBe("allow");
    expect(await mk()).toBe("allow");
    expect(await mk()).toBe("allow");
    expect(await mk()).toBe("reject");
    expect(await mk()).toBe("reject");
    // A different IP is a fresh window.
    expect(
      await consumeRateLimit(rds, { keyPrefix: "account", max: 3, windowMs: 60_000, id: "5.6.7.8" }),
    ).toBe("allow");
  });

  it("old entries leave the window over time", async () => {
    const rds = new Redis(new MemoryRedis());
    const opts = { keyPrefix: "account", max: 2, windowMs: 100, id: "9.9.9.9" };
    await consumeRateLimit(rds, opts);
    await new Promise((r) => setTimeout(r, 150));
    expect(await consumeRateLimit(rds, opts)).toBe("allow");
  });
});

/** vitest vi.useFakeTimers alternative-free stub of Date.now. */
function vi_stubNow(ts: number): void {
  Date.now = () => ts;
}
