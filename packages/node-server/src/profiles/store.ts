// Profile store over Redis: the public identity layered on top of an account
// number. Keyed by the account hash so it never touches the raw number.
//   profile:<sha256(account)>  hash {username, display_name, bio, avatar, created_at}
//   names:<username>           string account hash (uniqueness index)
//
// The avatar is a data URL stored inline (capped) so a profile is a single
// Redis read with no object storage dependency.

import crypto from "node:crypto";
import type { Redis } from "../redis/index.js";

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 64;
export const BIO_MAX = 280;
export const AVATAR_MAX_BYTES = 64 * 1024;
export const MAX_PROFILE_BODY = AVATAR_MAX_BYTES + 16 * 1024;

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set([
  "api",
  "dashboard",
  "login",
  "profile",
  "profiles",
  "health",
  "metrics",
  "node",
  "nodes",
  "admin",
  "settings",
  "about",
]);

export interface Profile {
  username: string;
  display_name: string;
  bio: string;
  avatar: string;
  links: string;
  created_at: string;
}

export interface ProfileInput {
  username?: string;
  display_name?: string;
  bio?: string;
  avatar?: string;
  links?: string;
}

export class ProfileValidationError extends Error {}

export class ProfileStore {
  constructor(private readonly redis: Redis) {}

  hash(account: string): string {
    return crypto.createHash("sha256").update(account).digest("hex");
  }

  normalizeUsername(raw: string): string {
    return raw.trim().toLowerCase();
  }

  /** Validates and canonicalizes a username or throws ProfileValidationError. */
  validateUsername(raw: string): string {
    const u = this.normalizeUsername(raw);
    if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) {
      throw new ProfileValidationError(`username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`);
    }
    if (!USERNAME_RE.test(u)) {
      throw new ProfileValidationError("username may contain only a-z, 0-9 and hyphens (no leading/trailing hyphen)");
    }
    if (RESERVED.has(u)) {
      throw new ProfileValidationError("username is reserved");
    }
    return u;
  }

  /** Reads the profile hash for an account; null when unset. */
  async get(account: string): Promise<Profile | null> {
    const rec = await this.redis.hgetall(`profile:${this.hash(account)}`);
    if (rec["username"] === undefined) return null;
    return {
      username: rec["username"],
      display_name: rec["display_name"] ?? "",
      bio: rec["bio"] ?? "",
      avatar: rec["avatar"] ?? "",
      links: rec["links"] ?? "",
      created_at: rec["created_at"] ?? "",
    };
  }

  /** Resolves a username to its profile; null when unknown. */
  async getByUsername(username: string): Promise<Profile | null> {
    const u = this.normalizeUsername(username);
    const owner = await this.redis.get(`names:${u}`);
    if (owner === null) return null;
    const rec = await this.redis.hgetall(`profile:${owner}`);
    if (rec["username"] === undefined) return null;
    return {
      username: rec["username"],
      display_name: rec["display_name"] ?? "",
      bio: rec["bio"] ?? "",
      avatar: rec["avatar"] ?? "",
      links: rec["links"] ?? "",
      created_at: rec["created_at"] ?? "",
    };
  }

  /** Resolves a username to the owning account hash; null when unknown. */
  async accountHashForUsername(username: string): Promise<string | null> {
    const u = this.normalizeUsername(username);
    return this.redis.get(`names:${u}`);
  }

  /** True when a username is not yet claimed by any account. */
  async usernameAvailable(username: string, account: string): Promise<boolean> {
    const u = this.normalizeUsername(username);
    const owner = await this.redis.get(`names:${u}`);
    if (owner === null) return true;
    return owner === this.hash(account);
  }

  /**
   * Creates or updates the profile for an account. Username uniqueness is
   * enforced through a `setNx` index write; a changed username releases the
   * previous claim. Returns the stored profile.
   */
  async upsert(account: string, input: ProfileInput): Promise<Profile> {
    const username = this.validateUsername(input.username ?? "");
    const display_name = (input.display_name ?? "").trim().slice(0, DISPLAY_NAME_MAX);
    const bio = (input.bio ?? "").trim().slice(0, BIO_MAX);
    const avatar = normalizeAvatar(input.avatar ?? "");
    const links = normalizeLinks(input.links ?? "");

    const existing = await this.get(account);
    const key = `profile:${this.hash(account)}`;

    if (existing === null || existing.username !== username) {
      const claimed = await this.redis.setNx(`names:${username}`, this.hash(account));
      if (claimed !== 1) throw new ProfileValidationError("username already taken");
      if (existing !== null && existing.username !== username) {
        await this.redis.del(`names:${existing.username}`);
      }
    }

    await this.redis.hset(key, "username", username);
    await this.redis.hset(key, "display_name", display_name);
    await this.redis.hset(key, "bio", bio);
    await this.redis.hset(key, "avatar", avatar);
    await this.redis.hset(key, "links", links);
    await this.redis.hset(key, "created_at", existing?.created_at || new Date().toISOString());

    return { username, display_name, bio, avatar, links, created_at: existing?.created_at || new Date().toISOString() };
  }
}

function normalizeLinks(links: string): string {
  return links.trim().slice(0, 500);
}

/** Accepts image data URLs or http(s) image URLs; else empty string. */
function normalizeAvatar(avatar: string): string {
  if (avatar === "") return "";
  if (/^https?:\/\//i.test(avatar)) {
    if (avatar.length > AVATAR_MAX_BYTES) throw new ProfileValidationError("avatar URL too long");
    return avatar;
  }
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
    throw new ProfileValidationError("avatar must be an image data URL or http(s) URL");
  }
  if (avatar.length > AVATAR_MAX_BYTES) {
    throw new ProfileValidationError("avatar too large");
  }
  return avatar;
}
