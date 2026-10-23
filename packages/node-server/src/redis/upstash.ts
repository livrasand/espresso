// Upstash Redis via its REST (POST command-array) protocol. Zero runtime
// dependencies: plain fetch + JSON.

import type { RedisLike, RedisReply } from "./index.js";

export class UpstashBackend implements RedisLike {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async exec(command: (string | number)[]): Promise<RedisReply> {
    const url = this.baseUrl.replace(/\/+$/, "");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      throw new Error(`upstash redis ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    }
    const body = (await res.json()) as { result?: RedisReply; error?: string };
    if (body.error) throw new Error(`upstash redis error: ${body.error}`);
    return body.result ?? null;
  }
}
