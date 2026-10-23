// Account handlers (port of internal/http/accounts.go): POST /api/accounts
// (mint), /api/accounts/login, /api/accounts/backup. Mullvad-style: the
// number is the sole credential.

import type { HttpCtx } from "../http/ctx.js";
import type { AccountStore } from "./store.js";
import { issueSessionToken } from "../auth/session.js";
import type { Config } from "../env.js";
import { ACCOUNT_NUMBER_LENGTH } from "./store.js";

const MAX_ACCOUNT_BODY = 16 * 1024;

export function accountsSecurity(ctx: HttpCtx): boolean {
  ctx.setHeader("Cache-Control", "no-store");
  ctx.setHeader("Pragma", "no-cache");
  return true; // body size enforced when reading below
}

export function makeAccountHandlers(store: AccountStore, cfg: Config) {
  return {
    /** POST /api/accounts — mint account + auto-login token. */
    async register(ctx: HttpCtx): Promise<void> {
      const raw = await ctx.bodyBuffer(MAX_ACCOUNT_BODY);
      if (raw === null) return ctx.json(413, { error: "account request too large" });
      try {
        const code = await store.create();
        ctx.json(201, { account: code, session_token: issueSessionToken(code, cfg.secret) });
      } catch (e) {
        ctx.json(500, { error: "account creation failed" });
      }
    },

    /** POST /api/accounts/login — 16-digit number is the only credential. */
    async login(ctx: HttpCtx): Promise<void> {
      const raw = await ctx.bodyBuffer(MAX_ACCOUNT_BODY);
      if (raw === null) return ctx.json(413, { error: "account request too large" });
      let account = "";
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        account = typeof parsed?.account === "string" ? parsed.account : "";
      } catch {
        return ctx.json(400, { error: "account number required" });
      }
      const code = store.normalize(account);
      if (code.length !== ACCOUNT_NUMBER_LENGTH) {
        return ctx.json(401, { error: "invalid account number" });
      }
      if (!(await store.exists(code))) {
        return ctx.json(401, { error: "invalid account number" });
      }
      ctx.json(200, { account: code, session_token: issueSessionToken(code, cfg.secret) });
    },

    /** POST /api/accounts/backup — returns the number behind the session. */
    async backup(ctx: HttpCtx, identity: string): Promise<void> {
      if (identity === "") return ctx.json(401, { error: "session token required" });
      ctx.json(200, { account: identity });
    },
  };
}
