// Shared helper for normalizing node-reported repo entries.

import type { RepoEntry } from "./registry.js";
import { asScalarNumber } from "./validate.js";

export function asRepoEntry(v: unknown): RepoEntry {
  const obj = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const name = typeof obj["name"] === "string" ? obj["name"] : "";
  const size = asScalarNumber(obj["size"]);
  return { name, size: Math.floor(size) };
}
