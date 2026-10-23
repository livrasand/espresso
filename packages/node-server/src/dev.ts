// Local development server: same router as the serverless entry point,
// on top of plain node:http, serving the web/ UI from the repo root.

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ctxFor } from "./http/ctx.js";
import { buildApp } from "./router.js";
import { logError } from "./log.js";

// src/dev.ts → packages/node-server → repo root one further up.
const webRoot = path.resolve(fileURLToPath(new URL("../../../web", import.meta.url)));

// Load .env from the package (godotenv equivalent; no-op when absent).
try {
  process.loadEnvFile();
} catch {
  /* no .env file — defaults apply */
}

const PORT = Number(process.env["PORT"] ?? 8333);
const app = buildApp({ staticDir: webRoot });

const server = http.createServer((req, res) => {
  void app
    .serve(ctxFor(req, res))
    .catch((e) => {
      logError(`handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end(JSON.stringify({ error: "internal server error" }));
    });
});

server.listen(PORT, () => {
  console.log(`[Espresso] dev server on http://localhost:${PORT}`);
  console.log(`[Espresso] serving web UI from ${webRoot}`);
});
