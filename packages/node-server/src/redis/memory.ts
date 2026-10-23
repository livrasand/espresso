// Minimal in-memory Redis workalike for local dev and tests.
// Implements only the commands the server uses.

import type { RedisLike, RedisReply } from "./index.js";

interface ZEntry {
  score: number;
  member: string;
}

export class MemoryRedis implements RedisLike {
  private kv = new Map<string, string | string[] | Map<string, string> | Set<string> | ZEntry[]>();
  private ttls = new Map<string, number>(); // key -> expiresAt epoch ms

  private alive(key: string): string | string[] | Map<string, string> | Set<string> | ZEntry[] | undefined {
    const expiry = this.ttls.get(key);
    if (expiry !== undefined && expiry < Date.now()) {
      this.kv.delete(key);
      this.ttls.delete(key);
      return undefined;
    }
    return this.kv.get(key);
  }

  async exec(command: (string | number)[]): Promise<RedisReply> {
    const cmd = String(command[0] ?? "").toUpperCase();
    const args = command.slice(1).map((a) => String(a));
    const key = args[0] ?? "";

    switch (cmd) {
      case "GET": {
        const v = this.alive(key);
        return typeof v === "string" ? v : null;
      }
      case "SET": {
        const idx = args.indexOf("NX");
        const existing = this.alive(key);
        if (idx !== -1 && existing !== undefined) return null;
        this.kv.set(key, args[1] ?? "");
        const ex = args.findIndex((a) => a === "EX" || a === "ex");
        if (ex !== -1 && args[ex + 1]) this.ttls.set(key, Date.now() + Number(args[ex + 1]) * 1000);
        else this.ttls.delete(key);
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const k of command.slice(1)) if (this.kv.delete(String(k))) n++;
        this.ttls.delete(key);
        return n;
      }
      case "EXISTS":
        return this.alive(key) !== undefined ? 1 : 0;
      case "TTL": {
        const expiry = this.ttls.get(key);
        if (this.alive(key) === undefined) return -2;
        if (expiry === undefined) return -1;
        return Math.ceil((expiry - Date.now()) / 1000);
      }
      case "EXPIRE": {
        if (this.alive(key) === undefined) return 0;
        this.ttls.set(key, Date.now() + Number(args[1]) * 1000);
        return 1;
      }
      case "HSET": {
        let h = this.alive(key);
        if (!(h instanceof Map)) h = new Map();
        for (let i = 1; i + 1 < args.length; i += 2) h.set(args[i]!, args[i + 1]!);
        this.kv.set(key, h);
        return (args.length - 1) / 2;
      }
      case "HGET": {
        const h = this.alive(key);
        return h instanceof Map ? (h.get(args[1] ?? "") ?? null) : null;
      }
      case "HGETALL": {
        const h = this.alive(key);
        if (!(h instanceof Map)) return [];
        const flat: string[] = [];
        for (const [k, v] of h) flat.push(k, v);
        return flat;
      }
      case "RPUSH": {
        let list = this.alive(key);
        if (!Array.isArray(list)) list = [];
        const strList = list as string[];
        for (const v of args.slice(1)) strList.push(v);
        this.kv.set(key, strList);
        return strList.length;
      }
      case "LPOP": {
        const list = this.alive(key);
        if (!Array.isArray(list)) return null;
        const strList = list as string[];
        const count = args[1] !== undefined ? Number(args[1]) : 1;
        if (count <= 1) {
          const v = strList.shift() ?? null;
          if (strList.length === 0) this.kv.delete(key);
          return v as string | null;
        }
        const out = strList.splice(0, count);
        if (strList.length === 0) this.kv.delete(key);
        return out;
      }
      case "SADD": {
        let s = this.alive(key);
        if (!(s instanceof Set)) s = new Set();
        let added = 0;
        for (const m of args.slice(1)) {
          if (s.size === 0 || !s.has(m)) added++;
          s.add(m);
        }
        this.kv.set(key, s);
        return added;
      }
      case "SMEMBERS": {
        const s = this.alive(key);
        return s instanceof Set ? Array.from(s) : [];
      }
      case "SREM": {
        const s = this.alive(key);
        if (!(s instanceof Set)) return 0;
        const removed = s.delete(args[1] ?? "");
        if (s.size === 0) this.kv.delete(key);
        return removed ? 1 : 0;
      }
      case "ZADD": {
        let z = this.alive(key) as ZEntry[] | undefined;
        if (!Array.isArray(z) || (z.length > 0 && typeof z[0] !== "object")) z = [];
        const score = Number(args[1]);
        const member = args[2] ?? "";
        z.push({ score, member });
        this.kv.set(key, z);
        return 1;
      }
      case "ZREMRANGEBYSCORE": {
        const z = this.alive(key) as ZEntry[] | undefined;
        if (!Array.isArray(z)) return 0;
        const min = String(args[1]).replace("(", "");
        const before = z.length;
        this.kv.set(key, z.filter((e) => e.score >= Number(min)));
        return before - (this.kv.get(key) as ZEntry[]).length;
      }
      case "ZCARD": {
        const z = this.alive(key) as ZEntry[] | undefined;
        return Array.isArray(z) ? z.length : 0;
      }
      case "KEYS": {
        const pattern = args[0] ?? "*";
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        const out: string[] = [];
        for (const k of this.kv.keys()) {
          if (this.alive(k) !== undefined && re.test(k)) out.push(k);
        }
        return out;
      }
      default:
        throw new Error(`MemoryRedis: unsupported command ${cmd}`);
    }
  }
}
