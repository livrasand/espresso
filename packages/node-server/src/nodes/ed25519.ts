// Ed25519 signature verification for node messages (port of
// internal/node/ws.go verifySignature). Raw 32-byte keys are wrapped into a
// DER SPKI via the standard ed25519 OID prefix.

import crypto from "node:crypto";

const RAW_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyNodeSignature(pubKeyHex: string, sigHex: string, payload: string): boolean {
  try {
    if (!/^[0-9a-fA-F]+$/.test(pubKeyHex) || !/^[0-9a-fA-F]+$/.test(sigHex)) return false;
    const key = Buffer.from(pubKeyHex, "hex");
    const sig = Buffer.from(sigHex, "hex");
    if (key.length !== 32) return false;
    if (sig.length !== 64) return false; // ed25519 signature is always 64 bytes
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([RAW_SPKI_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(payload, "utf8"), keyObject, sig);
  } catch {
    return false;
  }
}

/** Wire payload format: "<action>:<nodeID>:<tsMillis>". */
export function signedPayload(nodeId: string, tsMs: number, action: string): string {
  return `${action}:${nodeId}:${String(Math.floor(tsMs))}`;
}
