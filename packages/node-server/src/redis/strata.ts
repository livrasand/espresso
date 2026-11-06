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

export class StrataBackend implements RedisLike {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  // ── HTTP plumbing ─────────────────────────────────────────────────────

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

  private bodyOf(res: Response, statusText: string): Promise<string> {
    return res.text().then((t) => t.slice(0, 200));
  }

  /** Reads the envelope for a key; null when absent or already expired. */
  private async read(k: string): Promise<Pkg | null> {
    const res = await fetch(this.kvPath(k), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`strata GET ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    const body = (await res.json()) as { value?: unknown };
    if (body.value === undefined || body.value === null) return null;
    if (typeof body.value !== "string") body.value = JSON.stringify(body.value);
    let pkg: Pkg;
    try {
      pkg = JSON.parse(String(body.value));
    } catch {
      return null;
    }
    if (!pkg || typeof pkg !== "object" || !("t" in pkg) || !("v" in pkg)) return null;
    if (pkg.e !== null && typeof pkg.e === "number" && pkg.e <= Date.now()) return null;
    return pkg;
  }

  /** Writes an envelope, trimming the expiry if it already elapsed. */
  private async write(k: string, pkg: Pkg): Promise<void> {
    let exp = pkg.e;
    if (exp !== null) {
      const ttlSec = Math.ceil((exp - Date.now()) / 1000);
      if (ttlSec <= 0) {
        // Already expired — deleting is the equivalent write
        try {
          await fetch(this.kvPath(k), { method: "DELETE", headers: this.headers() });
        } catch {
          /* best effort cleanup */
        }
        return;
      }
    }
    const body: Record<string, unknown> = { value: JSON.stringify({ ...pkg, e: exp }) };
    if (exp !== null) body.ttl = Math.ceil((exp - Date.now()) / 1000);
    const res = await fetch(this.kvPath(k), {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`strata PUT ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }

  private async remove(k: string): Promise<void> {
    await fetch(this.kvPath(k), { method: "DELETE", headers: this.headers() });
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
        if (nx && (await this.read(k))) return 0;
        await this.write(k, { t: "s", e: exp, v: String(args[0] ?? "") });
        return "OK";
      }

      case "DEL": {
        const k = String(key);
        if (!(await this.read(k))) return 0;
        await this.remove(k);
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
        const pkg = await this.read(k);
        if (!pkg) return 0;
        const sec = Number(args[0]);
        await this.write(k, { ...pkg, e: Date.now() + sec * 1000 });
        return 1;
      }

      case "HSET": {
        const k = String(key);
        const existing = await this.read(k);
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
        const existing = await this.read(k);
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
        const pkg = await this.read(k);
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
        const existing = await this.read(k);
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
        const pkg = await this.read(k);
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
        const existing = await this.read(k);
        const z = (existing && existing.t === "z" ? existing.v : {}) as Record<string, number>;
        const isNew = !(member in z) || z[member] !== score;
        z[member] = score;
        await this.write(k, this.pkg("z", existing, z));
        return isNew ? 1 : 0;
      }

      case "ZREMRANGEBYSCORE": {
        const k = String(key);
        const pkg = await this.read(k);
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
        const res = await fetch(this.baseUrl.replace(/\/+$/, "") + "/keys", { headers: this.headers() });
        if (!res.ok) throw new Error(`strata KEYS ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
        const body = (await res.json()) as { keys?: string[] };
        const all = Array.isArray(body.keys) ? body.keys : [];
        const re = StrataBackend.globRe(String(key));
        return all.filter((k) => re.test(k));
      }

      default:
        throw new Error(`strata backend: unsupported command ${op}`);
    }
  }
}
