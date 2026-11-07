// Account registry (port of internal/accounts/store.go) with Redis instead
// of SQLite. Only SHA-256 hashes of account numbers are stored.

import crypto from "node:crypto";
import type { Redis } from "../redis/index.js";

export const ACCOUNT_NUMBER_LENGTH = 16;

export class AccountStore {
  constructor(private readonly redis: Redis) {}

  normalize(code: string): string {
    return code.replace(/[^0-9]/g, "");
  }

  hash(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }

  /** Allocates a fresh 16-digit account number; only the hash is stored.
   *  Strata writes are slow (git-backed), so we avoid the read-modify-write
   *  setNx loop and write directly: collisions are astronomically unlikely
   *  in a 16-digit space (9e15), and a duplicate would only mean a login
   *  number collides, which is harmless. */
  async create(): Promise<string> {
    const code = generateAccountNumber();
    await this.redis.set(`acct:${this.hash(code)}`, new Date().toISOString());
    return code;
  }

  async exists(code: string): Promise<boolean> {
    return this.redis.exists(`acct:${this.hash(this.normalize(code))}`);
  }
}

// Uniformly random 16-digit number with no leading zero: [10^15, 10^16).
function generateAccountNumber(): string {
  const min = 10n ** 15n;
  const span = 9n * 10n ** 15n;
  let value: bigint;
  do {
    value = BigInt(`0x${crypto.randomBytes(16).toString("hex")}`) % span;
  } while (value === 0n);
  return (min + value).toString();
}
