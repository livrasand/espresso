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
import { logError } from "../log.js";

const PAIRING_TTL_SEC = 10 * 60;
const RESPONSE_TTL_SEC = 120;
const INBOX_MAX = 64;
// How long the last-known repo index survives in Strata after a node goes
// offline. ninfo:<id> itself only lives onlineTtlSec*24 (~36 min), so a
// disconnected node loses its repo index quickly; this keeps a stale-but-usable
// copy around so the dashboard/URLs keep working while the node reconnects.
const REPO_INDEX_TTL_SEC = 30 * 24 * 3600;
// How long a git repo's files live in Strata (control plane storage). Acts as
// the primary store for git push/clone so Vercel's 60 s limit and the node's
// slow polling no longer block git operations.
const GIT_FILE_TTL_SEC = 30 * 24 * 3600;

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
    const pending = JSON.parse(raw) as PendingPairing;
    // Delete the pending code in parallel with provisioning to save a round trip.
    const [id] = await Promise.all([
      this.provisionNode(pending, account),
      this.redis.del(`paircode:${c}`),
    ]);
    return id;
  }

  async provisionNode(pending: PendingPairing, account: string): Promise<string> {
    const { id, name, pubkey } = pending;
    const token = newToken();
    const createdAt = new Date().toISOString();
    // These writes are independent once the token exists; run them in parallel
    // to cut Strata round-trips (important on serverless where each command is
    // an HTTP call to the git-backed store).
    await Promise.all([
      this.redis.hmset(`node:${id}`, { token, pubkey, name, account, createdAt }),
      this.redis.del(`pairbyId:${id}`),
      this.redis.sadd(`acct:${account}`, id),
      this.pushCommand(id, { action: "pair_ok", node_id: id, token }),
    ]);
    return id;
  }

  // ── node record ────────────────────────────────────────────────────

  async getNode(id: string): Promise<Record<string, string> | null> {
    let rec: Record<string, string> = {};
    try {
      rec = await this.redis.hgetall(`node:${id}`);
    } catch {
      rec = {};
    }
    return Object.keys(rec).length > 0 ? rec : null;
  }

  async tokenValid(id: string, token: string): Promise<boolean> {
    const rec = await this.getNode(id);
    if (!rec) return false;
    const stored = rec["token"];
    if (typeof stored !== "string" || stored !== token) return false;
    return true;
  }

  /** Marks liveness after a hello/poll; returns true when transitioning online.
   * Strata writes (backed by Codeberg git pushes) can be rejected upstream
   * (e.g. 403 PushRejected). Those failures must not kill the poll: a node
   * that just authenticated with a valid token is online regardless of
   * whether the liveness key could be persisted. */
  async touchOnline(id: string, name?: string, fw?: string): Promise<boolean> {
    const wasOnline = await this.redis.exists(`online:${id}`);
    const rec = await this.getNode(id);
    const fields: Record<string, string> = {};
    if (name !== undefined && name !== "" && rec?.["name"] !== name) fields["name"] = name;
    if (fw !== undefined && fw !== "" && rec?.["firmware"] !== fw) fields["firmware"] = fw;
    if (Object.keys(fields).length > 0) {
      await this.redis.hmset(`node:${id}`, fields).catch((e) => logError(`strata node:${id} write failed: ${e.message}`));
    }
    // Best-effort liveness write: don't let an upstream rejection fail the poll.
    await this.redis.set(`online:${id}`, "1", "EX", this.onlineTtlSec).catch((e) =>
      logError(`strata online:${id} write failed: ${e.message}`),
    );
    return !wasOnline;
  }

  async isOnline(id: string): Promise<boolean> {
    // Fast path: persistent liveness key. Strata reads can time out when
    // Codeberg is slow; treat a read failure as "unknown" and fall through.
    let exists = false;
    try {
      exists = await this.redis.exists(`online:${id}`);
    } catch {
      exists = false;
    }
    if (exists) return true;
    // Fallback: the node is online if it recently reported telemetry. This
    // covers the case where the online:<id> write was rejected upstream but
    // the node is actively polling.
    let info: Record<string, string> = {};
    try {
      info = (await this.redis.hgetall(`ninfo:${id}`).catch(() => ({} as Record<string, string>))) as Record<string, string>;
    } catch {
      info = {};
    }
    const lastSeen = info["lastSeen"];
    if (typeof lastSeen === "string" && lastSeen !== "") {
      const age = Date.now() - Date.parse(lastSeen);
      if (age >= 0 && age < this.onlineTtlSec * 1000) return true;
    }
    return false;
  }

  async setOffline(id: string): Promise<void> {
    await this.redis.del(`online:${id}`);
  }

  /**
   * Unpair a node: wipe every record associated with it so it disappears
   * from the dashboard and can be re-paired later. Returns the owner
   * account (or null when the node did not exist). Every individual delete
   * is best-effort: an upstream rejection on one key must not fail the whole
   * unpair.
   */
  async unpairNode(id: string): Promise<string | null> {
    let rec: Record<string, string> | null;
    try {
      rec = await this.getNode(id);
    } catch {
      return null;
    }
    if (!rec) return null;
    const account = rec["account"] ?? "";
    let pendingCode: string | null;
    try {
      pendingCode = await this.pendingCodeFor(id);
    } catch {
      pendingCode = null;
    }
    const del = (k: string) => this.redis.del(k).catch(() => 0);
    const srem = (k: string, m: string) => this.redis.srem(k, m).catch(() => 0);
    await Promise.all([
      del(`node:${id}`),
      del(`online:${id}`),
      del(`ninfo:${id}`),
      del(`repos:${id}`),
      del(`pairbyId:${id}`),
      del(`inbox:${id}`),
      pendingCode ? del(`paircode:${pendingCode}`) : Promise.resolve(0),
      account ? srem(`acct:${account}`, id) : Promise.resolve(0),
    ]);
    return account;
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
    const fields: Record<string, string> = { lastSeen: new Date().toISOString() };
    for (const [k, v] of Object.entries(telemetry)) {
      if (v !== undefined) fields[k] = String(Math.floor(v));
    }
    await this.redis.hmsetEx(`ninfo:${id}`, this.onlineTtlSec * 24, fields).catch((e) =>
      logError(`strata ninfo:${id} write failed: ${e.message}`),
    );
  }

  async updateRepos(id: string, repos: RepoEntry[]): Promise<void> {
    const serialized = JSON.stringify(repos);
    await this.redis.hmsetEx(`ninfo:${id}`, this.onlineTtlSec * 24, { repositories: serialized });
    // Persist a long-lived copy so the repo index survives ninfo expiry while
    // the node is offline (Strata is git-backed and slow to re-populate).
    await this.redis.set(`repos:${id}`, serialized, "EX", REPO_INDEX_TTL_SEC).catch((e) =>
      logError(`strata repos:${id} write failed: ${e.message}`),
    );
  }

  /** Best-effort read of the cached repo index; never throws. Falls back to the
   * long-lived repos:<id> copy when ninfo has expired (node offline). */
  async getCachedRepos(id: string): Promise<RepoEntry[]> {
    let info: Record<string, string> = {};
    try {
      info = (await this.redis.hgetall(`ninfo:${id}`).catch(() => ({} as Record<string, string>))) as Record<string, string>;
    } catch {
      info = {};
    }
    const cached = info["repositories"];
    if (typeof cached === "string" && cached !== "") {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed as RepoEntry[];
      } catch {
        /* ignore */
      }
    }
    // Fallback: persistent index written on every repo_list response.
    try {
      const raw = await this.redis.get(`repos:${id}`);
      if (typeof raw === "string" && raw !== "") {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as RepoEntry[];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  // ── dashboard views ────────────────────────────────────────────────

  async nodeView(id: string): Promise<Record<string, unknown>> {
    const [rec0, info, online] = await Promise.all([
      this.getNode(id),
      this.redis.hgetall(`ninfo:${id}`).catch(() => ({} as Record<string, string>)),
      this.isOnline(id),
    ]);
    const rec = rec0 ?? {};
    let repos = [] as RepoEntry[];
    if (typeof info["repositories"] === "string" && info["repositories"] !== "") {
      try {
        repos = JSON.parse(info["repositories"]) as RepoEntry[];
      } catch {
        repos = [];
      }
    }
    if (repos.length === 0) {
      // Fallback to the long-lived repo index when ninfo expired (offline).
      try {
        const raw = await this.redis.get(`repos:${id}`);
        if (typeof raw === "string" && raw !== "") {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) repos = parsed as RepoEntry[];
        }
      } catch {
        /* ignore */
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

  /** Distinct owner accounts across every node (cheap: node records only). */
  async allAccounts(): Promise<string[]> {
    const ids = await this.redis.keys("node:*");
    const recs = await Promise.all(ids.map((id) => this.getNode(id.slice(5))));
    return [...new Set(recs.map((r) => r?.["account"] ?? "").filter((a) => a !== ""))];
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

  // ── git file storage (Strata-backed, control plane primary store) ──
  // These let push/clone run against the control plane without depending on
  // the node's slow per-file RPC.

  async setGitFile(owner: string, repo: string, relPath: string, b64: string): Promise<void> {
    await this.redis.set(`gitfile:${owner}:${repo}:${relPath}`, b64, "EX", GIT_FILE_TTL_SEC).catch((e) =>
      logError(`strata gitfile write failed: ${e.message}`),
    );
  }

  async getGitFile(owner: string, repo: string, relPath: string): Promise<Buffer | null> {
    const raw = await this.redis.get(`gitfile:${owner}:${repo}:${relPath}`).catch(() => null);
    if (typeof raw !== "string" || raw === "") return null;
    try {
      return Buffer.from(raw, "base64");
    } catch {
      return null;
    }
  }

  async setGitFileList(owner: string, repo: string, paths: string[]): Promise<void> {
    await this.redis.set(`gitfiles:${owner}:${repo}`, JSON.stringify(paths), "EX", GIT_FILE_TTL_SEC).catch((e) =>
      logError(`strata gitfiles write failed: ${e.message}`),
    );
  }

  async listGitFiles(owner: string, repo: string): Promise<string[]> {
    const raw = await this.redis.get(`gitfiles:${owner}:${repo}`).catch(() => null);
    if (typeof raw !== "string" || raw === "") return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      /* ignore */
    }
    return [];
  }

  async clearGitRepo(owner: string, repo: string): Promise<void> {
    const old = await this.listGitFiles(owner, repo);
    for (const p of old) {
      await this.redis.del(`gitfile:${owner}:${repo}:${p}`).catch(() => 0);
    }
    await this.redis.del(`gitfiles:${owner}:${repo}`).catch(() => 0);
  }

  async setTelegramChat(chatId: number, account: string): Promise<void> {
    await this.redis.set(`tg:chat:${chatId}`, account);
  }

  async getTelegramChat(chatId: number): Promise<string | null> {
    return this.redis.get(`tg:chat:${chatId}`);
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
