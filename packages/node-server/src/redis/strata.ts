// Strata (git-backed KV, github.com/livrasand/Strata) as a backend for the
// Redis command layer. Strata only exposes a flat REST KV — GET/PUT/DELETE
// /kv/:key, GET /keys, Bearer auth — so the Redis surface Espresso needs is
// emulated on top of it:
//
//   string  → stored verbatim inside the value envelope
//   hash    → object  field → string
//   list    → array   of strings
//   set     → array   of strings (deduped)
//   zset    → object  member → score
//
// Every value is wrapped in an envelope {t, e, v} (type, expiry-ms, payload)
// so TTL semantics (EXPIRE / TTL / expired EXISTS) survive round-trips even
// though Strata never says how long a key has left. The envelope's expiry
// also becomes Strata's native `ttl` on PUT so the server self-expires the
// entry commit-side too. Payloads are serialized as JSON strings before PUT
// so storage never has to round-trip non-string values.
//
// Trade-off accepted by design: Redis structures become read-modify-write
// JSON ops, so concurrent HSET/RPUSH/LPOP on the same key race to
// last-write-wins. Strata itself guarantees no lost writes on the commit it
// receives; the race window is the same kind a multi-instance serverless
// deployment already tolerates.

import type { RedisLike, RedisReply } from "./index.js";

type Pkg = { t: "s" | "h" | "l" | "se" | "z"; e: number | null; v: unknown };

/**
 * Keys whose staleness is harmless (node records, node telemetry, account
 * membership, profile lookups). Everything else — liveness, inboxes, RPC
 * responses, pairing codes, rate limits — is always read fresh because other
 * serverless instances write to them.
 */
const CACHEABLE_PREFIXES = ["node:", "ninfo:", "profile:", "names:"];
const READ_CACHE_TTL_MS = 3000;
const KEYS_CACHE_TTL_MS = 5000;

export class StrataBackend implements RedisLike {
  private readonly cache = new Map<string, { raw: string | null; at: number }>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private keysCache: { keys: string[]; at: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10000,
  ) {}

  // ── HTTP plumbing ─────────────────────────────────────────────────────

  /**
   * fetch with a hard per-request timeout. Without this, a hung upstream
   * (Strata waiting on its git host) stalls the lambda until the platform
   * maxDuration kills it — observed as `FUNCTION_INVOCATION_TIMEOUT` after
   * 60 s on POST /api/accounts.
   */
  private async http(url: string, init: RequestInit = {}): Promise<Response> {
    // Disable keep-alive: Vercel's Node serverless runtime waits for the event
    // loop to drain before finalising an invocation, and pooled sockets would
    // otherwise keep the lambda alive until maxDuration (observed as 60s
    // timeouts on /node/pair and /api/nodes/pair).
    const headers = { ...(init.headers as Record<string, string> | undefined), Connection: "close" };
    return fetch(url, {
      ...init,
      headers,
      keepalive: false,
      signal: AbortSignal.timeout(this.timeoutMs),
    } as RequestInit);
  }

  /**
   * GET with one retry: Strata revalidates its state against its git host on
   * every read, so transient upstream hiccups are common. Writes are NOT
   * retried — an ambiguous failure (timeout after the commit landed) must not
   * duplicate a journal op; the caller surfaces the error instead.
   */
  private async httpGet(url: string): Promise<Response> {
    const init = { headers: this.headers() };
    try {
      return await this.http(url, init);
    } catch (e) {
      const name = String((e as { name?: string })?.name);
      if (name !== "TimeoutError" && name !== "AbortError") throw e;
      return this.http(url, init);
    }
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private pathKey(k: string): string {
    // ":" is legal and unambiguous in a URL path and Strata keys rely on it
    // (e.g. "session:9f2c"), so keep it unencoded while escaping slashes
    // and other path-hostile characters.
    return encodeURIComponent(k).replace(/%3A/g, ":");
  }

  private kvPath(k: string): string {
    return this.baseUrl.replace(/\/+$/, "") + `/kv/${this.pathKey(k)}`;
  }

  private static cacheable(k: string): boolean {
    return CACHEABLE_PREFIXES.some((p) => k.startsWith(p));
  }

  /** Raw GET of the stored value string (null when absent). Concurrent reads
   * of the same key share one HTTP request. */
  private fetchRaw(k: string): Promise<string | null> {
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = (async () => {
      const res = await this.httpGet(this.kvPath(k));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`strata GET ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
      const body = (await res.json()) as { value?: unknown };
      if (body.value === undefined || body.value === null) return null;
      return typeof body.value === "string" ? body.value : JSON.stringify(body.value);
    })().finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  /**
   * Reads the envelope for a key; null when absent or already expired.
   * `fresh` bypasses the short-lived cache — required before any
   * read-modify-write so concurrent updates are not clobbered with stale data.
   */
  private async read(k: string, fresh = false): Promise<Pkg | null> {
    let raw: string | null;
    const useCache = !fresh && StrataBackend.cacheable(k);
    const hit = useCache ? this.cache.get(k) : undefined;
    if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) {
      raw = hit.raw;
    } else {
      raw = await this.fetchRaw(k);
      if (StrataBackend.cacheable(k)) this.cache.set(k, { raw, at: Date.now() });
    }
    if (raw === null) return null;
    let pkg: Pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!pkg || typeof pkg !== "object" || !("t" in pkg) || !("v" in pkg)) return null;
    if (pkg.e !== null && typeof pkg.e === "number" && pkg.e <= Date.now()) return null;
    return pkg;
  }

  private invalidate(k: string): void {
    this.cache.delete(k);
    this.keysCache = null;
  }

  /** Writes an envelope, trimming the expiry if it already elapsed. */
  private async write(k: string, pkg: Pkg): Promise<void> {
    const exp = pkg.e;
    this.invalidate(k);
    if (exp !== null) {
      const ttlSec = Math.ceil((exp - Date.now()) / 1000);
      if (ttlSec <= 0) {
        // Already expired — deleting is the equivalent write
        try {
          await this.http(this.kvPath(k), { method: "DELETE", headers: this.headers() });
        } catch {
          /* best effort cleanup */
        }
        return;
      }
    }
    const serialized = JSON.stringify(pkg);
    const body: Record<string, unknown> = { value: serialized };
    if (exp !== null) body.ttl = Math.ceil((exp - Date.now()) / 1000);
    const res = await this.http(this.kvPath(k), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`strata PUT ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    // Write-through so this instance sees its own write immediately.
    if (StrataBackend.cacheable(k)) this.cache.set(k, { raw: serialized, at: Date.now() });
  }

  private async remove(k: string): Promise<void> {
    this.invalidate(k);
    await this.http(this.kvPath(k), { method: "DELETE", headers: this.headers() });
  }

  private static empty(typ: Pkg["t"]): unknown {
    if (typ === "h" || typ === "z") return {};
    return [];
  }

  /** New package of `typ`, preserving an existing envelope's expiry. */
  private pkg(typ: Pkg["t"], existing: Pkg | null, v: unknown): Pkg {
    return { t: typ, e: existing && existing.e !== null ? existing.e : null, v };
  }

  private static globRe(pattern: string): RegExp {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^" + esc.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  }

  /** Parses a Redis range bound: number, "(n" (exclusive), "-inf", "+inf". */
  private static bound(raw: unknown): { v: number; exclusive: boolean } {
    const s = String(raw);
    if (s.startsWith("(")) return { v: Number(s.slice(1)), exclusive: true };
    if (s === "-inf") return { v: -Infinity, exclusive: false };
    if (s === "+inf" || s === "inf") return { v: Infinity, exclusive: false };
    return { v: Number(s), exclusive: false };
  }

  // ── Redis command interpreter ────────────────────────────────────────

  async exec(command: (string | number)[]): Promise<RedisReply> {
    const [opRaw, key, ...args] = command;
    const op = String(opRaw).toUpperCase();

    switch (op) {
      case "GET": {
        const pkg = await this.read(String(key));
        return pkg && pkg.t === "s" ? String(pkg.v) : null;
      }

      case "SET": {
        // ["SET", key, value, ...opts] — args[0] is always the value.
        const k = String(key);
        let nx = false;
        let exSec: number | null = null;
        for (let i = 1; i < args.length; i++) {
          const o = String(args[i]).toUpperCase();
          if (o === "NX") nx = true;
          else if (o === "EX") exSec = Number(args[++i]);
        }
        const exp =
          exSec !== null && Number.isFinite(exSec) && exSec > 0 ? Date.now() + exSec * 1000 : null;
        if (nx && (await this.read(k, true))) return 0;
        await this.write(k, { t: "s", e: exp, v: String(args[0] ?? "") });
        return "OK";
      }

      case "DEL": {
        const k = String(key);
        this.invalidate(k);
        const res = await this.http(this.kvPath(k), { method: "DELETE", headers: this.headers() });
        if (res.status === 404) return 0;
        if (!res.ok) throw new Error(`strata DELETE ${res.status}`);
        return 1;
      }

      case "EXISTS":
        return (await this.read(String(key))) ? 1 : 0;

      case "TTL": {
        const pkg = await this.read(String(key));
        if (!pkg) return -2;
        if (pkg.e === null) return -1;
        return Math.ceil((pkg.e - Date.now()) / 1000);
      }

      case "EXPIRE": {
        const k = String(key);
        const pkg = await this.read(k, true);
        if (!pkg) return 0;
        const sec = Number(args[0]);
        await this.write(k, { ...pkg, e: Date.now() + sec * 1000 });
        return 1;
      }

      case "HMSET": {
        const k = String(key);
        const existing = await this.read(k, true);
        const obj = (existing && existing.t === "h" ? existing.v : {}) as Record<string, string>;
        let added = 0;
        for (let i = 0; i + 1 < args.length; i += 2) {
          const field = String(args[i]);
          const value = String(args[i + 1] ?? "");
          if (!(field in obj)) added++;
          obj[field] = value;
        }
        await this.write(k, this.pkg("h", existing, obj));
        return added || Object.keys(obj).length;
      }

      case "HMSETEX": {
        // ["HMSETEX", key, ttlSec, field, value, ...] — HMSET + EXPIRE in one
        // read-modify-write (the expiry used to cost a second round trip).
        const k = String(key);
        const ttl = Number(args[0]);
        const existing = await this.read(k, true);
        const obj = (existing && existing.t === "h" ? existing.v : {}) as Record<string, string>;
        for (let i = 1; i + 1 < args.length; i += 2) obj[String(args[i])] = String(args[i + 1] ?? "");
        const e = Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : (existing?.e ?? null);
        await this.write(k, { t: "h", e, v: obj });
        return 1;
      }

      case "ZWINDOW": {
        // ["ZWINDOW", key, nowMs, member, windowMs] — sliding-window hit:
        // prune old entries, add this one, return the count. One read + one
        // write instead of ZADD+ZREMRANGEBYSCORE+EXPIRE+ZCARD (7 requests).
        const k = String(key);
        const now = Number(args[0]);
        const member = String(args[1]);
        const windowMs = Number(args[2]);
        const existing = await this.read(k, true);
        const z = (existing && existing.t === "z" ? existing.v : {}) as Record<string, number>;
        const kept: Record<string, number> = {};
        for (const [m, sc] of Object.entries(z)) if (sc >= now - windowMs) kept[m] = sc;
        kept[member] = now;
        await this.write(k, { t: "z", e: now + windowMs + 1000, v: kept });
        return Object.keys(kept).length;
      }

      case "HSET": {
        const k = String(key);
        const existing = await this.read(k, true);
        const obj = (existing && existing.t === "h" ? existing.v : {}) as Record<string, string>;
        const field = String(args[0]);
        obj[field] = String(args[1] ?? "");
        await this.write(k, this.pkg("h", existing, obj));
        return 1;
      }

      case "HGET": {
        const pkg = await this.read(String(key));
        if (!pkg || pkg.t !== "h") return null;
        return ((pkg.v as Record<string, string>)[String(args[0])]) ?? null;
      }

      case "HGETALL": {
        const pkg = await this.read(String(key));
        if (!pkg || pkg.t !== "h") return [];
        const out: string[] = [];
        for (const [f, v] of Object.entries(pkg.v as Record<string, string>)) out.push(f, String(v));
        return out;
      }

      case "RPUSH": {
        const k = String(key);
        const vals = args.map((a) => String(a));
        if (vals.length === 0) return 0;
        const existing = await this.read(k, true);
        const list =
          existing && (existing.t === "l" || existing.t === "se")
            ? (existing.v as string[])
            : ([] as string[]);
        list.push(...vals);
        await this.write(k, this.pkg("l", existing, list));
        return list.length;
      }

      case "LPOP": {
        // ["LPOP", key, count] → array, ["LPOP", key] → single item / null
        const k = String(key);
        const pkg = await this.read(k, true);
        if (!pkg || !Array.isArray(pkg.v) || (pkg.v as string[]).length === 0) {
          return args.length > 0 ? [] : null;
        }
        const list = pkg.v as string[];
        const count = args.length > 0 ? Number(args[0]) : 1;
        const popped = list.slice(0, Math.max(1, count));
        const rest = list.slice(popped.length);
        if (rest.length === 0) await this.remove(k);
        else await this.write(k, { t: "l", e: pkg.e, v: rest });
        return args.length > 0 ? popped : popped[0] ?? null;
      }

      case "SADD": {
        const k = String(key);
        if (args.length === 0) return 0;
        const existing = await this.read(k, true);
        const set = new Set<string>(
          existing && (existing.t === "se" || existing.t === "l") ? (existing.v as string[]) : [],
        );
        let added = 0;
        for (const a of args) {
          const m = String(a);
          if (!set.has(m)) {
            set.add(m);
            added++;
          }
        }
        await this.write(k, this.pkg("se", existing, [...set]));
        return added;
      }

      case "SMEMBERS": {
        const pkg = await this.read(String(key));
        if (!pkg || !Array.isArray(pkg.v)) return [];
        return (pkg.v as string[]).slice();
      }

      case "SREM": {
        const k = String(key);
        const members = new Set(args.map((a) => String(a)));
        const pkg = await this.read(k, true);
        if (!pkg || !Array.isArray(pkg.v)) return 0;
        const list = pkg.v as string[];
        const kept = list.filter((m) => !members.has(m));
        if (kept.length === list.length) return 0;
        if (kept.length === 0) await this.remove(k);
        else await this.write(k, { t: "se", e: pkg.e, v: kept });
        return list.length - kept.length;
      }

      case "ZADD": {
        const k = String(key);
        const score = Number(args[0]);
        const member = String(args[1] ?? "");
        const existing = await this.read(k, true);
        const z = (existing && existing.t === "z" ? existing.v : {}) as Record<string, number>;
        const isNew = !(member in z) || z[member] !== score;
        z[member] = score;
        await this.write(k, this.pkg("z", existing, z));
        return isNew ? 1 : 0;
      }

      case "ZREMRANGEBYSCORE": {
        const k = String(key);
        const pkg = await this.read(k, true);
        if (!pkg || pkg.t !== "z") return 0;
        const z = pkg.v as Record<string, number>;
        const min = StrataBackend.bound(args[0]);
        const max = StrataBackend.bound(args[1]);
        const kept: Record<string, number> = {};
        let removed = 0;
        for (const [member, score] of Object.entries(z)) {
          const aboveMin = min.v === -Infinity || (min.exclusive ? score > min.v : score >= min.v);
          const belowMax = max.v === Infinity || (max.exclusive ? score < max.v : score <= max.v);
          if (aboveMin && belowMax) removed++;
          else kept[member] = score;
        }
        if (removed === 0) return 0;
        if (Object.keys(kept).length === 0) await this.remove(k);
        else await this.write(k, { t: "z", e: pkg.e, v: kept });
        return removed;
      }

      case "ZCARD": {
        const pkg = await this.read(String(key));
        if (!pkg || pkg.t !== "z") return 0;
        return Object.keys(pkg.v as Record<string, number>).length;
      }

      case "KEYS": {
        let all: string[];
        if (this.keysCache && Date.now() - this.keysCache.at < KEYS_CACHE_TTL_MS) {
          all = this.keysCache.keys;
        } else {
          const res = await this.httpGet(this.baseUrl.replace(/\/+$/, "") + "/keys");
          if (!res.ok) throw new Error(`strata KEYS ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
          const body = (await res.json()) as { keys?: string[] };
          all = Array.isArray(body.keys) ? body.keys : [];
          this.keysCache = { keys: all, at: Date.now() };
        }
        const re = StrataBackend.globRe(String(key));
        return all.filter((k) => re.test(k));
      }

      default:
        throw new Error(`strata backend: unsupported command ${op}`);
    }
  }
}
