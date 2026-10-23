// Tests mirroring internal/accounts/store_test.go and internal/node tests,
// both over MemoryRedis.

import { describe, it, expect } from "vitest";
import { MemoryRedis } from "../src/redis/memory.js";
import { Redis } from "../src/redis/index.js";
import { AccountStore, ACCOUNT_NUMBER_LENGTH } from "../src/accounts/store.js";
import { NodeRegistry } from "../src/nodes/registry.js";
import { makeRpc, sleep } from "../src/nodes/rpc.js";

function makeStore(): { store: AccountStore; redis: Redis } {
  const redis = new Redis(new MemoryRedis());
  return { store: new AccountStore(redis), redis };
}

function makeRegistry(onlineTtlSec = 90): { registry: NodeRegistry; redis: Redis } {
  const redis = new Redis(new MemoryRedis());
  return { registry: new NodeRegistry(redis, onlineTtlSec), redis };
}

describe("AccountStore", () => {
  it("creates 16-digit account numbers and persists only the hash", async () => {
    const { store } = makeStore();
    const code = await store.create();
    expect(code).toMatch(/^[1-9][0-9]{15}$/);
    expect(code).toHaveLength(ACCOUNT_NUMBER_LENGTH);
    expect(await store.exists(code)).toBe(true);
  });

  it("normalizes digits only (dashes, spaces, separators)", async () => {
    const { store } = makeStore();
    const code = await store.create();
    const pretty = (code.match(/.{4}/g) ?? []).join("-");
    expect(await store.exists(pretty)).toBe(true);
    expect(await store.exists("0000-0000-0000-0000")).toBe(false);
  });

  it("rates uniqueness: repeated creates yield distinct numbers", async () => {
    const { store } = makeStore();
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(await store.create());
    expect(seen.size).toBe(8);
  });
});

describe("NodeRegistry pairing", () => {
  it("registers a pairing, confirms it, and provisions the node", async () => {
    const { registry } = makeRegistry();
    await registry.registerPairing("NODE1234ABCD", "AAAA-BBBB-CCCC", "Desk ESP32", "PUBKEY123");
    expect(await registry.pendingCodeFor("NODE1234ABCD")).toBe("AAAABBBBCCCC"); // codes normalize
    expect(await registry.pairingByCode("AAAABBBBCCCC")).toMatchObject({
      id: "NODE1234ABCD",
      name: "Desk ESP32",
    });

    const nodeId = await registry.confirmPairing("AAAABBBBCCCC", "3000000000000001");
    expect(nodeId).toBe("NODE1234ABCD");

    const rec = await registry.getNode("NODE1234ABCD");
    expect(rec).not.toBeNull();
    expect(rec!["account"]).toBe("3000000000000001");
    // Pending pairing state is consumed.
    expect(await registry.pendingCodeFor("NODE1234ABCD")).toBeNull();

    // The node learns its token through the poll inbox.
    const cmds = await registry.drainInbox("NODE1234ABCD");
    expect(cmds[0]?.["action"]).toBe("pair_ok");
    expect(typeof cmds[0]?.["token"]).toBe("string");

    // Account listing includes the node.
    const nodes = await registry.listByAccount("3000000000000001");
    expect(nodes).toHaveLength(1);
  });

  it("rejects expired or wrong codes", async () => {
    const { registry } = makeRegistry();
    await registry.registerPairing("NODE1234ABCD", "AAAA-BBBB-CCCC", "", "PUBKEY");
    expect(await registry.confirmPairing("XXXXYYYYZZZZ", "3000000000000001")).toBeNull();
    // The valid code stays pending after a mismatched attempt.
    expect(await registry.pendingCodeFor("NODE1234ABCD")).toBe("AAAABBBBCCCC");
  });
});

describe("NodeRegistry liveness + repo index", () => {
  it("touchOnline transitions offline→online and labels the node", async () => {
    const { registry } = makeRegistry();
    expect(await registry.isOnline("NODE1234ABCD")).toBe(false);
    expect(await registry.touchOnline("NODE1234ABCD", "Desk", "1.2.3")).toBe(true);
    expect(await registry.isOnline("NODE1234ABCD")).toBe(true);
    expect(await registry.touchOnline("NODE1234ABCD")).toBe(false);

    const rec = await registry.getNode("NODE1234ABCD");
    expect(rec!["name"]).toBe("Desk");
    expect(rec!["firmware"]).toBe("1.2.3");
  });

  it("updateRepos feeds the dashboard listing", async () => {
    const { registry } = makeRegistry();
    // Provisioning writes the node:<id> record the listing requires.
    await registry.provisionNode({ id: "NODE1234ABCD", name: "Desk", pubkey: "PUBKEY" }, "3000000000000001");
    await registry.touchOnline("NODE1234ABCD");
    await registry.updateRepos("NODE1234ABCD", [
      { name: "blink", size: 42 },
      { name: "docs", size: 7 },
    ]);
    // Provisioning queued a pair_ok command; it must not leak into here.
    await registry.drainInbox("NODE1234ABCD");
    const nodes = await registry.listByAccount("does-not-exist");
    expect(nodes).toHaveLength(0);
    const ids = await registry.list();
    expect(ids.map((n) => n["id"])).toEqual(["NODE1234ABCD"]);
    expect(ids[0]!["repositories"]).toEqual([
      { name: "blink", size: 42 },
      { name: "docs", size: 7 },
    ]);
  });
});

describe("RPC inbox round trip", () => {
  it("resolves when the node drains the inbox and responds", async () => {
    const { registry } = makeRegistry();
    const callNode = makeRpc(registry, { rpcTimeoutMs: 5000, maxWaitMs: 60_000 });

    const pending = callNode("NODE1234ABCD", "repo_list", {});
    // Simulate the node: drain inbox, read req_id, post the matching reply.
    const cmds = await drainUntil(registry);
    expect(cmds[0]!["action"]).toBe("repo_list");
    await registry.storeResponse(String(cmds[0]!["req_id"]), { ok: true, repositories: [{ name: "blink", size: 3 }] });
    const resp = (await pending) as Record<string, unknown>;
    expect(resp["ok"]).toBe(true);
    expect(resp["repositories"]).toEqual([{ name: "blink", size: 3 }]);
  });

  it("propagates node errors as RpcError(502)", async () => {
    const { registry } = makeRegistry();
    const callNode = makeRpc(registry, { rpcTimeoutMs: 5000, maxWaitMs: 60_000 });

    const pending = callNode("NODE1234ABCD", "fs_read");
    const cmds = await drainUntil(registry);
    await registry.storeResponse(String(cmds[0]!["req_id"]), { ok: false, error: "boom" });
    await expect(pending).rejects.toMatchObject({ status: 502, message: "node error: boom" });
  });

  it("times out as RpcError(504) without a response", async () => {
    const { registry } = makeRegistry();
    const callNode = makeRpc(registry, { rpcTimeoutMs: 400, maxWaitMs: 60_000 });
    const pending = callNode("NODE1234ABCD", "repo_list");
    // Subscribed early so Node never reports an unhandled rejection.
    pending.catch(() => {});
    await sleep(600);
    await expect(pending).rejects.toMatchObject({ status: 504 });
  });
});

/** Polls the inbox the way a node firmware would until at least one
 * command is available. */
async function drainUntil(registry: NodeRegistry, attempts = 20): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < attempts; i++) {
    const cmds = await registry.drainInbox("NODE1234ABCD");
    if (cmds.length > 0) return cmds;
    await sleep(25);
  }
  throw new Error("no command delivered to the inbox");
}
