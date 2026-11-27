import type { HttpCtx } from "../http/ctx.js";
import type { ApiDeps } from "../nodes/api.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { runNodeGitPack } from "./nodeGit.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function pktLine(s: string): string {
  const len = s.length + 4;
  return len.toString(16).padStart(4, "0") + s;
}

export function makeGitHttpHandlers(deps: ApiDeps) {
  const { registry, callNode } = deps;

   async function resolveNode(ctx: HttpCtx, owner: string, repo: string): Promise<{ id: string; offline: boolean } | null> {
     let identity = ctx.identity;
     if (identity === "") identity = ctx.header("x-espresso-key") ?? "";
     let nodes: Record<string, unknown>[] = [];
     if (identity !== "") {
       nodes = await registry.listByAccount(identity);
     } else {
       nodes = await registry.list();
     }
     let foundOffline = false;
     let offlineNodeId = "";
     for (const n of nodes) {
       const id = str(n["id"]);
       const repos = Array.isArray(n["repositories"]) ? (n["repositories"] as { name: string }[]) : [];
       if (repos.some((r) => r.name === repo)) {
         const online = await registry.isOnline(id);
         if (online) return { id, offline: false };
          foundOffline = true;
          offlineNodeId = id;
       }
     }
     if (foundOffline) {
       return { id: offlineNodeId, offline: true };
     }
     ctx.json(404, { error: "repo not found on any online node" });
     return null;
   }

  return {
    async infoRefs(ctx: HttpCtx): Promise<void> {
      const m = ctx.path.match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/);
      if (!m) return ctx.status(404);
      const owner = decodeURIComponent(m[1]!);
      const repo = decodeURIComponent(m[2]!);
      const service = ctx.query["service"] ?? "";
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        return ctx.status(400);
      }
      let refs: string[] = [];
      let fromStrata = false;
      try {
        const data = await registry.getGitRepo(owner, repo);
        if (data) {
          fromStrata = true;
          for (const p of Object.keys(data)) {
            if (p === "HEAD") continue;
            if (!p.startsWith("refs/")) continue;
            const b64p = data[p];
            if (typeof b64p !== "string") continue;
            const sha = Buffer.from(b64p, "base64").toString("utf8").trim().split(/\s+/)[0];
            if (sha && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha)) refs.push(`${sha} ${p}`);
          }
          if (data["HEAD"]) {
            const m = Buffer.from(data["HEAD"], "base64").toString("utf8").match(/ref:\s*(.+)/);
            if (m) {
              const target = m[1]!.trim();
              const targetB64 = data[target];
              const sha = targetB64 ? Buffer.from(targetB64, "base64").toString("utf8").trim().split(/\s+/)[0] : "";
              if (sha && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha) && !refs.some((r) => r.includes(target))) {
                refs.unshift(`${sha} ${target}`);
              }
            }
          }
        }
      } catch {
        fromStrata = false;
      }

      let nodeId: string | null = null;
      if (!fromStrata) {
        const resolved = await resolveNode(ctx, owner, repo);
        if (resolved === null) return ctx.json(404, { error: "repo not found" });
        if (resolved.offline) return ctx.json(503, { error: "node offline" });
        nodeId = resolved.id;
        try {
          const resp = await callNode(nodeId, "refs_list", { repo });
          if (Array.isArray(resp["refs"])) refs = resp["refs"] as string[];
          else if (Array.isArray(resp["branches"])) {
            for (const b of resp["branches"] as string[]) refs.push(`refs/heads/${b}`);
            for (const t of (resp["tags"] as string[]) ?? []) refs.push(`refs/tags/${t}`);
          }
        } catch {
          return ctx.json(502, { error: "node rpc failed" });
        }
      }

      const isUpload = service === "git-upload-pack";
      const contentType = isUpload
        ? "application/x-git-upload-pack-advertisement"
        : "application/x-git-receive-pack-advertisement";

      let body = "";
      body += pktLine(`# service=${service}\n`);
      body += "0000";
      const caps = isUpload
        ? "multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress include-tag"
        : "report-status delete-refs side-band-64k ofs-delta";
      let first = true;
      for (const r of refs) {
        let sha = "0".repeat(40);
        let name = r;
        if (r.includes(" ")) {
          const parts = r.split(" ");
          sha = parts[0]!;
          name = parts.slice(1).join(" ");
        }
        const line = first ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`;
        body += pktLine(line);
        first = false;
      }
      if (refs.length === 0) {
      }
      body += "0000";

      ctx.setHeader("Cache-Control", "no-cache");
      ctx.raw(200, contentType, body);
    },

    async uploadPack(ctx: HttpCtx): Promise<void> {
      const m = ctx.path.match(/^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/);
      if (!m) return ctx.status(404);
      const owner = decodeURIComponent(m[1]!);
      const repo = decodeURIComponent(m[2]!);
      const strataFiles = await registry.listGitFiles(owner, repo).catch(() => [] as string[]);
      let nodeId: string | null = null;
      if (strataFiles.length === 0) {
        const resolved = await resolveNode(ctx, owner, repo);
        if (resolved === null) return ctx.json(404, { error: "repo not found" });
        if (resolved.offline) return ctx.json(503, { error: "node offline" });
        nodeId = resolved.id;
      }
      const body = await ctx.bodyBuffer(64 * 1024 * 1024);
      if (body === null) return ctx.json(413, { error: "payload too large" });
      try {
          const out = await runNodeGitPack(callNode, nodeId, repo, "git-upload-pack", body, registry, owner);
         ctx.setHeader("Cache-Control", "no-cache");
         ctx.raw(200, "application/x-git-upload-pack-result", out);
       } catch (e) {
         console.error("git pack error:", (e as Error).stack || (e as Error).message);
         const __msg = (e as Error).message || "";
         if (__msg.includes("ENOENT")) {
           ctx.json(503, { error: "git binary not available on server" });
         } else {
           ctx.json(502, { error: __msg });
         }
       }
    },

    async receivePack(ctx: HttpCtx): Promise<void> {
      const m = ctx.path.match(/^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/);
      if (!m) return ctx.status(404);
      const owner = decodeURIComponent(m[1]!);
      const repo = decodeURIComponent(m[2]!);
      const strataFiles = await registry.listGitFiles(owner, repo).catch(() => [] as string[]);
      let nodeId: string | null = null;
      if (strataFiles.length === 0) {
        const resolved = await resolveNode(ctx, owner, repo);
        if (resolved === null) return ctx.json(404, { error: "repo not found" });
        if (resolved.offline) return ctx.json(503, { error: "node offline" });
        nodeId = resolved.id;
      }
      const body = await ctx.bodyBuffer(64 * 1024 * 1024);
      if (body === null) return ctx.json(413, { error: "payload too large" });
      try {
          const out = await runNodeGitPack(callNode, nodeId, repo, "git-receive-pack", body, registry, owner);
         ctx.setHeader("Cache-Control", "no-cache");
         ctx.raw(200, "application/x-git-receive-pack-result", out);
       } catch (e) {
         console.error("git pack error:", (e as Error).stack || (e as Error).message);
         const __msg = (e as Error).message || "";
         if (__msg.includes("ENOENT")) {
           ctx.json(503, { error: "git binary not available on server" });
         } else {
           ctx.json(502, { error: __msg });
         }
       }
    },
  };
}
