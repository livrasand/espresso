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
      const buf = await _readBody(req, 512 * 1024);
      if (buf === null) return null;
      const text = buf.toString("utf8");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async bodyBuffer(limit): Promise<Buffer | null> {
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
  return new Promise((resolve) => {
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > limit) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let resolved = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!resolved) resolve(null);
        resolved = true;
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!resolved) resolve(Buffer.concat(chunks));
      resolved = true;
    });
    req.on("error", () => {
      if (!resolved) resolve(null);
      resolved = true;
    });
  });
}
