// Node registry over Redis (port of internal/node/hub.go + store.go).
// Memory maps become Redis structures so state survives serverless instance
// rotation:
//   node:<id>          hash {token, pubkey, name, firmware, account, createdAt}
//   acct:<account>     set of node ids owned by that account
//   online:<id>        string "1", EX nodeOnlineTtl (liveness)
//   ninfo:<id>         hash {uptime, storage..., repositories JSON}
//   paircode:<CODE>    hash {id, name, pubkey} EX 600 (pending pairing)
//   pairbyId:<id>      string CODE (reverse index)
//   inbox:<id>         list of queued JSON commands
//   resp:<reqId>       string response JSON, EX 120

import crypto from "node:crypto";
import type { Redis } from "../redis/index.js";

const PAIRING_TTL_SEC = 10 * 60;
const RESPONSE_TTL_SEC = 120;
const INBOX_MAX = 64;

export interface RepoEntry {
  name: string;
  size: number;
}

export interface PendingPairing {
  id: string;
  name: string;
  pubkey: string;
}

export type Command = Record<string, unknown> & { req_id: string; action: string };

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function normalizeCode(code: string): string {
  return code
    .split("")
    .filter((c) => c !== "-" && c !== " ")
    .join("")
    .toUpperCase();
}

export class NodeRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly onlineTtlSec: number,
  ) {}

  // ── pairing ────────────────────────────────────────────────────────

  /** RPUSHes nothing; stores a pending pairing keyed by its code (TTL 10m). */
  async registerPairing(id: string, code: string, name: string, pubkey: string): Promise<void> {
    const c = normalizeCode(code);
    await this.redis.set(`paircode:${c}`, JSON.stringify({ id, name, pubkey }), "EX", PAIRING_TTL_SEC);
    await this.redis.set(`pairbyId:${id}`, c, "EX", PAIRING_TTL_SEC);
  }

  /**
   * Completes pairing for a user-entered code; provisions the node and
   * queues the `pair_ok` command so the node learns its token on its next
   * poll. Returns the node id or null when the code is invalid/expired.
   */
  async confirmPairing(code: string, account: string): Promise<string | null> {
    const c = normalizeCode(code);
    const raw = await this.redis.get(`paircode:${c}`);
    if (raw === null) return null;
    await this.redis.del(`paircode:${c}`);
    const pending = JSON.parse(raw) as PendingPairing;
    return this.provisionNode(pending, account);
  }

  async provisionNode(pending: PendingPairing, account: string): Promise<string> {
    const { id, name, pubkey } = pending;
    const token = newToken();
    await this.redis.hset(`node:${id}`, "token", token);
    await this.redis.hset(`node:${id}`, "pubkey", pubkey);
    await this.redis.hset(`node:${id}`, "name", name);
    await this.redis.hset(`node:${id}`, "account", account);
    await this.redis.hset(`node:${id}`, "createdAt", new Date().toISOString());
    // Pairing is complete: drop the reverse index so the unpaired poll path
    // closes.
    await this.redis.del(`pairbyId:${id}`);
    await this.redis.sadd(`acct:${account}`, id);
    // pair_ok is delivered through the poll inbox.
    await this.pushCommand(id, { action: "pair_ok", node_id: id, token });
    return id;
  }

  // ── node record ────────────────────────────────────────────────────

  async getNode(id: string): Promise<Record<string, string> | null> {
    const rec = await this.redis.hgetall(`node:${id}`);
    return Object.keys(rec).length > 0 ? rec : null;
  }

  async tokenValid(id: string, token: string): Promise<boolean> {
    const rec = await this.getNode(id);
    if (!rec) return false;
    const stored = rec["token"];
    if (typeof stored !== "string" || stored !== token) return false;
    return true;
  }

  /** Marks liveness after a hello/poll; returns true when transitioning online. */
  async touchOnline(id: string, name?: string, fw?: string): Promise<boolean> {
    const was = await this.redis.exists(`online:${id}`);
    if (name !== undefined && name !== "") await this.redis.hset(`node:${id}`, "name", name);
    if (fw !== undefined && fw !== "") await this.redis.hset(`node:${id}`, "firmware", fw);
    await this.redis.set(`online:${id}`, "1", "EX", this.onlineTtlSec);
    return !was;
  }

  async isOnline(id: string): Promise<boolean> {
    return this.redis.exists(`online:${id}`);
  }

  async setOffline(id: string): Promise<void> {
    await this.redis.del(`online:${id}`);
  }

  // ── telemetry / repo index (ninfo:<id>) ────────────────────────────

  async touchTelemetry(
    id: string,
    telemetry: {
      uptime_s?: number;
      storage_free?: number;
      storage_total?: number;
      ram_total?: number;
      heap_free?: number;
      wifi_rssi?: number;
    },
  ): Promise<void> {
    if (telemetry.uptime_s !== undefined) await this.redis.hset(`ninfo:${id}`, "uptime_s", String(Math.floor(telemetry.uptime_s)));
    if (telemetry.storage_free !== undefined) await this.redis.hset(`ninfo:${id}`, "storage_free", String(Math.floor(telemetry.storage_free)));
    if (telemetry.storage_total !== undefined) await this.redis.hset(`ninfo:${id}`, "storage_total", String(Math.floor(telemetry.storage_total)));
    if (telemetry.ram_total !== undefined) await this.redis.hset(`ninfo:${id}`, "ram_total", String(Math.floor(telemetry.ram_total)));
    if (telemetry.heap_free !== undefined) await this.redis.hset(`ninfo:${id}`, "heap_free", String(Math.floor(telemetry.heap_free)));
    if (telemetry.wifi_rssi !== undefined) await this.redis.hset(`ninfo:${id}`, "wifi_rssi", String(Math.floor(telemetry.wifi_rssi)));
    void this.redis.expire(`ninfo:${id}`, this.onlineTtlSec * 24);
  }

  async updateRepos(id: string, repos: RepoEntry[]): Promise<void> {
    await this.redis.hset(`ninfo:${id}`, "repositories", JSON.stringify(repos));
    void this.redis.expire(`ninfo:${id}`, this.onlineTtlSec * 24);
  }

  // ── dashboard views ────────────────────────────────────────────────

  private async nodeView(id: string): Promise<Record<string, unknown>> {
    const rec = (await this.getNode(id)) ?? {};
    const info = await this.redis.hgetall(`ninfo:${id}`);
    const online = await this.isOnline(id);
    let repos = [] as RepoEntry[];
    if (typeof info["repositories"] === "string" && info["repositories"] !== "") {
      try {
        repos = JSON.parse(info["repositories"]) as RepoEntry[];
      } catch {
        repos = [];
      }
    }
    return {
      id,
      account: rec["account"] ?? "",
      name: rec["name"] ? rec["name"] : id,
      online,
      last_seen: info["lastSeen"] ?? info["createdAt"] ?? new Date().toISOString(),
      storage_free: Number(info["storage_free"] ?? 0),
      storage_max: Number(info["storage_total"] ?? 0),
      ram_total: Number(info["ram_total"] ?? 0),
      uptime_s: Number(info["uptime_s"] ?? 0),
      heap_free: Number(info["heap_free"] ?? 0),
      wifi_rssi: Number(info["wifi_rssi"] ?? 0),
      firmware: rec["firmware"] ?? "",
      repositories: repos,
    };
  }

  async listByAccount(account: string): Promise<Record<string, unknown>[]> {
    const ids = await this.redis.smembers(`acct:${account}`);
    return Promise.all(ids.map((id) => this.nodeView(id)));
  }

  async list(): Promise<Record<string, unknown>[]> {
    const ids = await this.redis.keys("node:*");
    return Promise.all(ids.map((id) => this.nodeView(id.slice(5))));
  }

  // ── inbox / RPC plumbing ───────────────────────────────────────────

  /** Queues a command for the node's next poll. */
  async pushCommand(id: string, command: { action: string } & Record<string, unknown>): Promise<void> {
    const { req_id = crypto.randomUUID(), action, ...rest } = command;
    const cmd = { ...rest, req_id, action } as Command;
    await this.redis.rpush(`inbox:${id}`, JSON.stringify({ type: "cmd", ...cmd }));
  }

  /** Drains up to INBOX_MAX queued commands for the node. */
  async drainInbox(id: string): Promise<Record<string, unknown>[]> {
    const raw = await this.redis.lpopAll(`inbox:${id}`, INBOX_MAX);
    const out: Record<string, unknown>[] = [];
    for (const s of raw) {
      try {
        out.push(JSON.parse(s));
      } catch {
        /* ignore malformed */
      }
    }
    return out;
  }

  pendingCodeFor(id: string): Promise<string | null> {
    return this.redis.get(`pairbyId:${id}`);
  }

  async pairingByCode(code: string): Promise<PendingPairing | null> {
    const raw = await this.redis.get(`paircode:${code}`);
    if (raw === null) return null;
    return JSON.parse(raw) as PendingPairing;
  }

  async storeResponse(reqId: string, payload: Record<string, unknown>): Promise<void> {
    await this.redis.set(`resp:${reqId}`, JSON.stringify(payload), "EX", RESPONSE_TTL_SEC);
  }

  async peekResponse(reqId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.redis.get(`resp:${reqId}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
