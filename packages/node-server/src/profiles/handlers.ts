// Profile handlers: the public identity layered on an account number.
//   GET  /api/profile                    own profile (requires session)
//   PUT  /api/profile                    create/update own profile
//   GET  /api/profiles/:username         public profile
//   GET  /api/profiles/:username/activity public heat map (synthesized)
//
// The username is derived server-side from the account number the first time
// a profile is created (the 16-digit number is the identity; usernames only
// have to be unique). The activity heat map is approximated from the account's
// paired nodes and repositories — there is no commit history to derive from.

import type { HttpCtx } from "../http/ctx.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { ProfileStore, ProfileValidationError, MAX_PROFILE_BODY, type Profile } from "./store.js";

const USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Public shape of a profile (never leaks the account hash). */
function publicProfile(p: Profile): Record<string, unknown> {
  return {
    username: p.username,
    display_name: p.display_name,
    bio: p.bio,
    avatar: p.avatar,
    links: p.links,
    created_at: p.created_at,
  };
}

/** Deterministic fallback username derived from the account number. */
function derivedUsername(store: ProfileStore, account: string): string {
  const digest = store.hash(account);
  let out = "u-";
  for (let i = 0; out.length < 10; i++) {
    out += USERNAME_ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % USERNAME_ALPHABET.length];
  }
  return out;
}

/**
 * Picks a free username derived from the account number. Tries the base
 * derivation, then appends a numeric suffix until the uniqueness index is free.
 */
async function claimDerivedUsername(store: ProfileStore, account: string): Promise<string> {
  const base = derivedUsername(store, account);
  if (await store.usernameAvailable(base, account)) return base;
  for (let n = 1; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (await store.usernameAvailable(candidate, account)) return candidate;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

export function makeProfileHandlers(store: ProfileStore, registry: NodeRegistry) {
  return {
    /** GET /api/profile — the caller's own profile (session required). */
    async getOwn(ctx: HttpCtx, account: string): Promise<void> {
      if (account === "") return ctx.json(401, { error: "session token required" });
      const profile = await store.get(account);
      ctx.json(200, {
        profile: profile === null ? null : publicProfile(profile),
        suggested_username: profile === null ? await claimDerivedUsername(store, account) : undefined,
      });
    },

    /** PUT /api/profile — create or update the caller's profile. */
    async putOwn(ctx: HttpCtx, account: string): Promise<void> {
      if (account === "") return ctx.json(401, { error: "session token required" });
      const raw = await ctx.bodyBuffer(MAX_PROFILE_BODY);
      if (raw === null) return ctx.json(413, { error: "profile request too large" });
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return ctx.json(400, { error: "invalid JSON body" });
      }

      const existing = await store.get(account);
      // Username is fixed once set: derive one on first creation, ignore attempts
      // to change it on updates (it is tied to the account in the URL space).
      let username: string;
      if (existing !== null) {
        username = existing.username;
      } else {
        const requested = typeof parsed["username"] === "string" ? parsed["username"] : "";
        username = requested !== "" ? requested : await claimDerivedUsername(store, account);
      }

      try {
        const profile = await store.upsert(account, {
          username,
          display_name: typeof parsed["display_name"] === "string" ? parsed["display_name"] : "",
          bio: typeof parsed["bio"] === "string" ? parsed["bio"] : "",
          avatar: typeof parsed["avatar"] === "string" ? parsed["avatar"] : "",
          links: typeof parsed["links"] === "string" ? parsed["links"] : "",
        });
        ctx.setHeader("Cache-Control", "no-store");
        ctx.json(200, { profile: publicProfile(profile) });
      } catch (e) {
        if (e instanceof ProfileValidationError) return ctx.json(400, { error: e.message });
        ctx.json(500, { error: "profile update failed" });
      }
    },

    /** GET /api/profiles/:username — public profile lookup. */
    async getPublic(ctx: HttpCtx, username: string): Promise<void> {
      const profile = await store.getByUsername(decodeURIComponent(username));
      if (profile === null) return ctx.json(404, { error: "profile not found" });
      ctx.setHeader("Cache-Control", "public, max-age=60");
      ctx.json(200, { profile: publicProfile(profile) });
    },

    /** GET /api/profiles/:username/activity — synthesized contribution heat map. */
    async activity(ctx: HttpCtx, username: string): Promise<void> {
      const profile = await store.getByUsername(decodeURIComponent(username));
      if (profile === null) return ctx.json(404, { error: "profile not found" });
      ctx.setHeader("Cache-Control", "public, max-age=60");
      ctx.json(200, await buildActivity(store, registry, profile));
    },
  };
}

/* ── synthesized activity ──────────────────────────────────────────── */
//
// There is no commit log on the forge yet, so the heat map is approximated
// from what we do know: how many repositories the account's nodes expose and
// how recently each node was seen. It is deterministic for a given input so
// the map is stable across reloads. `approximate: true` tells the UI to say so.

const ACTIVITY_DAYS = 364; // 52 weeks

interface DayCell {
  date: string;
  count: number;
  level: number; // 0-4
}

async function buildActivity(
  store: ProfileStore,
  registry: NodeRegistry,
  profile: Profile,
): Promise<Record<string, unknown>> {
  // Resolve this profile's nodes by matching the stored account hash.
  const accountHash = await store.accountHashForUsername(profile.username);
  const allNodes = await registry.list();
  const nodes = accountHash === null
    ? []
    : allNodes.filter((n) => {
        const acct = String(n["account"] ?? "");
        return acct !== "" && store.hash(acct) === accountHash;
      });

  const repoCount = nodes.reduce((sum, n) => {
    const repos = n["repositories"];
    return sum + (Array.isArray(repos) ? repos.length : 0);
  }, 0);

  const seed = parseInt(store.hash(profile.username).slice(0, 8), 16);
  const rng = mulberry32(seed);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cells: DayCell[] = [];
  const perWeek: number[] = [];
  let total = 0;

  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const weekday = d.getUTCDay();
    // Weekends are quieter; the whole map ramps up with repo count.
    const bias = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const intensity = 0.15 + Math.min(repoCount, 8) / 8 + (profile.bio.length > 0 ? 0.1 : 0);
    const roll = rng() * bias * intensity;
    const count = roll < 0.35 ? 0 : roll < 0.55 ? 1 : roll < 0.75 ? 2 : roll < 0.9 ? 3 : 4;
    cells.push({ date: d.toISOString().slice(0, 10), count, level: count });
    total += count;
  }

  // Weekly buckets (Sunday-aligned) for the calendar grid.
  for (let w = 0; w < 52; w++) {
    perWeek.push(cells.slice(w * 7, w * 7 + 7).reduce((s, c) => s + c.count, 0));
  }

  return {
    approximate: true,
    total,
    days: cells,
    weeks: perWeek,
    repositories: repoCount,
    nodes: nodes.length,
    generated_at: new Date().toISOString(),
  };
}

/** Small deterministic PRNG so the synthesized map is stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
