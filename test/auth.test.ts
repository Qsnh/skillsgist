import { describe, expect, it } from "vitest";
import {
  canManage, hashPassword, PBKDF2_ITERATIONS, randomHex, verifyPassword,
} from "../src/auth";
import { sha256Hex } from "../src/hash";
import type { SkillRow, UserRow } from "../src/db/queries";

const user = (over: Partial<UserRow> = {}): UserRow => ({
  id: "u1", username: "alice", password_hash: "h", role: "member",
  install_key: "k", api_token_hash: null, created_at: 0, last_login_at: null, ...over,
});

const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  slug: "demo", description: "d", visibility: "private", owner_id: "u1",
  latest_version: 1, download_count: 0, created_at: 0, updated_at: 0, ...over,
});

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong password xx", stored)).toBe(false);
  });

  it("encodes scheme, iterations, salt and hash", async () => {
    const stored = await hashPassword("correct horse battery");
    const parts = stored.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts).toHaveLength(4);
  });

  it("uses a fresh salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
  });

  it("verifies hashes stored with a different iteration count", async () => {
    const stored = await hashPassword("correct horse battery", 1000);
    expect(stored).toContain("$1000$");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("randomHex", () => {
  it("returns the requested number of bytes as hex", () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("canManage", () => {
  it("lets an owner manage their own skill", () => {
    expect(canManage(user({ id: "u1" }), skill({ owner_id: "u1" }))).toBe(true);
  });

  it("stops a member managing someone else's skill", () => {
    expect(canManage(user({ id: "u2" }), skill({ owner_id: "u1" }))).toBe(false);
  });

  it("lets an admin manage anything", () => {
    expect(canManage(user({ id: "u2", role: "admin" }), skill({ owner_id: "u1" }))).toBe(true);
  });
});
