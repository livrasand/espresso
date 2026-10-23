// Session tokens (port of internal/http/accounts.go). Same wire format the
// Go version issued: `identity.expiryUnix.base64url(HMAC-SHA256)`, delivered
// via the X-ZKP-Token header.

import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function issueSessionToken(identity: string, secret: Buffer): string {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${identity}.${expiry}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  return `${payload}.${sig.toString("base64url")}`;
}

export function validateSessionToken(token: string, secret: Buffer): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [identity, expiry, sigB64] = parts as [string, string, string];
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  const payload = `${identity}.${expiry}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  const exp = Number(expiry);
  if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return null;
  return identity;
}
