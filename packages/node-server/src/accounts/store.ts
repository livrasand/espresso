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

  async create(): Promise<string> {
    const code = generateAccountNumber();
    await this.redis.set(`acct:${this.hash(code)}`, new Date().toISOString());
    return code;
  }

  async exists(code: string): Promise<boolean> {
    return this.redis.exists(`acct:${this.hash(this.normalize(code))}`);
  }
}

function generateAccountNumber(): string {
  const min = 10n ** 15n;
  const span = 9n * 10n ** 15n;
  let value: bigint;
  do {
    value = BigInt(`0x${crypto.randomBytes(16).toString("hex")}`) % span;
  } while (value === 0n);
  return (min + value).toString();
}
