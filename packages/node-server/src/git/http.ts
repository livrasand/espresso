// Git smart HTTP handlers (step 2: info/refs).

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

   async function resolveNode(ctx: HttpCtx, owner: string, repo: string): Promise<string | null> {
     let identity = ctx.identity;
     if (identity === "") identity = ctx.header("x-espresso-key") ?? "";
     let nodes: Record<string, unknown>[] = [];
     if (identity !== "") {
       nodes = await registry.listByAccount(identity);
     } else {
       // Allow unauthenticated clone/push by repo name across all nodes.
       nodes = await registry.list();
     }
     for (const n of nodes) {
       const id = str(n["id"]);
       const repos = Array.isArray(n["repositories"]) ? (n["repositories"] as { name: string }[]) : [];
       if (repos.some((r) => r.name === repo)) {
         const online = await registry.isOnline(id);
         if (online) return id;
       }
     }
     if (identity === "") ctx.json(404, { error: "repo not found on any online node" });
     else ctx.json(404, { error: "repo not found on any online node" });
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
      const nodeId = await resolveNode(ctx, owner, repo);
      if (nodeId === null) return ctx.json(404, { error: "repo not found" });

      let refs: string[] = [];
      try {
        const resp = await callNode(nodeId, "refs_list", { repo });
        if (Array.isArray(resp["refs"])) refs = resp["refs"] as string[];
        else if (Array.isArray(resp["branches"])) {
          // fallback: build refs from branches/tags
          for (const b of resp["branches"] as string[]) refs.push(`refs/heads/${b}`);
          for (const t of (resp["tags"] as string[]) ?? []) refs.push(`refs/tags/${t}`);
        }
      } catch {
        return ctx.json(502, { error: "node rpc failed" });
      }

      const isUpload = service === "git-upload-pack";
      const contentType = isUpload
        ? "application/x-git-upload-pack-advertisement"
        : "application/x-git-receive-pack-advertisement";

      // Build advertisement (protocol v1)
      let body = "";
      body += pktLine(`# service=${service}\n`);
      body += "0000";
      // refs with capabilities on first line
      const caps = isUpload
        ? "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress include-tag"
        : "report-status delete-refs side-band-64k ofs-delta";
      let first = true;
      // We don't have sha per ref from refs_list maybe; use zeros placeholder? 
      // For correctness, need sha. If refs are like "refs/heads/main" without sha, skip.
      for (const r of refs) {
        // expect "sha refname" or just refname
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
        // advertise capabilities with zero sha for HEAD? minimal: send 0000 only
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
      const nodeId = await resolveNode(ctx, owner, repo);
      if (nodeId === null) return ctx.json(404, { error: "repo not found" });
       const body = await ctx.bodyBuffer(64 * 1024 * 1024);
       if (body === null) return ctx.json(413, { error: "payload too large" });
       try {
         const out = await runNodeGitPack(callNode, nodeId, repo, "git-upload-pack", body);
         ctx.setHeader("Cache-Control", "no-cache");
         ctx.raw(200, "application/x-git-upload-pack-result", out);
       } catch (e) {
         console.error("git pack error:", (e as Error).stack || (e as Error).message);
         ctx.json(502, { error: (e as Error).message });
       }
    },

    async receivePack(ctx: HttpCtx): Promise<void> {
      const m = ctx.path.match(/^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/);
      if (!m) return ctx.status(404);
      const owner = decodeURIComponent(m[1]!);
      const repo = decodeURIComponent(m[2]!);
      const nodeId = await resolveNode(ctx, owner, repo);
      if (nodeId === null) return ctx.json(404, { error: "repo not found" });
       const body = await ctx.bodyBuffer(64 * 1024 * 1024);
       if (body === null) return ctx.json(413, { error: "payload too large" });
       try {
         const out = await runNodeGitPack(callNode, nodeId, repo, "git-receive-pack", body);
         ctx.setHeader("Cache-Control", "no-cache");
         ctx.raw(200, "application/x-git-receive-pack-result", out);
       } catch (e) {
         console.error("git pack error:", (e as Error).stack || (e as Error).message);
         ctx.json(502, { error: (e as Error).message });
       }
    },
  };
}
