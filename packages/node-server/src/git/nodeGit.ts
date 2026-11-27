import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { NodeRegistry } from "../nodes/registry.js";

type CallNode = (id: string, action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function b64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

async function syncFromNode(callNode: CallNode, nodeId: string, repo: string, localDir: string): Promise<void> {
  // recursive
  async function walk(remotePath: string, localPath: string): Promise<void> {
    fs.mkdirSync(localPath, { recursive: true });
    const resp = await callNode(nodeId, "fs_list", { repo, path: remotePath });
    const entries = Array.isArray(resp["entries"]) ? (resp["entries"] as { name: string; dir: boolean; size: number }[]) : [];
    for (const e of entries) {
      const rp = remotePath === "" ? e.name : `${remotePath}/${e.name}`;
      const lp = path.join(localPath, e.name);
      if (e.dir) {
        await walk(rp, lp);
      } else {
        console.log("sync read", rp);
        // read file chunked
        let offset = 0;
        const chunks: Buffer[] = [];
        while (true) {
          const r = await callNode(nodeId, "fs_read", { repo, path: rp, offset, len: 8192 });
          const n = typeof r["len"] === "number" ? r["len"] : 0;
          const data = typeof r["data_b64"] === "string" ? b64(r["data_b64"]) : Buffer.alloc(0);
          chunks.push(data);
          offset += n;
          if (r["eof"] === true || n === 0) break;
        }
        fs.writeFileSync(lp, Buffer.concat(chunks));
      }
    }
  }
  await walk("", localDir);
}

async function syncToNode(callNode: CallNode, nodeId: string, repo: string, localDir: string, relPrefix = "", deadline = Date.now() + 45000): Promise<void> {
  if (Date.now() > deadline) return;
  // Skip non-essential paths to keep the sync small enough for Vercel's 60 s
  // limit (the node polls every few seconds, so each RPC costs a round trip).
  const skipDirs = new Set(["hooks", "info"]);
  const skipFiles = new Set(["description"]);
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const e of entries) {
    if (Date.now() > deadline) {
      console.error("syncToNode: deadline exceeded, stopping");
      return;
    }
    const rel = relPrefix === "" ? e.name : `${relPrefix}/${e.name}`;
    const full = path.join(localDir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      try { await callNode(nodeId, "fs_mkdir", { repo, path: rel }); } catch { /* exists */ }
      await syncToNode(callNode, nodeId, repo, full, rel, deadline);
    } else {
      if (skipFiles.has(e.name)) continue;
      const data = fs.readFileSync(full);
      const chunkSize = 8192;
      let offset = 0;
      while (offset < data.length) {
        if (Date.now() > deadline) {
          console.error("syncToNode: deadline exceeded, stopping");
          return;
        }
        const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
        try {
          await callNode(nodeId, "fs_write", { repo, path: rel, offset, data: chunk.toString("base64") });
        } catch (err) {
          console.error("syncToNode write failed:", (err as Error).message, rel);
        }
        offset += chunk.length;
      }
      if (data.length === 0) {
        await callNode(nodeId, "fs_write", { repo, path: rel, offset: 0, data: "" }).catch(() => {});
      }
    }
  }
}

function gitBin(): string {
  // Prefer a bundled binary (shipped for serverless runtimes like Vercel that
  // have no system git), then fall back to whatever is on PATH.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.resolve(here, "..", "..", "bin", "git");
    if (fs.existsSync(bundled)) return bundled;
  } catch {
    /* ignore */
  }
  return "git";
}

function runGit(args: string[], cwd: string, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(gitBin(), args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${Buffer.concat(err).toString()}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
    p.stdin.write(input);
    p.stdin.end();
  });
}

export async function runNodeGitPack(
  callNode: CallNode,
  nodeId: string,
  repo: string,
  service: "git-upload-pack" | "git-receive-pack",
  input: Buffer,
): Promise<Buffer> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "espresso-git-"));
  const repoDir = path.join(tmpRoot, repo);
  try {
    fs.mkdirSync(repoDir, { recursive: true });
    if (service === "git-upload-pack") {
      await syncFromNode(callNode, nodeId, repo, repoDir);
    }
    // ensure bare repo config
    if (!fs.existsSync(path.join(repoDir, "HEAD"))) {
      // init bare if empty
      await runGit(["init", "--bare", repoDir], tmpRoot, Buffer.alloc(0)).catch(() => {});
    }
    const gitArgs = service === "git-upload-pack"
      ? ["upload-pack", "--stateless-rpc", repoDir]
      : ["receive-pack", "--stateless-rpc", repoDir];
    const output = await runGit(gitArgs, tmpRoot, input);
    if (service === "git-receive-pack") {
      // Sync within a 45 s budget so the node ends up consistent; if it
      // exceeds the budget we stop and return success anyway (best effort).
      try {
        await syncToNode(callNode, nodeId, repo, repoDir, "", Date.now() + 45000);
      } catch (e) {
        console.error("syncToNode failed:", (e as Error).message);
      }
    }
    return output;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
