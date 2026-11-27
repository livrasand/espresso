import type { IncomingMessage, ServerResponse } from "node:http";
import { ctxFor } from "../src/http/ctx.js";
import { buildApp } from "../src/router.js";
import { logError } from "../src/log.js";

const app = buildApp();

export const config = { maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await app.serve(ctxFor(req, res));
  } catch (e) {
    logError(`handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal server error" }));
  }
}
