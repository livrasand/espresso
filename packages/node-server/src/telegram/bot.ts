// Minimal Telegram bot front-end for the Espresso control plane.
// Receives webhook updates, maps a chat to an Espresso account, and runs the
// same management actions as the dashboard.

import type { HttpCtx } from "../http/ctx.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { safeRepo, normalizeNodeId, isSafeNodeID } from "../nodes/validate.js";

import { log } from "../log.js";

type CallNodeFn = (id: string, action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Deps {
  registry: NodeRegistry;
  callNode: CallNodeFn;
}

function botToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

async function tg(method: string, body: Record<string, unknown>): Promise<void> {
  const token = botToken();
  if (!token) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) log(`[telegram] ${method} HTTP ${res.status}: ${txt.slice(0, 300)}`);
    else if (!txt.includes('"ok":true')) log(`[telegram] ${method} resp: ${txt.slice(0, 300)}`);
  } catch (e) {
    log(`[telegram] ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function reply(chatId: number, text: string): Promise<void> {
  await tg("sendMessage", { chat_id: chatId, text });
}

function chatKey(chatId: number): string {
  return `tg:chat:${chatId}`;
}

export function makeTelegramHandlers(deps: Deps) {
  const { registry, callNode } = deps;

  async function getAccount(chatId: number): Promise<string | null> {
    return registry.getTelegramChat(chatId);
  }

  async function setAccount(chatId: number, account: string): Promise<void> {
    await registry.setTelegramChat(chatId, account);
  }

  async function handleCommand(chatId: number, text: string): Promise<void> {
    const allowed = process.env.TELEGRAM_ALLOWED_CHATS;
    if (allowed) {
      const ids = allowed.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      if (ids.length > 0 && !ids.includes(chatId)) {
        await reply(chatId, "Not authorized.");
        return;
      }
    }
    const parts = text.trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase().replace(/@\w+$/, "");
    const args = parts.slice(1);

    if (cmd === "/start" || cmd === "/help") {
      await reply(
        chatId,
        "Espresso bot.\n" +
          "/link <account> - link this chat to your account\n" +
          "/nodes - list your nodes\n" +
          "/repos <node> - list repos\n" +
          "/create <node> <repo> - create repo\n" +
          "/delete <node> <repo> - delete repo\n" +
          "/ping <node> - ping node\n" +
          "/status <node> - storage status\n" +
          "/restart <node> - restart node",
      );
      return;
    }

    if (cmd === "/link") {
      const acct = args[0];
      if (!acct) return reply(chatId, "Usage: /link <account_number>");
      await setAccount(chatId, acct.toUpperCase());
      await reply(chatId, `Linked to account ${acct.toUpperCase()}.`);
      return;
    }

    const account = await getAccount(chatId);
    if (!account) return reply(chatId, "Please /link <account_number> first.");

    if (cmd === "/nodes") {
      const nodes = await registry.listByAccount(account);
      if (nodes.length === 0) return reply(chatId, "No nodes.");
      const lines = nodes.map((n) => `${n["id"]} ${n["name"]} ${n["online"] ? "online" : "offline"}`);
      await reply(chatId, lines.join("\n"));
      return;
    }

    const nodeId = normalizeNodeId(args[0] ?? "");
    if (!nodeId || !isSafeNodeID(nodeId)) {
      await reply(chatId, "Usage: /repos <node>  (valid node id required)");
      return;
    }

    // ownership check
    const rec = await registry.getNode(nodeId);
    if (!rec || rec["account"] !== account) {
      await reply(chatId, "Node not found or not yours.");
      return;
    }

    if (cmd === "/repos") {
      let repos: string[] = [];
      try {
        if (await registry.isOnline(nodeId)) {
          const resp = await callNode(nodeId, "repo_list", {});
          const r = Array.isArray(resp["repositories"]) ? resp["repositories"] : [];
          repos = r.map((x: any) => (typeof x === "string" ? x : x?.name ?? "")).filter(Boolean);
        }
      } catch {
        /* fall through */
      }
      if (repos.length === 0) {
        try {
          const view = await registry.nodeView(nodeId);
          const cached = (view as any)?.repositories ?? [];
          repos = Array.isArray(cached) ? cached.map((x: any) => (typeof x === "string" ? x : x?.name ?? "")).filter(Boolean) : [];
        } catch {
          /* ignore */
        }
      }
      await reply(chatId, repos.length ? repos.join("\n") : "No repos (or node offline).");
      return;
    }

    if (cmd === "/create") {
      const repo = args[1];
      if (!repo || !safeRepo(repo)) return reply(chatId, "Usage: /create <node> <repo> (valid repo name)");
      try {
        await callNode(nodeId, "repo_create", { repo });
        await reply(chatId, `Created ${repo}.`);
      } catch (e) {
        await reply(chatId, `Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (cmd === "/delete") {
      const repo = args[1];
      if (!repo || !safeRepo(repo)) return reply(chatId, "Usage: /delete <node> <repo> (valid repo name)");
      try {
        await callNode(nodeId, "repo_delete", { repo });
        await reply(chatId, `Deleted ${repo}.`);
      } catch (e) {
        await reply(chatId, `Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (cmd === "/ping") {
      try {
        await callNode(nodeId, "ping", {});
        await reply(chatId, "pong");
      } catch (e) {
        await reply(chatId, `Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (cmd === "/status") {
      try {
        const resp = await callNode(nodeId, "storage_status", {});
        await reply(chatId, JSON.stringify(resp, null, 2));
      } catch (e) {
        await reply(chatId, `Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (cmd === "/restart") {
      try {
        await callNode(nodeId, "restart", {});
        await reply(chatId, "Restart command sent.");
      } catch (e) {
        await reply(chatId, `Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    await reply(chatId, "Unknown command. /help");
  }

  return {
    async webhook(ctx: HttpCtx): Promise<void> {
      if (botToken() === "") return ctx.json(503, { error: "telegram not configured" });
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (secret) {
        const provided = ctx.header("x-telegram-bot-api-secret-token");
        if (provided !== secret) return ctx.json(403, { error: "forbidden" });
      }
      const body = (await ctx.body()) as any;
      const msg = body?.message;
      if (!msg || typeof msg.text !== "string") return ctx.json(200, { ok: true });
      const chatId = msg.chat?.id;
      if (typeof chatId !== "number") return ctx.json(200, { ok: true });
      try {
        await handleCommand(chatId, msg.text);
      } catch (e) {
        log(`[telegram] handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      ctx.json(200, { ok: true });
    },
  };
}
