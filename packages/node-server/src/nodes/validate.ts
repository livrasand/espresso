// Input validation (port of safeRepo/safePath/validNodeName/isSafeNodeID
// from internal/node).

const VALID_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VALID_REL_PATH = /^[A-Za-z0-9._/@{}:+,-]{1,512}$/;

export function safeRepo(name: string): boolean {
  return name !== "" && !name.includes("..") && VALID_REPO.test(name);
}

export function safePath(p: string): boolean {
  if (p === "") return true;
  if (p.startsWith("/") || p.includes("..") || p.includes("\\")) return false;
  return VALID_REL_PATH.test(p);
}

export function normalizeNodeId(id: string): string {
  return id.trim().toUpperCase();
}

export function isSafeNodeID(id: string): boolean {
  return id.length >= 8 && id.length <= 32 && /^[0-9A-F]+$/.test(id);
}

/** Guards against control characters in device-reported names. */
export function validNodeName(name: string): boolean {
  if (name === "" || name.length > 64) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

export function asScalarNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}
