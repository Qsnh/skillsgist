import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, listVersions } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

// Binary fixtures can't be read with `node:fs` from inside a pool-workers
// test: the worker's `node:fs` is a sandboxed, empty virtual filesystem with
// no bridge to the host disk. `vitest.config.ts` reads the real files from
// disk (it runs in plain Node) and exposes them here as `dataBlobBindings`.
// Same `Cloudflare.Env`-is-untyped local-cast pattern as test/normalize.test.ts.
const env = rawEnv as unknown as {
  DB: D1Database;
  BUCKET: R2Bucket;
  WRAPPED_ZIP: ArrayBuffer;
  FLAT_ZIP: ArrayBuffer;
  NO_SKILL_MD_ZIP: ArrayBuffer;
};

const fixture = (name: "WRAPPED_ZIP" | "FLAT_ZIP" | "NO_SKILL_MD_ZIP") => new Uint8Array(env[name]);

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

async function apiToken(cookie: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/me/api-token", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  const match = /sgt_[a-f0-9]{32}/.exec(await res.text());
  if (!match) throw new Error("no token issued");
  return match[0];
}

describe("PUT /api/skills/:slug", () => {
  beforeEach(resetDb);

  it("publishes a zip and stores the artifact in R2", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
      body: fixture("WRAPPED_ZIP"),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ slug: string; version: number; digest: string }>();
    expect(body.slug).toBe("demo-skill");
    expect(body.version).toBe(1);
    expect(body.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const object = await env.BUCKET.get("skills/demo-skill/1.zip");
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object!.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", stored);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(body.digest).toBe(`sha256:${hex}`);
  });

  it("stores rendered html alongside the version", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    const version = await getVersion(env.DB, "demo-skill", 1);
    expect(version?.html).toContain("<h1");
  });

  it("does not create a new version when content is unchanged", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const put = () =>
      SELF.fetch("http://localhost/api/skills/demo-skill", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: GOOD_MD,
      });
    expect((await put()).status).toBe(201);
    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true, version: 1 });
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(1);
  });

  it("creates version 2 when content changes", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const put = (md: string) =>
      SELF.fetch("http://localhost/api/skills/demo-skill", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: md,
      });
    await put(GOOD_MD);
    const res = await put(`${GOOD_MD}\nmore text\n`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2 });
  });

  it("rejects a slug that disagrees with the frontmatter name", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/other-name", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("demo-skill"),
    });
  });

  it("rejects requests without a valid api token", async () => {
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: "Bearer sgt_deadbeef", "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(404);
  });

  it("stops a member overwriting another user's skill", async () => {
    const alice = await seedUser({ username: "alice" });
    const aliceToken = await apiToken(await login("alice", alice.password));
    await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    const bob = await seedUser({ username: "bob", role: "member" });
    const bobToken = await apiToken(await login("bob", bob.password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "text/markdown" },
      body: `${GOOD_MD}\nbob was here\n`,
    });
    expect(res.status).toBe(403);
  });

  it("surfaces normalization errors as 400 with a reason", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
      body: fixture("NO_SKILL_MD_ZIP"),
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ message: string }>()).toMatchObject({
      message: expect.stringContaining("SKILL.md"),
    });
  });

  // Final-review Fix 1: an explicitly-supplied `?visibility=` must actually
  // apply, even when the skill already exists. `insertVersion`'s
  // ON CONFLICT clause intentionally never touches `visibility` (see F3 in
  // the ledger — that's what keeps a no-visibility edit from resetting a
  // public skill to private), but that same short-circuit was previously
  // discarding a visibility the caller *did* explicitly choose.
  it("applies an explicit visibility on republish even though the skill already exists", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const putWithVisibility = (md: string, visibility: string) =>
      SELF.fetch(`http://localhost/api/skills/demo-skill?visibility=${visibility}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: md,
      });
    await putWithVisibility(GOOD_MD, "public");
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");

    const res = await putWithVisibility(`${GOOD_MD}\nrepublish\n`, "private");
    expect(res.status).toBe(201);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  // Final-review Fix 1 (continued): omitting `?visibility` entirely on a
  // republish must mean "not supplied", not "supplied as private" — the
  // bug was that both cases collapsed to the same value at the call site.
  it("leaves visibility unchanged when an API republish omits ?visibility", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    await SELF.fetch("http://localhost/api/skills/demo-skill?visibility=public", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: `${GOOD_MD}\nno visibility param this time\n`,
    });
    expect(res.status).toBe(201);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  // Final-review Fix 2: a failed/missing R2 object for the current latest
  // version must be self-healed by republishing identical bytes, not
  // masked forever behind `{ unchanged: true }`. Simulates the failure by
  // deleting the R2 object directly, the same way an interrupted
  // `BUCKET.put` (R2 error, isolate killed at the CPU/memory limit) would
  // leave things.
  it("repairs a missing R2 object when republishing identical bytes", async () => {
    const { password } = await seedUser({ username: "alice" });
    const token = await apiToken(await login("alice", password));
    const put = () =>
      SELF.fetch("http://localhost/api/skills/demo-skill", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
        body: GOOD_MD,
      });

    const first = await put();
    expect(first.status).toBe(201);
    const { version } = await first.json<{ version: number }>();
    const versionRow = await getVersion(env.DB, "demo-skill", version);
    expect(versionRow).not.toBeNull();
    await env.BUCKET.delete(versionRow!.r2_key);
    expect(await env.BUCKET.get(versionRow!.r2_key)).toBeNull();

    const second = await put();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ unchanged: true });

    const repaired = await env.BUCKET.get(versionRow!.r2_key);
    expect(repaired).not.toBeNull();

    const cookie = await login("alice", password);
    const download = await SELF.fetch("http://localhost/s/demo-skill/download", { headers: { Cookie: cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/zip");
  });

  // Correction 1 (task-10 brief override): `versions.author_id` must record
  // who actually published a version, not who owns the skill — otherwise
  // the column is just a copy of `skills.owner_id` and can never show that
  // an admin published on someone else's behalf. Ownership itself must
  // stay put: `insertVersion`'s ON CONFLICT clause never touches owner_id.
  it("records the publisher as version author_id while leaving skill ownership untouched", async () => {
    const member = await seedUser({ username: "carol", role: "member" });
    const memberToken = await apiToken(await login("carol", member.password));
    await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });

    const admin = await seedUser({ username: "root-admin", role: "admin" });
    const adminToken = await apiToken(await login("root-admin", admin.password));
    const res = await SELF.fetch("http://localhost/api/skills/demo-skill", {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "text/markdown" },
      body: `${GOOD_MD}\nadmin republish\n`,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ version: number }>();
    expect(body.version).toBe(2);

    const skill = await getSkill(env.DB, "demo-skill");
    expect(skill?.owner_id).toBe(member.user.id);

    const version = await getVersion(env.DB, "demo-skill", 2);
    expect(version?.author_id).toBe(admin.user.id);
  });
});

describe("POST /new", () => {
  beforeEach(resetDb);

  it("publishes an uploaded file", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("file", new File([fixture("FLAT_ZIP")], "flat.zip", { type: "application/zip" }));
    form.set("visibility", "public");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/s/demo-skill");
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });

  it("publishes pasted markdown", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", GOOD_MD);
    form.set("visibility", "private");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("re-renders the form with the reason on failure", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", "---\nname: Bad_Name\ndescription: x\n---\nbody");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("name");
  });

  it("requires a login", async () => {
    const res = await SELF.fetch("http://localhost/new", { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  // Final-review Fix 1: this is the exact failure scenario from the review
  // — alice publishes a skill as public, then republishes through /new with
  // "private" selected, and it must actually go private (previously it
  // stayed public silently, with a 302 success and no warning).
  it("applies visibility=private on republish even though the skill was already public", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);

    const first = new FormData();
    first.set("markdown", GOOD_MD);
    first.set("visibility", "public");
    await SELF.fetch("http://localhost/new", { method: "POST", headers: { Cookie: cookie }, body: first, redirect: "manual" });
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");

    const second = new FormData();
    second.set("markdown", `${GOOD_MD}\nrepublished\n`);
    second.set("visibility", "private");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: second, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("keeps visibility=public on republish through /new when selected again", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);

    const first = new FormData();
    first.set("markdown", GOOD_MD);
    first.set("visibility", "public");
    await SELF.fetch("http://localhost/new", { method: "POST", headers: { Cookie: cookie }, body: first, redirect: "manual" });

    const second = new FormData();
    second.set("markdown", `${GOOD_MD}\nrepublished again\n`);
    second.set("visibility", "public");
    const res = await SELF.fetch("http://localhost/new", {
      method: "POST", headers: { Cookie: cookie }, body: second, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });
});

describe("POST /s/:slug/edit", () => {
  beforeEach(resetDb);

  it("saves edited markdown as a new version", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", GOOD_MD);
    await SELF.fetch("http://localhost/new", { method: "POST", headers: { Cookie: cookie }, body: form });

    const edit = new FormData();
    edit.set("markdown", `${GOOD_MD}\nedited\n`);
    const res = await SELF.fetch("http://localhost/s/demo-skill/edit", {
      method: "POST", headers: { Cookie: cookie }, body: edit, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(await listVersions(env.DB, "demo-skill")).toHaveLength(2);
  });

  // Final-review Fix 1: the edit path must never pass a visibility at all,
  // so a public skill stays public across an edit-triggered republish
  // (this is the "fails open" side of the review finding — the edit path
  // itself was always correct, but had no regression test pinning it).
  it("does not change visibility when republishing through the edit path", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const form = new FormData();
    form.set("markdown", GOOD_MD);
    form.set("visibility", "public");
    await SELF.fetch("http://localhost/new", { method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual" });

    const edit = new FormData();
    edit.set("markdown", `${GOOD_MD}\nedited\n`);
    const res = await SELF.fetch("http://localhost/s/demo-skill/edit", {
      method: "POST", headers: { Cookie: cookie }, body: edit, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
  });
});
