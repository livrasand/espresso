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

async function syncFromStrata(registry: NodeRegistry, owner: string, repo: string, localDir: string): Promise<void> {
  const data = await registry.getGitRepo(owner, repo);
  if (!data) return;
  for (const [rel, b64] of Object.entries(data)) {
    const full = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(b64, "base64"));
  }
}

async function syncToStrata(registry: NodeRegistry, owner: string, repo: string, localDir: string, relPrefix = ""): Promise<void> {
  const collected: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, rel);
      } else {
        const data = fs.readFileSync(full);
        collected[rel] = data.toString("base64");
      }
    }
  }
  walk(localDir, "");
  try {
    await registry.setGitRepo(owner, repo, JSON.stringify(collected));
  } catch (e) {
    console.error("syncToStrata failed:", e instanceof Error ? e.message : String(e));
  }
}

async function syncToNode(callNode: CallNode, nodeId: string, repo: string, localDir: string, relPrefix = ""): Promise<void> {
  const skipDirs = new Set(["hooks", "info"]);
  const skipFiles = new Set(["description"]);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(localDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relPrefix === "" ? e.name : `${relPrefix}/${e.name}`;
    const full = path.join(localDir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      void callNode(nodeId, "fs_mkdir", { repo, path: rel }).catch(() => { /* exists */ });
      await syncToNode(callNode, nodeId, repo, full, rel);
    } else {
      if (skipFiles.has(e.name)) continue;
      const data = fs.readFileSync(full);
      const chunkSize = 8192;
      let offset = 0;
      while (offset < data.length) {
        const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
        void callNode(nodeId, "fs_write", { repo, path: rel, offset, data: chunk.toString("base64") }).catch((err) =>
          console.error("syncToNode write failed:", (err as Error).message, rel),
        );
        offset += chunk.length;
      }
      if (data.length === 0) {
        void callNode(nodeId, "fs_write", { repo, path: rel, offset: 0, data: "" }).catch(() => {});
      }
    }
  }
}

function gitBin(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.resolve(here, "..", "..", "bin", "git");
    const gitCore = path.resolve(here, "..", "..", "bin", "git-core");
    if (fs.existsSync(bundled)) {
      if (fs.existsSync(gitCore) && !process.env.GIT_EXEC_PATH) {
        process.env.GIT_EXEC_PATH = gitCore;
      }
      return bundled;
    }
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
  nodeId: string | null,
  repo: string,
  service: "git-upload-pack" | "git-receive-pack",
  input: Buffer,
  registry?: NodeRegistry,
  owner?: string,
): Promise<Buffer> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "espresso-git-"));
  const repoDir = path.join(tmpRoot, repo);
  try {
    fs.mkdirSync(repoDir, { recursive: true });
    let fromStrata = false;
    if (registry && owner) {
      const paths = await registry.listGitFiles(owner, repo);
      if (paths.length > 0) {
        await syncFromStrata(registry, owner, repo, repoDir);
        fromStrata = true;
      }
    }
    if (!fromStrata && nodeId && service === "git-upload-pack") {
      await syncFromNode(callNode, nodeId, repo, repoDir);
    }
    if (!fs.existsSync(path.join(repoDir, "HEAD")) || !fs.existsSync(path.join(repoDir, "objects"))) {
      await runGit(["init", "--bare", repoDir], tmpRoot, Buffer.alloc(0)).catch(() => {});
    }
    const gitArgs = service === "git-upload-pack"
      ? ["upload-pack", "--stateless-rpc", repoDir]
      : ["receive-pack", "--stateless-rpc", repoDir];
    const output = await runGit(gitArgs, tmpRoot, input);
    if (service === "git-receive-pack") {
      if (registry && owner) {
        try {
          await syncToStrata(registry, owner, repo, repoDir);
        } catch (e) {
          console.error("syncToStrata failed:", (e as Error).message);
        }
      }
      if (nodeId) {
        void syncToNode(callNode, nodeId, repo, repoDir).catch((e) =>
          console.error("syncToNode failed:", (e as Error).message),
        );
      }
    }
    return output;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
