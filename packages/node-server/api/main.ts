// Vercel serverless entry point: static assets are served by the platform,
// every dynamic route is rewritten here (see vercel.json). One handler for
// /api/*, /node/*, /health and /metrics keeps the routing identical to dev.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ctxFor } from "../src/http/ctx.js";
import { buildApp } from "../src/router.js";
import { logError } from "../src/log.js";

// Module-level init: reused across warm lambda invocations (secrets,
// Redis client, router wiring).
const app = buildApp();

// Disable Vercel's automatic body parsing so binary git packs (and other raw
// payloads) reach the handler untouched.
export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.url && req.url.includes(".git/")) {
      const pre = (req as unknown as { body?: unknown }).body;
      console.error("[git-debug] url=", req.url, "method=", req.method, "content-type=", req.headers["content-type"], "content-length=", req.headers["content-length"], "body type=", typeof pre, "isBuffer=", Buffer.isBuffer(pre), "bodyLen=", Buffer.isBuffer(pre) ? (pre as Buffer).length : (typeof pre === "string" ? pre.length : "n/a"));
    }
    await app.serve(ctxFor(req, res));
  } catch (e) {
    logError(`handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal server error" }));
  }
}
