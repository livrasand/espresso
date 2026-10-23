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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await app.serve(ctxFor(req, res));
  } catch (e) {
    logError(`handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal server error" }));
  }
}
