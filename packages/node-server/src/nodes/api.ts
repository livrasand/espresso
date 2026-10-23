// Management API handlers (port of internal/node/api.go) and repo browsing
// (/api/gg). RPC rides on the polling inbox instead of WebSocket.

import type { HttpCtx } from "../http/ctx.js";
import type { NodeRegistry, RepoEntry } from "./registry.js";
import type { RpcError } from "./rpc.js";
import { makeRpc } from "./rpc.js";
import { log } from "../log.js";
import { safeRepo, safePath } from "./validate.js";

type CallNode = ReturnType<typeof makeRpc>;

export interface ApiDeps {
  registry: NodeRegistry;
  callNode: CallNode;
}

interface JsonBody {
  repo?: unknown;
  code?: unknown;
  name?: unknown;
  path?: unknown;
  offset?: unknown;
  len?: unknown;
  data_b64?: unknown;
  readme?: unknown;
  description?: unknown;
  gitignore?: unknown;
  license?: unknown;
  action?: unknown;
  params?: unknown;
}

const GITIGNORE_TEMPLATES: Record<string, string> = {
  Node: "node_modules/\n.env\n.DS_Store\n",
  Python: "__pycache__/\n*.py[cod]\n*$py.class\n.env\n.DS_Store\n",
  Go: "bin/\npkg/\n*.mod\n*.sum\n.DS_Store\n",
  Java: "target/\n*.class\n*.jar\n.DS_Store\n",
  "C++": "bin/\nobj/\n*.o\n*.a\n.DS_Store\n",
};

const LICENSE_TEMPLATES: Record<string, string> = {
  MIT: "MIT License\n\nPermission is hereby granted...",
  "Apache-2.0": "Apache License 2.0\n\nCopyright...",
  "GPL-3.0": "GNU GPL 3.0\n\nGNU GENERAL PUBLIC LICENSE...",
  "AGPL-3.0": "GNU AGPL 3.0\n\nGNU AFFERO GENERAL PUBLIC LICENSE...",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function makeApiHandlers(deps: ApiDeps) {
  const { registry, callNode } = deps;

  /** getLiveNode: resolves owner + node authorization for /api/nodes ops.
   * Owner is the authenticated account session; when sessions are off
   * (trusted-network / dev mode) the management API key substitutes. */
  async function getLiveNode(ctx: HttpCtx, idParam: string): Promise<{ id: string; owner: string } | null> {
    const id = idParam.toUpperCase();
    let owner = ctx.identity;
    if (owner === "") owner = ctx.header("x-espresso-key") ?? "";
    if (owner === "") {
      ctx.json(401, { error: "authenticated identity required" });
      return null;
    }
    if (!(await registry.isOnline(id))) {
      ctx.json(503, {
        error: "node offline",
        note: "repository exists but storage is unavailable",
      });
      return null;
    }
    const rec = await registry.getNode(id);
    if (rec === null || rec["account"] !== owner) {
      ctx.json(403, { error: "access denied to this node" });
      return null;
    }
    return { id, owner };
  }

  async function rpcOr(ctx: HttpCtx, id: string, action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      return await callNode(id, action, params);
    } catch (e) {
      const rpc = e as RpcError;
      ctx.json(rpc.status ?? 502, { error: rpc.message });
      return null;
    }
  }

  return {
    /** POST /api/nodes/pair {"code"} — completes pairing from the web UI. */
    async pair(ctx: HttpCtx): Promise<void> {
      const body = (await ctx.body()) as JsonBody | null;
      const code = str(body?.code);
      if (code === "") return ctx.json(400, { error: "code is required" });
      const owner = ctx.identity !== "" ? ctx.identity : (ctx.header("x-espresso-key") ?? "");
      if (owner === "") return ctx.json(401, { error: "authenticated identity required" });
      const nodeId = await registry.confirmPairing(code, owner);
      if (nodeId === null) return ctx.json(404, { error: "invalid or expired pairing code" });
      log(`[node] PAIRED: ${nodeId} by ${ctx.identity !== "" ? "account" : "api_key"}`);
      ctx.json(200, { node_id: nodeId });
    },

    /** GET /api/nodes — dashboard listing. */
    async list(ctx: HttpCtx): Promise<void> {
      let identity = ctx.identity;
      if (identity === "") identity = ctx.header("x-espresso-key") ?? "";
      if (identity !== "") {
        return ctx.json(200, { nodes: await registry.listByAccount(identity) });
      }
      ctx.json(200, { nodes: [] });
    },

    /** GET /api/nodes/:id/repos */
    async repos(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const resp = await rpcOr(ctx, live.id, "repo_list", {});
      if (resp === null) return;
      const repositories = Array.isArray(resp["repositories"]) ? resp["repositories"] : [];
      ctx.json(200, { repositories });
    },

    /** POST /api/nodes/:id/repos — create with optional README/.gitignore/LICENSE. */
    async reposCreateFull(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const name = str(body?.name);
      const description = str(body?.description);
      if (body === null || !safeRepo(name)) return ctx.json(400, { error: "invalid or missing name" });

      const created = await rpcOr(ctx, live.id, "repo_create", { repo: name });
      if (created === null) return;

      const maybeWrite = async (path: string, content: string, what: string): Promise<void> => {
        const r = await callNode(live.id, "fs_write", { repo: name, path, data_b64: Buffer.from(content, "utf8").toString("base64") }).catch(() => null);
        if (r === null) log(`[node] warning: failed to create ${what} on ${live.id}`);
      };

      if (body.readme === "yes") {
        await maybeWrite("README.md", `# ${name}\n\n${description}`, "README.md");
      }
      const gitignore = str(body.gitignore);
      if (gitignore !== "none" && gitignore !== "" && GITIGNORE_TEMPLATES[gitignore]) {
        await maybeWrite(".gitignore", GITIGNORE_TEMPLATES[gitignore]!, ".gitignore");
      }
      const license = str(body.license);
      if (license !== "none" && license !== "" && LICENSE_TEMPLATES[license]) {
        await maybeWrite("LICENSE", LICENSE_TEMPLATES[license]!, "LICENSE");
      }

      log(`[node] repo created on ${live.id}: ${name}`);
      ctx.json(200, { ok: true, repo_id: name });
    },

    /** POST /api/nodes/:id/repo/create — bare repo only. */
    async repoCreate(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const name = str(body?.name);
      if (body === null || !safeRepo(name)) return ctx.json(400, { error: "invalid or missing name" });
      const resp = await rpcOr(ctx, live.id, "repo_create", { repo: name });
      if (resp === null) return;
      log(`[node] repo created on ${live.id}: ${name}`);
      ctx.json(200, { ok: true });
    },

    /** POST /api/nodes/:id/repo/delete */
    async repoDelete(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const repo = str(body?.repo);
      if (body === null || !safeRepo(repo)) return ctx.json(400, { error: "invalid or missing repo" });
      const resp = await rpcOr(ctx, live.id, "repo_delete", { repo });
      if (resp === null) return;
      log(`[node] repo deleted on ${live.id}: ${repo}`);
      ctx.json(200, { ok: true });
    },

    /** GET /api/nodes/:id/refs/:repo */
    async refs(ctx: HttpCtx, idParam: string, repo: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      if (!safeRepo(decodeURIComponent(repo))) return ctx.json(400, { error: "invalid repo name" });
      const resp = await rpcOr(ctx, live.id, "refs_list", { repo: decodeURIComponent(repo) });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    /** POST /api/nodes/:id/fs/read */
    async fsRead(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const repo = str(body?.repo);
      const path = str(body?.path);
      if (body === null || !safeRepo(repo) || !safePath(path)) return ctx.json(400, { error: "invalid request" });
      let len = Math.floor(
        typeof body?.len === "number" && Number.isFinite(body.len) ? body.len : 0,
      );
      if (len <= 0 || len > 32 * 1024) len = 8192;
      const offset = Math.floor(typeof body?.offset === "number" && Number.isFinite(body.offset) ? body.offset : 0);
      const resp = await rpcOr(ctx, live.id, "fs_read", { repo, path, offset, len });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    /** POST /api/nodes/:id/fs/write */
    async fsWrite(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const repo = str(body?.repo);
      const path = str(body?.path);
      const data = str(body?.data_b64);
      if (body === null || !safeRepo(repo) || !safePath(path) || data.length > 64 * 1024) {
        return ctx.json(400, { error: "invalid request" });
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return ctx.json(400, { error: "invalid base64" });
      const offset = Math.floor(typeof body?.offset === "number" && Number.isFinite(body.offset) ? body.offset : 0);
      const resp = await rpcOr(ctx, live.id, "fs_write", { repo, path, offset, data });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    /** POST /api/nodes/:id/fs/list */
    async fsList(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const repo = str(body?.repo);
      const path = str(body?.path);
      if (body === null || !safeRepo(repo) || !safePath(path)) return ctx.json(400, { error: "invalid request" });
      const resp = await rpcOr(ctx, live.id, "fs_list", { repo, path });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    /** POST /api/nodes/:id/cmd/ping (generic admin action proxy) */
    async cmd(ctx: HttpCtx, idParam: string): Promise<void> {
      const live = await getLiveNode(ctx, idParam);
      if (live === null) return;
      const body = (await ctx.body()) as JsonBody | null;
      const action = str(body?.action);
      if (body === null || action === "") return ctx.json(400, { error: "action required" });
      if (action !== "ping") return ctx.json(400, { error: "unsupported action" });
      const params = typeof body?.params === "object" && body.params !== null ? (body.params as Record<string, unknown>) : {};
      const resp = await rpcOr(ctx, live.id, action, params);
      if (resp === null) return;
      ctx.json(200, resp);
    },
  };
}

// ── /api/gg — repo browsing served through the paired node ──────────

export function makeGGHandlers(deps: ApiDeps) {
  const { registry, callNode } = deps;

  async function nodeForAccountRepo(
    ctx: HttpCtx,
    account: string,
    repo: string,
  ): Promise<{ id: string; owner: string } | null> {
    const nodes = await registry.listByAccount(account);
    for (const n of nodes) {
      const id = str(n["id"]);
      if ((await registry.isOnline(id)) === false) continue;
      const repos = Array.isArray(n["repositories"]) ? (n["repositories"] as RepoEntry[]) : [];
      if (repos.some((r) => r.name === repo)) {
        return { id, owner: account };
      }
    }
    ctx.json(404, { error: "repo not found on any online node" });
    return null;
  }

  async function rpcOr(ctx: HttpCtx, id: string, action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      return await callNode(id, action, params);
    } catch (e) {
      const rpc = e as RpcError;
      ctx.json(rpc.status ?? 502, { error: rpc.message });
      return null;
    }
  }

  async function branchesAndTags(
    ctx: HttpCtx,
    id: string,
    repo: string,
  ): Promise<{ branches: string[]; tags: string[]; commits: string[] } | null> {
    const resp = await rpcOr(ctx, id, "refs_list", { repo });
    if (resp === null) return null;
    const pickArr = (key: string): string[] => {
      if (Array.isArray(resp[key])) return (resp[key] as unknown[]).filter((x): x is string => typeof x === "string");
      return [];
    };
  let branches = pickArr("branches");
  let tags = pickArr("tags");
  let commits = pickArr("commits");
  if (branches.length === 0 && tags.length === 0) {
      branches = [];
      tags = [];
      for (const r of pickArr("refs")) {
        if (r.startsWith("refs/heads/")) branches.push(r.slice("refs/heads/".length));
        else if (r.startsWith("refs/tags/")) tags.push(r.slice("refs/tags/".length));
      }
    }
    return { branches, tags, commits };
  }

  return {
    async tree(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
      repo = decodeURIComponent(repo);
      owner = decodeURIComponent(owner);
      const live = await nodeForAccountRepo(ctx, owner, repo);
      if (live === null) return;
      const path = ctx.query["path"] ?? "";
      const resp = await rpcOr(ctx, live.id, "fs_list", { repo, path });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    async raw(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
      repo = decodeURIComponent(repo);
      owner = decodeURIComponent(owner);
      const live = await nodeForAccountRepo(ctx, owner, repo);
      if (live === null) return;
      const path = ctx.query["path"] ?? "";
      const resp = await rpcOr(ctx, live.id, "fs_read", { repo, path });
      if (resp === null) return;
      ctx.json(200, resp);
    },

    async info(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
      repo = decodeURIComponent(repo);
      owner = decodeURIComponent(owner);
      const live = await nodeForAccountRepo(ctx, owner, repo);
      if (live === null) return;
      const resp = await rpcOr(ctx, live.id, "repo_list", {});
      if (resp === null) return;
      let size = 0;
      if (Array.isArray(resp["repositories"])) {
        for (const r of resp["repositories"] as Record<string, unknown>[]) {
          if (r["name"] === repo) {
            const s = r["size"];
            if (typeof s === "number" && Number.isFinite(s)) size = Math.floor(s);
            break;
          }
        }
      }
      ctx.json(200, { name: repo, size });
    },

    async branches(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
      repo = decodeURIComponent(repo);
      owner = decodeURIComponent(owner);
      const live = await nodeForAccountRepo(ctx, owner, repo);
      if (live === null) return;
      const bt = await branchesAndTags(ctx, live.id, repo);
      if (bt === null) return;
    ctx.json(200, { branches: bt.branches, commits: bt.commits });
  },
  async tags(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
    repo = decodeURIComponent(repo);
    owner = decodeURIComponent(owner);
    const live = await nodeForAccountRepo(ctx, owner, repo);
    if (live === null) return;
    const bt = await branchesAndTags(ctx, live.id, repo);
    if (bt === null) return;
    ctx.json(200, { tags: bt.tags });
  },
  async commits(ctx: HttpCtx, owner: string, repo: string): Promise<void> {
    repo = decodeURIComponent(repo);
    owner = decodeURIComponent(owner);
    const live = await nodeForAccountRepo(ctx, owner, repo);
    if (live === null) return;
    const bt = await branchesAndTags(ctx, live.id, repo);
    if (bt === null) return;
    ctx.json(200, { commits: bt.commits });
  },
  };
}
