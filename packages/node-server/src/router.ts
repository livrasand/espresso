// HTTP router core (port of internal/http/router.go): one dispatcher for the
// node ingest protocol (v2), the node management API, the repo browsing API,
// the account endpoints, and health/metrics. Works identically under the
// Vercel serverless runtime (api/main.ts) and the local dev server (src/dev.ts).

import type { HttpCtx } from "./http/ctx.js";
import { config as loadConfig, type Config } from "./env.js";
import { initLogger, log, logError } from "./log.js";
import { redis } from "./redis/index.js";
import type { Redis } from "./redis/index.js";
import { AccountStore } from "./accounts/store.js";
import { makeAccountHandlers, accountsSecurity } from "./accounts/handlers.js";
import { ProfileStore } from "./profiles/store.js";
import { makeProfileHandlers } from "./profiles/handlers.js";
import { NodeRegistry } from "./nodes/registry.js";
import { makeIngestHandlers } from "./nodes/ingest.js";
import { makeApiHandlers, makeGGHandlers } from "./nodes/api.js";
import { makeRpc } from "./nodes/rpc.js";
import { makeGitHttpHandlers } from "./git/http.js";
import { applySecurityHeaders, applyLocalhostCORS, apiKeyOk } from "./http/security.js";
import { validateSessionToken } from "./auth/session.js";
import { consumeRateLimit } from "./auth/ratelimit.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const startTime = new Date();

export interface AppOptions {
  /** Dev-only: serve static web assets from this directory. On Vercel
   * static hosting is handled by the platform, so leave it unset. */
  staticDir?: string;
}

export interface App {
  cfg: Config;
  redis: Redis;
  registry: NodeRegistry;
  serve(ctx: HttpCtx): Promise<void>;
}

/* ── wiring ────────────────────────────────────────────────────────── */

let warnedSecret = false;

function loadBootstrap(): Config {
  const cfg = loadConfig();
  initLogger(cfg);
  if (!process.env["SESSION_SECRET"] && !warnedSecret) {
    warnedSecret = true;
    logError("SESSION_SECRET unset — session tokens only survive within one instance (local dev mode)");
  }
  return cfg;
}

export function buildApp(options: AppOptions = {}): App {
  const cfg = loadBootstrap();

  const rds = redis(cfg, (m) => logError(m));
  const registry = new NodeRegistry(rds, cfg.nodeOnlineTtlSec);
  const callNode = makeRpc(registry, { rpcTimeoutMs: cfg.rpcTimeoutMs, maxWaitMs: 60_000 });
  const accounts = new AccountStore(rds);
  const profiles = new ProfileStore(rds);

  const deps: RouteDeps = {
    rds,
    registry,
    accountH: makeAccountHandlers(accounts, cfg),
    profileH: makeProfileHandlers(profiles, registry),
    ingestH: makeIngestHandlers(registry),
  apiH: makeApiHandlers({ registry, callNode }),
  ggH: makeGGHandlers({ registry, callNode }),
  gitH: makeGitHttpHandlers({ registry, callNode }),
  staticServer: options.staticDir ? makeStaticServer(options.staticDir) : null,
  };

  return {
    cfg,
    redis: rds,
    registry,
    serve: (ctx) => dispatch(ctx, cfg, deps),
  };
}

interface RouteDeps {
  rds: Redis;
  registry: NodeRegistry;
  accountH: ReturnType<typeof makeAccountHandlers>;
  profileH: ReturnType<typeof makeProfileHandlers>;
  ingestH: ReturnType<typeof makeIngestHandlers>;
  apiH: ReturnType<typeof makeApiHandlers>;
  ggH: ReturnType<typeof makeGGHandlers>;
  gitH: ReturnType<typeof makeGitHttpHandlers>;
  staticServer: StaticServer | null;
}

/* ── middleware helpers ────────────────────────────────────────────── */

/** Port of sessionAuthMiddlewareOptional: sets ctx.identity from a valid
 * X-ZKP-Token header; never aborts. */
function applyOptionalSession(ctx: HttpCtx, cfg: Config): void {
  const token = ctx.header("x-zkp-token") ?? "";
  if (token !== "") {
    const identity = validateSessionToken(token, cfg.secret);
    if (identity !== null) ctx.identity = identity;
  }
}

/** Port of sessionAuthMiddleware: requires a valid session token. */
function requireSession(ctx: HttpCtx, cfg: Config): boolean {
  const token = ctx.header("x-zkp-token") ?? "";
  if (token === "") {
    ctx.json(401, { error: "session token required" });
    return false;
  }
  const identity = validateSessionToken(token, cfg.secret);
  if (identity === null) {
    ctx.json(401, { error: "invalid or expired session token" });
    return false;
  }
  ctx.identity = identity;
  return true;
}

/** Port of anonymousAuthMiddleware as a callable: when a key is configured it
 * must match the X-Espresso-Key header; when unset, trusted-network mode. */
function requireApiKey(ctx: HttpCtx, cfg: Config): boolean {
  if (apiKeyOk(ctx, cfg.apiKey)) return true;
  ctx.json(401, { error: "invalid API key" });
  return false;
}

async function accountRateLimitOk(ctx: HttpCtx, rds: Redis): Promise<boolean> {
  const verdict = await consumeRateLimit(rds, {
    keyPrefix: "account",
    max: 30,
    windowMs: 60_000,
    id: ctx.clientIp(),
  });
  if (verdict === "allow") return true;
  ctx.json(429, { error: "account rate limit exceeded" });
  return false;
}

/* ── dispatch ──────────────────────────────────────────────────────── */

async function dispatch(ctx: HttpCtx, cfg: Config, deps: RouteDeps): Promise<void> {
  applySecurityHeaders(ctx);
  applyLocalhostCORS(ctx);
  if (ctx.done()) return; // CORS preflight short-circuit

  const method = ctx.method;
  const path = ctx.path;

  if (path === "/health" && method === "GET") return health(deps, ctx, cfg);
  if (path === "/metrics" && method === "GET") return metrics(ctx);

  // Node Protocol v2: nodes initiate (outbound), no open ports, no WS.
  if (path === "/node/pair") return method === "POST" ? deps.ingestH.pair(ctx) : notFound(ctx, path);
  if (path === "/node/poll") return method === "POST" ? deps.ingestH.poll(ctx) : notFound(ctx, path);
  if (path === "/node/respond") return method === "POST" ? deps.ingestH.respond(ctx) : notFound(ctx, path);

  // Account numbers: mint / login / backup (Mullvad-style, shared limiter).
  if (path === "/api/accounts" || path === "/api/accounts/login") {
    if (method !== "POST") return notFound(ctx, path);
    accountsSecurity(ctx);
    if (!(await accountRateLimitOk(ctx, deps.rds))) return;
    if (path === "/api/accounts") return deps.accountH.register(ctx);
    return deps.accountH.login(ctx);
  }
  if (path === "/api/accounts/backup") {
    if (method !== "POST") return notFound(ctx, path);
    accountsSecurity(ctx);
    if (!requireSession(ctx, cfg)) return;
    return deps.accountH.backup(ctx, ctx.identity);
  }

  // Profiles: the identity layered on an account number. Own profile needs a
  // session; public profiles are open lookups by username.
  if (path === "/api/profile") {
    if (!requireSession(ctx, cfg)) return;
    if (method === "GET") return deps.profileH.getOwn(ctx, ctx.identity);
    if (method === "PUT") return deps.profileH.putOwn(ctx, ctx.identity);
    return notFound(ctx, path);
  }
  // /api/nodes — listing (GET) allows anonymous in trusted-network mode;
  // operations require a session after the API-key gate.
  if (path === "/api/nodes") {
    if (method !== "GET" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    applyOptionalSession(ctx, cfg);
    return deps.apiH.list(ctx);
  }
  if (path === "/api/nodes/pair") {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.pair(ctx);
  }

  let m: RegExpMatchArray | null = null;
  const match = (re: RegExp): boolean => {
    m = path.match(re);
    return m !== null;
  };

  if (match(/^\/api\/profiles\/([^/]+)\/activity$/)) {
    if (method !== "GET") return notFound(ctx, path);
    return deps.profileH.activity(ctx, m![1]!);
  }
  if (match(/^\/api\/profiles\/([^/]+)$/)) {
    if (method !== "GET") return notFound(ctx, path);
    return deps.profileH.getPublic(ctx, m![1]!);
  }

  if (match(/^\/api\/nodes\/([^/]+)\/repos$/)) {
    if (!requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    if (method === "GET") return deps.apiH.repos(ctx, m![1]!);
    if (method === "POST") return deps.apiH.reposCreateFull(ctx, m![1]!);
    return notFound(ctx, path);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/refs\/([^/]+)$/)) {
    if (method !== "GET" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.refs(ctx, m![1]!, m![2]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/repo\/create$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.repoCreate(ctx, m![1]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/repo\/delete$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.repoDelete(ctx, m![1]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/fs\/read$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.fsRead(ctx, m![1]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/fs\/write$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.fsWrite(ctx, m![1]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/fs\/list$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.fsList(ctx, m![1]!);
  }
  if (match(/^\/api\/nodes\/([^/]+)\/cmd\/ping$/)) {
    if (method !== "POST" || !requireApiKey(ctx, cfg)) return notFound(ctx, path);
    if (!requireSession(ctx, cfg)) return;
    return deps.apiH.cmd(ctx, m![1]!);
  }

  // /api/gg — repo browsing through the paired nodes (optional session;
  // anonymous browsing works in trusted-network mode). Handlers
  // decodeURIComponent their own path params.
  if (match(/^\/api\/gg\/repos\/([^/]+)\/([^/]+)\/(tree|raw|info|branches|tags|commits)$/)) {
    applyOptionalSession(ctx, cfg);
    const handlerName = m![3] as "tree" | "raw" | "info" | "branches" | "tags" | "commits";
    return deps.ggH[handlerName](ctx, m![1]!, m![2]!);
  }
  // Short alias: /:owner/:repo/:action
  if (match(/^\/([^/]+)\/([^/]+)\/(tree|raw|info|branches|tags|commits)$/)) {
    applyOptionalSession(ctx, cfg);
    const handlerName = m![3] as "tree" | "raw" | "info" | "branches" | "tags" | "commits";
    return deps.ggH[handlerName](ctx, m![1]!, m![2]!);
  }

  // Git smart HTTP (step 1: routing; handlers are stubs for now).
  if (match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/)) {
    return deps.gitH.infoRefs(ctx);
  }
  if (match(/^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/)) {
    return deps.gitH.uploadPack(ctx);
  }
  if (match(/^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/)) {
    return deps.gitH.receivePack(ctx);
  }

  // Static web assets (dev server only; Vercel serves them from the project root).
  if (deps.staticServer !== null && deps.staticServer(ctx, path)) return;

  // Port of the NoRoute handler: unknown API paths must fail with JSON so
  // the frontend never parses HTML as JSON.
  notFound(ctx, path);
}

function notFound(ctx: HttpCtx, path: string): void {
  if (path.startsWith("/api/")) {
    ctx.json(404, { error: "unknown API endpoint" });
    return;
  }
  ctx.json(404, { error: "not found" });
}

/* ── health / metrics (port of helpers.go) ─────────────────────────── */

async function health(deps: RouteDeps, ctx: HttpCtx, cfg: Config): Promise<void> {
  const online = await deps.registry.list();
  ctx.json(200, {
    status: "healthy",
    deployedCommit: cfg.commitHash,
    deployedAt: startTime.toISOString(),
    onlineNodes: online.filter((n) => n["online"] === true).length,
    node: process.version,
  });
}

function metrics(ctx: HttpCtx): void {
  const mem = process.memoryUsage();
  ctx.json(200, {
    memory: {
      rss: mem.rss,
      heap_used: mem.heapUsed,
      heap_total: mem.heapTotal,
      external: mem.external,
    },
    uptime_seconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
    node_version: process.version,
  });
}

/* ── static assets (dev server) ────────────────────────────────────── */

type StaticServer = (ctx: HttpCtx, urlPath: string) => boolean;

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** URL → relative file name inside the web/ directory (mirrors the Go
 * StaticFile set; null reads the repo-root logo once as a fallback). */
const STATIC_ROUTES: Array<[url: string, fileName: string | null]> = [
  ["/", "index.html"],
  ["/login", "auth.html"],
  ["/dashboard", "dashboard.html"],
  ["/profile", "profile.html"],
  ["/styles.css", "styles.css"],
  ["/dashboard.css", "dashboard.css"],
  ["/profile.css", "profile.css"],
  ["/favicon.svg", "favicon.svg"],
  ["/openbin-mark.svg", "openbin-mark.svg"],
  ["/auth-client.js", "auth-client.js"],
  ["/dashboard.js", "dashboard.js"],
  ["/profile.js", "profile.js"],
  ["/logo.svg", null],
];

function makeStaticServer(webRoot: string): StaticServer {
  return (ctx: HttpCtx, urlPath: string): boolean => {
    if (ctx.method !== "GET") return false;
    const entry = STATIC_ROUTES.find(([u]) => u === urlPath);
    if (entry === undefined) return false;
    const [url, fileName] = entry;
    const filePath = fileName === null ? path.join(webRoot, "..", "logo.svg") : path.join(webRoot, fileName);
    let data: Buffer;
    try {
      data = readFileSync(filePath);
    } catch {
      log(`[static] missing asset for ${url}`);
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    ctx.setHeader("Cache-Control", isHtml ? "no-store" : "public, max-age=300");
    ctx.raw(200, STATIC_MIME[ext] ?? "application/octet-stream", data);
    return true;
  };
}
