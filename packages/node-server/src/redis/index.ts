// Redis-compatible data store layer. On Vercel: Upstash Redis REST.
// Locally (no UPSTASH_* env): an in-memory fallback so `npm run dev`
// works out of the box without external services.

export type RedisReply = string | string[] | number | null | Record<string, unknown>;

export interface RedisLike {
  exec(command: (string | number)[]): Promise<RedisReply>;
}

// ── Convenience wrappers ─────────────────────────────────────────────

export class Redis {
  constructor(private readonly backend: RedisLike) {}

  exec(command: (string | number)[]): Promise<RedisReply> {
    return this.backend.exec(command.map((c) => (typeof c === "number" ? Math.floor(c) : c)));
  }

  get(key: string): Promise<string | null> {
    return this.exec(["GET", key]) as Promise<string | null>;
  }
  set(key: string, value: string, ...opts: (string | number)[]): Promise<string | null> {
    return this.exec(["SET", key, value, ...opts]) as Promise<string | null>;
  }
  setNx(key: string, value: string, ttlSec?: number): Promise<number> {
    return this.exec(ttlSec !== undefined ? ["SET", key, value, "NX", "EX", ttlSec] : ["SET", key, value, "NX"]).then((r) =>
      typeof r === "number" ? r : r === "OK" ? 1 : 0,
    );
  }
  del(key: string): Promise<number> {
    return this.exec(["DEL", key]).then((r) => (typeof r === "number" ? r : 0));
  }
  exists(key: string): Promise<boolean> {
    return this.exec(["EXISTS", key]).then((r) => (typeof r === "number" ? r === 1 : false));
  }
  ttl(key: string): Promise<number> {
    return this.exec(["TTL", key]).then((r) => (typeof r === "number" ? r : -2));
  }
  hset(key: string, field: string, value: string): Promise<number> {
    return this.exec(["HSET", key, field, value]).then((r) => (typeof r === "number" ? r : 0));
  }
  hget(key: string, field: string): Promise<string | null> {
    return this.exec(["HGET", key, field]) as Promise<string | null>;
  }
  hgetall(key: string): Promise<Record<string, string>> {
    return this.exec(["HGETALL", key]).then((r) => {
      if (!Array.isArray(r)) return {};
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < r.length; i += 2) {
        const k = r[i];
        const v = r[i + 1];
        if (k !== undefined && v !== undefined) out[k] = String(v);
      }
      return out;
    });
  }
  rpush(key: string, ...values: string[]): Promise<number> {
    return this.exec(["RPUSH", key, ...values]).then((r) => (typeof r === "number" ? r : 0));
  }
  /** Removes up to `count` items and returns them. */
  lpopAll(key: string, count: number): Promise<string[]> {
    return this.exec(["LPOP", key, count]).then((r) => {
      if (r === null) return [];
      if (Array.isArray(r)) return r.filter((x): x is string => typeof x === "string");
      return [String(r)];
    });
  }
  sadd(key: string, ...members: string[]): Promise<number> {
    return this.exec(["SADD", key, ...members]).then((r) => (typeof r === "number" ? r : 0));
  }
  smembers(key: string): Promise<string[]> {
    return this.exec(["SMEMBERS", key]).then((r) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []));
  }
  srem(key: string, member: string): Promise<number> {
    return this.exec(["SREM", key, member]).then((r) => (typeof r === "number" ? r : 0));
  }
  zadd(key: string, scoreMs: number, member: string): Promise<number> {
    return this.exec(["ZADD", key, scoreMs, member]).then((r) => (typeof r === "number" ? r : 0));
  }
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    return this.exec(["ZREMRANGEBYSCORE", key, min, max]).then((r) => (typeof r === "number" ? r : 0));
  }
  zcard(key: string): Promise<number> {
    return this.exec(["ZCARD", key]).then((r) => (typeof r === "number" ? r : 0));
  }
  expire(key: string, ttlSec: number): Promise<boolean> {
    return this.exec(["EXPIRE", key, ttlSec]).then((r) => (typeof r === "number" ? r === 1 : false));
  }
  keys(pattern: string): Promise<string[]> {
    return this.exec(["KEYS", pattern]).then((r) => (Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []));
  }
}

import { UpstashBackend } from "./upstash.js";
import { MemoryRedis } from "./memory.js";

function backendFor(env: { redis: { url: string | null; token: string | null } } & { logFormat?: string }, warn: (m: string) => void): RedisLike {
  if (env.redis.url && env.redis.token) {
    return new UpstashBackend(env.redis.url, env.redis.token);
  }
  warn("UPSTASH_REDIS_REST_URL/TOKEN unset — using in-memory store (local dev only, data is volatile)");
  return new MemoryRedis();
}

export function redis(c: { redis: { url: string | null; token: string | null } }, warn: (m: string) => void): Redis {
  return new Redis(backendFor(c, warn));
}
