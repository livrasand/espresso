import { describe, it, expect, vi, afterEach } from "vitest";
import { StrataBackend } from "../src/redis/strata.js";
import { Redis } from "../src/redis/index.js";

function mockStrata() {
  const store = new Map<string, string>();
  const calls = { n: 0 };
  vi.stubGlobal("fetch", (async (url: string, init: RequestInit = {}) => {
    calls.n++;
    const k = decodeURIComponent(String(url).split("/kv/")[1] ?? "");
    const m = init.method ?? "GET";
    if (m === "PUT") {
      store.set(k, JSON.parse(String(init.body)).value);
      return new Response("{}");
    }
    if (m === "DELETE") return new Response("", { status: store.delete(k) ? 200 : 404 });
    return store.has(k) ? new Response(JSON.stringify({ value: store.get(k) })) : new Response("", { status: 404 });
  }) as typeof fetch);
  return { r: new Redis(new StrataBackend("http://strata", "t")), calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("StrataBackend", () => {
  it("serves cacheable keys from memory and dedupes concurrent reads", async () => {
    const { r, calls } = mockStrata();
    await r.hmsetEx("node:A", 100, { a: "1" });
    calls.n = 0;
    expect(await r.hgetall("node:A")).toEqual({ a: "1" });
    expect(await r.hgetall("node:A")).toEqual({ a: "1" });
    expect(calls.n).toBe(0);
  });

  it("never caches liveness-style keys", async () => {
    const { r, calls } = mockStrata();
    await r.set("online:A", "1", "EX", 60);
    calls.n = 0;
    await r.exists("online:A");
    await r.exists("online:A");
    expect(calls.n).toBe(2);
  });

  it("zwindow counts hits in one read+write and DEL is a single request", async () => {
    const { r, calls } = mockStrata();
    expect(await r.zwindow("rl:x", Date.now(), "a", 60000)).toBe(1);
    calls.n = 0;
    expect(await r.zwindow("rl:x", Date.now(), "b", 60000)).toBe(2);
    expect(calls.n).toBe(2);
    calls.n = 0;
    expect(await r.del("rl:x")).toBe(1);
    expect(await r.del("rl:x")).toBe(0);
    expect(calls.n).toBe(2);
  });
});
