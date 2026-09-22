import { env as rawEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as q from "../src/db/queries";

// `cloudflare:test`'s `env` types as the ambient `Cloudflare.Env` (an empty
// interface until `wrangler types` wires up project-specific bindings, which
// is out of scope here — see task-1-report.md deviation #5 for the same issue
// in test/setup.ts). Local cast only; runtime behavior is unaffected.
const env = rawEnv as unknown as { DB: D1Database };

async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM versions"),
    env.DB.prepare("DELETE FROM skills"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

const base = {
  digest: "sha256:" + "a".repeat(64),
  size: 100,
  name: "demo",
  description: "a demo skill",
  skill_md: "---\nname: demo\ndescription: a demo skill\n---\nbody",
  html: "<p>body</p>",
  files: JSON.stringify([{ path: "SKILL.md", size: 10 }]),
};

describe("queries", () => {
  beforeEach(reset);

  it("counts users and round-trips one", async () => {
    expect(await q.countUsers(env.DB)).toBe(0);
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    expect(await q.countUsers(env.DB)).toBe(1);
    const byName = await q.getUserByUsername(env.DB, "alice");
    expect(byName?.id).toBe("u1");
    expect(await q.getUserByInstallKey(env.DB, "k1")).not.toBeNull();
    expect(await q.getUserByInstallKey(env.DB, "nope")).toBeNull();
  });

  it("allocates version numbers monotonically per slug", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    const v1 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
    });
    const v2 = await q.insertVersion(env.DB, {
      ...base, slug: "demo", authorId: "u1", visibility: "private",
      digest: "sha256:" + "b".repeat(64),
    });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    const skill = await q.getSkill(env.DB, "demo");
    expect(skill?.latest_version).toBe(2);
    expect(await q.listVersions(env.DB, "demo")).toHaveLength(2);
  });

  it("hides private skills from the public index", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    await q.insertVersion(env.DB, { ...base, slug: "secret", authorId: "u1", visibility: "private" });
    await q.insertVersion(env.DB, {
      ...base, slug: "shared", authorId: "u1", visibility: "public",
      digest: "sha256:" + "c".repeat(64),
    });
    const pub = await q.listPublishedForIndex(env.DB, false);
    expect(pub.map((s) => s.slug)).toEqual(["shared"]);
    const all = await q.listPublishedForIndex(env.DB, true);
    expect(all.map((s) => s.slug).sort()).toEqual(["secret", "shared"]);
  });

  it("returns r2 keys when deleting a skill", async () => {
    await q.createUser(env.DB, {
      id: "u1", username: "alice", passwordHash: "h", role: "admin", installKey: "k1",
    });
    await q.insertVersion(env.DB, { ...base, slug: "demo", authorId: "u1", visibility: "private" });
    const keys = await q.deleteSkill(env.DB, "demo");
    expect(keys).toEqual(["skills/demo/1.zip"]);
    expect(await q.getSkill(env.DB, "demo")).toBeNull();
  });
});
