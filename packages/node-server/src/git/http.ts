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

   async function resolveNode(ctx: HttpCtx, owner: string, repo: string): Promise<{ id: string; offline: boolean } | null> {
     let identity = ctx.identity;
     if (identity === "") identity = ctx.header("x-espresso-key") ?? "";
     let nodes: Record<string, unknown>[] = [];
     if (identity !== "") {
       nodes = await registry.listByAccount(identity);
     } else {
       // Allow unauthenticated clone/push by repo name across all nodes.
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
       // Repo exists but its node is disconnected: surface that explicitly
       // instead of a misleading "repository not found".
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
      // Prefer Strata (control plane store) for refs so clones work even when
      // the node is busy or offline.
      let refs: string[] = [];
      let fromStrata = false;
      try {
        const paths = await registry.listGitFiles(owner, repo);
        if (paths.length > 0) {
          fromStrata = true;
          // Read each ref file to get its sha.
          for (const p of paths) {
            if (p === "HEAD") continue;
            if (!p.startsWith("refs/")) continue;
            const buf = await registry.getGitFile(owner, repo, p);
            if (!buf) continue;
            const sha = buf.toString("utf8").trim().split(/\s+/)[0];
            // Skip unborn refs (zero sha) — advertising them makes the client
            // send "want 0000..." which upload-pack rejects.
            if (sha && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha)) refs.push(`${sha} ${p}`);
          }
          // Ensure HEAD advertised.
          const headBuf = await registry.getGitFile(owner, repo, "HEAD");
          if (headBuf) {
            const m = headBuf.toString("utf8").match(/ref:\s*(.+)/);
            if (m) {
              const target = m[1]!.trim();
              const targetBuf = await registry.getGitFile(owner, repo, target);
              const sha = targetBuf ? targetBuf.toString("utf8").trim().split(/\s+/)[0] : "";
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

      // Build advertisement (protocol v1)
      let body = "";
      body += pktLine(`# service=${service}\n`);
      body += "0000";
      // refs with capabilities on first line
      const caps = isUpload
        ? "multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress include-tag"
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
