import type { HttpCtx } from "../http/ctx.js";
import type { NodeRegistry } from "./registry.js";
import { log, logError } from "../log.js";
import {
  normalizeNodeId,
  isSafeNodeID,
  validNodeName,
  asScalarNumber,
} from "./validate.js";
import { signedPayload, verifyNodeSignature } from "./ed25519.js";
import { asRepoEntry } from "./utils.js";

interface NodeBody {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  pubkey?: unknown;
  token?: unknown;
  sig?: unknown;
  ts?: unknown;
  fw?: unknown;
  req_id?: unknown;
}

function badRequest(ctx: HttpCtx, error: string): void {
  ctx.json(400, { error });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tsMs(v: unknown): number {
  const n = asScalarNumber(v);
  return n;
}

export function makeIngestHandlers(registry: NodeRegistry) {
  return {
    async pair(ctx: HttpCtx): Promise<void> {
      const body = (await ctx.body()) as NodeBody | null;
      if (body === null || typeof body !== "object") return badRequest(ctx, "missing body");
      const id = normalizeNodeId(str(body.id));
      const ts = tsMs(body.ts);
      if (id === "" || !isSafeNodeID(id) || ts <= 0) return badRequest(ctx, "missing or invalid node id");
      const payload = signedPayload(id, ts, "pair");
      if (!verifyNodeSignature(str(body.pubkey), str(body.sig), payload)) {
        logError(`[node] invalid pair_request signature from ${id}`);
        return ctx.json(401, { error: "invalid_signature" });
      }
      const name = str(body.name);
      await registry.registerPairing(id, str(body.code), validNodeName(name) ? name : "", str(body.pubkey));
      log(`[node] pairing code registered for ${id}`);
      ctx.json(200, { ok: true });
    },

    async poll(ctx: HttpCtx): Promise<void> {
      const body = (await ctx.body()) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object") return badRequest(ctx, "missing body");
      const id = normalizeNodeId(str(body.id));
      const ts = tsMs(body.ts);
      if (id === "" || !isSafeNodeID(id) || ts <= 0) return badRequest(ctx, "missing or invalid node id");

      const token = str(body.token);
      let commands: Record<string, unknown>[];
      if (token !== "") {
        if (!(await registry.tokenValid(id, token))) {
          log(`[node] hello rejected (bad token) from ${id}`);
          return ctx.json(401, { error: "pair_rejected" });
        }
        const name = str(body.name);
        const fw = str(body.fw);
        const cameOnline = await registry.touchOnline(id, validNodeName(name) ? name : undefined, fw || undefined);
        await registry.touchTelemetry(id, {
          uptime_s: asScalarNumber(body.uptime_s),
          storage_free: asScalarNumber(body.storage_free),
          storage_total: asScalarNumber(body.storage_total),
          ram_total: asScalarNumber(body.ram_total),
          heap_free: asScalarNumber(body.heap_free),
          wifi_rssi: asScalarNumber(body.wifi_rssi),
        });
        if (cameOnline) {
          log(`[node] ONLINE: ${id}` + (name ? ` (${name})` : "") + (fw ? ` fw=${fw}` : ""));
          await registry.pushCommand(id, { action: "repo_list" });
        }
        commands = await registry.drainInbox(id);
      } else {
        commands = [];
        const payload = signedPayload(id, ts, "poll");
        const rec = await registry.getNode(id);
        const pubkey = typeof rec?.["pubkey"] === "string" ? rec["pubkey"] : "";
        const token = typeof rec?.["token"] === "string" ? rec["token"] : "";
        if (pubkey !== "" && pubkey === str(body.pubkey) && verifyNodeSignature(pubkey, str(body.sig), payload)) {
          commands = await registry.drainInbox(id);
          if (token !== "" && commands.length === 0) {
            await registry.pushCommand(id, { action: "pair_ok", node_id: id, token });
            commands = await registry.drainInbox(id);
          }
        } else {
          const code = await registry.pendingCodeFor(id);
          if (code !== null) {
            const pending = await registry.pairingByCode(code);
            if (pending && pending.pubkey === str(body.pubkey) && verifyNodeSignature(pending.pubkey, str(body.sig), payload)) {
              commands = await registry.drainInbox(id);
            }
          }
        }
      }
      ctx.json(200, { ok: true, online: token !== "", commands });
    },

    async respond(ctx: HttpCtx): Promise<void> {
      const body = (await ctx.body()) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object") return badRequest(ctx, "missing body");
      const id = normalizeNodeId(str(body.id));
      const token = str(body.token);
      if (id === "" || !isSafeNodeID(id)) return badRequest(ctx, "missing or invalid node id");
      if (token === "" || !(await registry.tokenValid(id, token))) {
        return ctx.json(401, { error: "unauthorized" });
      }
      const reqId = str(body.req_id);
      if (reqId === "" || reqId.includes(":")) return badRequest(ctx, "invalid req_id");
      if (body.action === "repo_list") {
        const repos = Array.isArray(body.repositories) ? body.repositories.map(asRepoEntry) : [];
        await registry.updateRepos(id, repos);
        log(`[node] repo index updated for ${id}: ${repos.length} repos`);
      }
      const isOk = body.ok === true;
      const payload: Record<string, unknown> = isOk ? { ok: true } : { ok: false, error: str(body.error) };
      for (const [k, v] of Object.entries(body)) {
        if (["id", "token", "sig", "ts", "type", "ok"].includes(k)) continue;
        if (!isOk && k === "error") continue;
        payload[k] = v;
      }
      await registry.storeResponse(reqId, payload);
      ctx.json(200, { ok: true });
    },
  };
}
