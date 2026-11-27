// Minimal HTTP plumbing: a normalized request/response context that works on
// both plain Node http (dev server) and Vercel's Node.js serverless runtime.

import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpCtx {
  method: string;
  path: string;
  /** Query string params, already decoded. */
  query: Record<string, string>;
  header(name: string): string | null;
  /** Request body: JSON object if parseable, otherwise the raw text. */
  body(): Promise<unknown>;
  /** Raw request body as Buffer (size-limited). */
  bodyBuffer(limit: number): Promise<Buffer | null>;
  json(status: number, value: unknown): void;
  raw(status: number, contentType: string, data: string | Buffer): void;
  setHeader(name: string, value: string): void;
  status(code: number, message?: string): void;
  /** Account number authenticated via X-ZKP-Token (set by the router's
   * session middleware; empty string when the request is anonymous). */
  identity: string;
  clientIp(): string;
  done(): boolean;
}

type RawHeaders = { [key: string]: string | string[] | undefined };

function HeaderAdapter_get(headers: RawHeaders): (name: string) => string | null {
  return (name) => {
    const v = headers[name.toLowerCase()];
    if (Array.isArray(v)) return v.join(",");
    return v ?? null;
  };
}

export function ctxFor(req: IncomingMessage, res: ServerResponse, preBody?: unknown): HttpCtx {
  const getHeader = HeaderAdapter_get(req.headers as RawHeaders);
  const url = new URL(req.url ?? "/", "http://localhost");
  let sent = false;
  let bodyCache: unknown = preBody;
  const mark = () => {
    sent = true;
  };
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: url.pathname.replace(/\/+$/, "") || "/",
    query: Object.fromEntries(url.searchParams),
    header: getHeader,
    identity: "",
    async body(): Promise<unknown> {
      if (bodyCache !== undefined) return bodyCache;
      // Vercel's Node.js runtime may pre-parse the body into req.body and
      // fully consume the stream, in which case _readBody would never fire
      // "end" and hang until the function times out. Prefer the pre-parsed
      // value when present.
      const pre = (req as unknown as { body?: unknown }).body;
      let buf: Buffer | null;
      if (pre !== undefined && pre !== null) {
        if (Buffer.isBuffer(pre)) buf = pre;
        else if (typeof pre === "string") buf = Buffer.from(pre, "utf8");
        else { bodyCache = pre; return pre; }
      } else {
        buf = await _readBody(req, 512 * 1024);
      }
      if (buf === null) return null;
      const text = buf.toString("utf8");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async bodyBuffer(limit): Promise<Buffer | null> {
      // Vercel's runtime pre-parses the body into req.body and fully
      // consumes the stream. Prefer that when present (mirrors body()).
      // Also check a few alternate properties some runtimes use for the raw body.
      const anyReq = req as unknown as { body?: unknown; rawBody?: unknown; __body?: unknown };
      for (const candidate of [anyReq.body, anyReq.rawBody, anyReq.__body]) {
        if (candidate === undefined || candidate === null) continue;
        if (Buffer.isBuffer(candidate)) {
          if (candidate.length > limit) return null;
          return candidate;
        }
        if (typeof candidate === "string") {
          // Could be utf8 text or base64; try base64 first if it looks like it.
          let b: Buffer;
          if (/^[A-Za-z0-9+/]+=*$/.test(candidate) && candidate.length % 4 === 0) {
            b = Buffer.from(candidate, "base64");
          } else {
            b = Buffer.from(candidate, "utf8");
          }
          if (b.length > limit) return null;
          return b;
        }
        // pre-parsed JSON object → serialize back to a buffer
        const b = Buffer.from(JSON.stringify(candidate), "utf8");
        if (b.length > limit) return null;
        return b;
      }
      const buf = await _readBody(req, limit);
      if (buf === null && Number(req.headers["content-length"] ?? "0") > limit) return null;
      return buf;
    },
    json(status, value) {
      if (sent) return;
      mark();
      if (res.getHeader("content-type") === undefined) res.setHeader("Content-Type", "application/json");
      res.statusCode = status;
      res.end(JSON.stringify(value));
    },
    raw(status, contentType, data) {
      if (sent) return;
      mark();
      res.setHeader("Content-Type", contentType);
      res.statusCode = status;
      res.end(data);
    },
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    status(code) {
      if (sent) return;
      mark();
      res.statusCode = code;
      res.end();
    },
    clientIp(): string {
      return clientIpOf(getHeader, url.hostname);
    },
    done(): boolean {
      return sent;
    },
  };
}

function clientIpOf(getHeader: (n: string) => string | null, fallback: string): string {
  // Vercel provides the client ip directly; trust it — Vercel is the edge TLS
  // terminator and strips forged client headers.
  const forwardedFor = getHeader("x-vercel-forwarded-for") ?? getHeader("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  return fallback || "0.0.0.0";
}

function _readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > limit) return Promise.resolve(null);

  // Vercel's Node runtime often buffers the request body internally and
  // exposes it neither via req.body nor as a flowing stream (readableEnded is
  // already true). Try a synchronous read() first to drain any buffered data.
  const chunks: Buffer[] = [];
  let size = 0;
  let chunk: Buffer | string | null = null;
  try {
    // eslint-disable-next-line no-cond-assign
    while ((chunk = req.read()) !== null) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += b.length;
      if (size > limit) return Promise.resolve(null);
      chunks.push(b);
    }
  } catch {
    /* fall through to event-based read */
  }
  if (chunks.length > 0) return Promise.resolve(Buffer.concat(chunks));

  // Fall back to event-based read with a safety timeout.
  return new Promise((resolve) => {
    const evChunks: Buffer[] = [];
    let evSize = 0;
    let resolved = false;
    const finish = (buf: Buffer | null) => {
      if (resolved) return;
      resolved = true;
      resolve(buf);
    };
    req.on("data", (c: Buffer) => {
      evSize += c.length;
      if (evSize > limit) {
        finish(null);
        req.pause();
        return;
      }
      evChunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(evChunks)));
    req.on("error", () => finish(null));
    req.on("close", () => finish(resolved ? null : Buffer.concat(evChunks)));
    setTimeout(() => finish(Buffer.concat(evChunks)), 5000);
  });
}
