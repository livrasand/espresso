import crypto from "node:crypto";

const RAW_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyNodeSignature(pubKeyHex: string, sigHex: string, payload: string): boolean {
  try {
    if (!/^[0-9a-fA-F]+$/.test(pubKeyHex) || !/^[0-9a-fA-F]+$/.test(sigHex)) return false;
    const key = Buffer.from(pubKeyHex, "hex");
    const sig = Buffer.from(sigHex, "hex");
    if (key.length !== 32) return false;
    if (sig.length !== 64) return false;
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

export function signedPayload(nodeId: string, tsMs: number, action: string): string {
  return `${action}:${nodeId}:${String(Math.floor(tsMs))}`;
}
