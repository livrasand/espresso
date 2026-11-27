import crypto from "node:crypto";
import type { NodeRegistry } from "./registry.js";

export class RpcError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function makeRpc(registry: NodeRegistry, opts: { rpcTimeoutMs: number; maxWaitMs: number }) {
  return async function callNode(id: string, action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const wait = Math.min(opts.rpcTimeoutMs, opts.maxWaitMs);
    const reqId = crypto.randomUUID();
    await registry.pushCommand(id, { req_id: reqId, action, ...params });

    const deadline = Date.now() + wait;
    let delay = 120;
    while (Date.now() < deadline) {
      const resp = await registry.peekResponse(reqId);
      if (resp !== null) {
        if (resp["ok"] === false) {
          const err = typeof resp["error"] === "string" ? resp["error"] : "node error";
          throw new RpcError(`node error: ${err}`, 502);
        }
        return resp;
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 1.5, 400);
    }
    throw new RpcError(`timeout waiting for ${action} response`, 504);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
