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

  private async readProfile(accountHash: string): Promise<Profile | null> {
    const raw = await this.redis.get(`profile:${accountHash}`);
    if (raw === null) return null;
    try {
      const rec = JSON.parse(raw) as Record<string, unknown>;
      if (typeof rec["username"] !== "string") return null;
      return {
        username: rec["username"],
        display_name: typeof rec["display_name"] === "string" ? rec["display_name"] : "",
        bio: typeof rec["bio"] === "string" ? rec["bio"] : "",
        avatar: typeof rec["avatar"] === "string" ? rec["avatar"] : "",
        links: typeof rec["links"] === "string" ? rec["links"] : "",
        created_at: typeof rec["created_at"] === "string" ? rec["created_at"] : "",
      };
    } catch {
      return null;
    }
  }

  async get(account: string): Promise<Profile | null> {
    return this.readProfile(this.hash(account));
  }

  async getByUsername(username: string): Promise<Profile | null> {
    const u = this.normalizeUsername(username);
    const owner = await this.redis.get(`names:${u}`);
    if (owner === null) return null;
    return this.readProfile(owner);
  }

  async accountHashForUsername(username: string): Promise<string | null> {
    const u = this.normalizeUsername(username);
    return this.redis.get(`names:${u}`);
  }

  async usernameAvailable(username: string, account: string): Promise<boolean> {
    const u = this.normalizeUsername(username);
    const owner = await this.redis.get(`names:${u}`);
    if (owner === null) return true;
    return owner === this.hash(account);
  }

  async upsert(account: string, input: ProfileInput): Promise<Profile> {
    const username = this.validateUsername(input.username ?? "");
    const display_name = (input.display_name ?? "").trim().slice(0, DISPLAY_NAME_MAX);
    const bio = (input.bio ?? "").trim().slice(0, BIO_MAX);
    const avatar = normalizeAvatar(input.avatar ?? "");
    const links = normalizeLinks(input.links ?? "");

    const existing = await this.get(account);
    const accountHash = this.hash(account);

    const claimed = await this.redis.setNx(`names:${username}`, accountHash);
    if (claimed !== 1 && (await this.redis.get(`names:${username}`)) !== accountHash) {
      throw new ProfileValidationError("username already taken");
    }
    if (existing !== null && existing.username !== username) {
      await this.redis.del(`names:${existing.username}`);
    }

    const created_at = existing?.created_at || new Date().toISOString();
    const profile: Profile = { username, display_name, bio, avatar, links, created_at };
    await this.redis.set(`profile:${accountHash}`, JSON.stringify(profile));

    return profile;
  }
}

function normalizeLinks(links: string): string {
  return links.trim().slice(0, 500);
}

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
