// RPC (port of internal/node/conn.go Call): enqueue a command into the
// node's Redis inbox and wait for the matching response, which the firmware
// delivers through POST /node/respond.

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
  /**
   * Performs a synchronous command/response round trip against the node's
   * polling loop. Callers must check `registry.isOnline(id)` first.
   */
  return async function callNode(id: string, action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const wait = Math.min(opts.rpcTimeoutMs, opts.maxWaitMs);
    const reqId = crypto.randomUUID();
    await registry.pushCommand(id, { req_id: reqId, action, ...params });

    const deadline = Date.now() + wait;
    // Poll-poll (250 ms) until the node drains the inbox and posts the
    // matching reply. Redis is the bus across working instances.
    while (Date.now() < deadline) {
      const resp = await registry.peekResponse(reqId);
      if (resp !== null) {
        if (resp["ok"] === false) {
          const err = typeof resp["error"] === "string" ? resp["error"] : "node error";
          throw new RpcError(`node error: ${err}`, 502);
        }
        return resp;
      }
      await sleep(250);
    }
    throw new RpcError(`timeout waiting for ${action} response`, 504);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
