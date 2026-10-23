// Security middleware: headers, CORS, API-key gate (port of
// internal/http/middleware.go).

import type { HttpCtx } from "./ctx.js";

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "object-src 'none'; " +
    "frame-ancestors 'none'; " +
    "connect-src 'self'",
};

export function applySecurityHeaders(ctx: HttpCtx): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) ctx.setHeader(k, v);
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Sets CORS headers for localhost origins; completes OPTIONS preflight. */
export function applyLocalhostCORS(ctx: HttpCtx): void {
  const origin = ctx.header("origin") ?? "";
  if (isLocalhostOrigin(origin)) {
    ctx.setHeader("Access-Control-Allow-Origin", origin);
    ctx.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    ctx.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Espresso-Key, X-ZKP-Token");
    if (ctx.method === "OPTIONS") {
      ctx.status(204);
    }
  }
}

/**
 * Management API key gate (X-Espresso-Key). Mirrors anonymousAuthMiddleware:
 * when no key is configured the endpoint stays open (trusted-network mode).
 * Returns false only when a key IS configured but wrongly provided.
 */
export function apiKeyOk(ctx: HttpCtx, apiKey: string): boolean {
  if (apiKey === "") return true;
  const provided = ctx.header("x-espresso-key") ?? "";
  if (provided === "") return false;
  // constant-time compare
  if (provided.length !== apiKey.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ apiKey.charCodeAt(i);
  return diff === 0;
}
