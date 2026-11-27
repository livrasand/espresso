import crypto from "node:crypto";
import type { Redis } from "../redis/index.js";
import { logError } from "../log.js";

const PAIRING_TTL_SEC = 10 * 60;
const RESPONSE_TTL_SEC = 120;
const INBOX_MAX = 64;
const REPO_INDEX_TTL_SEC = 30 * 24 * 3600;
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

  async registerPairing(id: string, code: string, name: string, pubkey: string): Promise<void> {
    const c = normalizeCode(code);
    await this.redis.set(`paircode:${c}`, JSON.stringify({ id, name, pubkey }), "EX", PAIRING_TTL_SEC);
    await this.redis.set(`pairbyId:${id}`, c, "EX", PAIRING_TTL_SEC);
  }

  async confirmPairing(code: string, account: string): Promise<string | null> {
    const c = normalizeCode(code);
    const raw = await this.redis.get(`paircode:${c}`);
    if (raw === null) return null;
    const pending = JSON.parse(raw) as PendingPairing;
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
    await Promise.all([
      this.redis.hmset(`node:${id}`, { token, pubkey, name, account, createdAt }),
      this.redis.del(`pairbyId:${id}`),
      this.redis.sadd(`acct:${account}`, id),
      this.pushCommand(id, { action: "pair_ok", node_id: id, token }),
    ]);
    return id;
  }


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

  async touchOnline(id: string, name?: string, fw?: string): Promise<boolean> {
    const wasOnline = await this.redis.exists(`online:${id}`);
    const rec = await this.getNode(id);
    const fields: Record<string, string> = {};
    if (name !== undefined && name !== "" && rec?.["name"] !== name) fields["name"] = name;
    if (fw !== undefined && fw !== "" && rec?.["firmware"] !== fw) fields["firmware"] = fw;
    if (Object.keys(fields).length > 0) {
      await this.redis.hmset(`node:${id}`, fields).catch((e) => logError(`strata node:${id} write failed: ${e.message}`));
    }
    await this.redis.set(`online:${id}`, "1", "EX", this.onlineTtlSec).catch((e) =>
      logError(`strata online:${id} write failed: ${e.message}`),
    );
    return !wasOnline;
  }

  async isOnline(id: string): Promise<boolean> {
    let exists = false;
    try {
      exists = await this.redis.exists(`online:${id}`);
    } catch {
      exists = false;
    }
    if (exists) return true;
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
    await this.redis.set(`repos:${id}`, serialized, "EX", REPO_INDEX_TTL_SEC).catch((e) =>
      logError(`strata repos:${id} write failed: ${e.message}`),
    );
  }

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

  async allAccounts(): Promise<string[]> {
    const ids = await this.redis.keys("node:*");
    const recs = await Promise.all(ids.map((id) => this.getNode(id.slice(5))));
    return [...new Set(recs.map((r) => r?.["account"] ?? "").filter((a) => a !== ""))];
  }

  async list(): Promise<Record<string, unknown>[]> {
    const ids = await this.redis.keys("node:*");
    return Promise.all(ids.map((id) => this.nodeView(id.slice(5))));
  }

  async pushCommand(id: string, command: { action: string } & Record<string, unknown>): Promise<void> {
    const { req_id = crypto.randomUUID(), action, ...rest } = command;
    const cmd = { ...rest, req_id, action } as Command;
    await this.redis.rpush(`inbox:${id}`, JSON.stringify({ type: "cmd", ...cmd }));
  }

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

  async setGitFile(owner: string, repo: string, relPath: string, b64: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.redis.set(`gitfile:${owner}:${repo}:${relPath}`, b64, "EX", GIT_FILE_TTL_SEC);
        return;
      } catch (e) {
        if (attempt === 4) logError(`strata gitfile write failed: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
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
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.redis.set(`gitfiles:${owner}:${repo}`, JSON.stringify(paths), "EX", GIT_FILE_TTL_SEC);
        return;
      } catch (e) {
        if (attempt === 4) logError(`strata gitfiles write failed: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  async setGitRepo(owner: string, repo: string, json: string): Promise<void> {
    await this.redis.set(`gitrepo:${owner}:${repo}`, json, "EX", GIT_FILE_TTL_SEC);
  }

  async getGitRepo(owner: string, repo: string): Promise<Record<string, string> | null> {
    const raw = await this.redis.get(`gitrepo:${owner}:${repo}`).catch(() => null);
    if (typeof raw !== "string" || raw === "") return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    } catch {
      /* ignore */
    }
    return null;
  }

  async listGitFiles(owner: string, repo: string): Promise<string[]> {
    const data = await this.getGitRepo(owner, repo);
    if (data) return Object.keys(data);
    return [];
  }

  async clearGitRepo(owner: string, repo: string): Promise<void> {
    const old = await this.listGitFiles(owner, repo);
    for (const p of old) {
      for (let a = 0; a < 3; a++) {
        try { await this.redis.del(`gitfile:${owner}:${repo}:${p}`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
    }
    try {
      const stray = await this.redis.keys(`gitfile:${owner}:${repo}:*`);
      for (const k of stray) {
        for (let a = 0; a < 3; a++) {
          try { await this.redis.del(k); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
        }
      }
    } catch {
      /* ignore */
    }
    for (let a = 0; a < 3; a++) {
      try { await this.redis.del(`gitfiles:${owner}:${repo}`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    for (let a = 0; a < 3; a++) {
      try { await this.redis.del(`gitrepo:${owner}:${repo}`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
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
