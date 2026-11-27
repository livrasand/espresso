import http from "node:http";
import { StrataBackend } from "../src/redis/strata.js";

const kv = new Map<string, { value: string; exp: number | null }>();

function server(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http
      .createServer((req, res) => {
        if (req.headers.authorization !== "Bearer test-token") {
          res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const url = new URL(req.url ?? "/", "http://x");
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          for (const [k, e] of kv) if (e.exp !== null && e.exp <= Date.now()) kv.delete(k);

          if (url.pathname === "/keys") {
            res.writeHead(200).end(JSON.stringify({ keys: [...kv.keys()] }));
            return;
          }
          const m = (url.pathname ?? "").match(/^\/kv\/(.+)$/);
          if (!m) {
            res.writeHead(404).end();
            return;
          }
          const key = decodeURIComponent(m[1] as string);
          if (req.method === "PUT") {
            const body = JSON.parse(data) as { value: string; ttl?: number };
            kv.set(key, { value: body.value, exp: body.ttl ? Date.now() + body.ttl * 1000 : null });
            res.writeHead(200).end(JSON.stringify({ ok: true, key }));
          } else if (req.method === "GET") {
            const e = kv.get(key);
            if (!e) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200).end(JSON.stringify({ key, value: e.value }));
          } else if (req.method === "DELETE") {
            kv.delete(key);
            res.writeHead(200).end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(405).end();
          }
        });
      })
      .listen(0, () => {
        const addr = srv.address() as { port: number };
        resolve(addr.port);
      });
  });
}

void (async () => {
  const port = await server();
  const backend = new StrataBackend(`http://127.0.0.1:${port}`, "test-token");

  const r: unknown[] = [];
  r.push(await backend.exec(["SET", "str", "hello"]));
  r.push(await backend.exec(["GET", "str"]));
  r.push(await backend.exec(["SET", "nx", "v", "NX"]));
  r.push(await backend.exec(["SET", "nx", "v2", "NX"]));
  r.push(await backend.exec(["EXISTS", "nx"]));
  r.push(await backend.exec(["SET", "ttl", "v", "EX", 10]));
  r.push(await backend.exec(["TTL", "ttl"]));

  r.push(await backend.exec(["HSET", "h", "f1", "a"]));
  r.push(await backend.exec(["HSET", "h", "f2", "b"]));
  r.push(await backend.exec(["HGET", "h", "f1"]));
  r.push(await backend.exec(["HGETALL", "h"]));

  r.push(await backend.exec(["RPUSH", "l", "x", "y"]));
  r.push(await backend.exec(["RPUSH", "l", "z"]));
  r.push(await backend.exec(["LPOP", "l", 2]));
  r.push(await backend.exec(["LPOP", "l", 2]));

  r.push(await backend.exec(["SADD", "s", "a", "b", "a"]));
  r.push(await backend.exec(["SMEMBERS", "s"]));
  r.push(await backend.exec(["SREM", "s", "a"]));
  r.push(await backend.exec(["SMEMBERS", "s"]));

  r.push(await backend.exec(["ZADD", "z", 100, "m1"]));
  r.push(await backend.exec(["ZADD", "z", 200, "m2"]));
  r.push(await backend.exec(["ZADD", "z", 150, "m1"]));
  r.push(await backend.exec(["ZCARD", "z"]));
  r.push(await backend.exec(["ZREMRANGEBYSCORE", "z", "(0", "(150"]));
  r.push(await backend.exec(["ZCARD", "z"]));

  r.push(await backend.exec(["EXPIRE", "s", 5]));
  r.push(await backend.exec(["TTL", "s"]));
  r.push(await backend.exec(["KEYS", "s*"]));
  r.push(await backend.exec(["DEL", "s"]));
  r.push(await backend.exec(["EXISTS", "s"]));

  console.log(JSON.stringify(r));
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAIL:", e);
  process.exit(1);
});
