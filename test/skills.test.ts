import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { login, postForm, publishMarkdown, resetDb, seedUser } from "./helpers";

// See test/db.test.ts for why `env` needs a local cast here.
const env = rawEnv as unknown as { DB: D1Database; BUCKET: R2Bucket };

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo Heading\n";
const OTHER_MD = "---\nname: other-skill\ndescription: Another skill.\n---\n\n# Other\n";

const publish = publishMarkdown;

const post = (path: string, cookie: string) => postForm(path, cookie);

describe("GET /", () => {
  beforeEach(resetDb);

  it("shows only public skills to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const html = await (await SELF.fetch("http://localhost/")).text();
    expect(html).toContain("demo-skill");
    expect(html).not.toContain("other-skill");
  });

  it("shows private skills to logged-in users", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, OTHER_MD, "private");
    const html = await (await SELF.fetch("http://localhost/", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("other-skill");
  });

  it("filters by query", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");
    const html = await (await SELF.fetch("http://localhost/?q=other")).text();
    expect(html).toContain("other-skill");
    expect(html).not.toContain(">demo-skill<");
  });
});

describe("GET /s/:slug", () => {
  beforeEach(resetDb);

  it("renders the stored html and the install command", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch("http://localhost/s/demo-skill", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Demo Heading");
    expect(html).toContain("SKILL.md");
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("shows the public install command to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const html = await (await SELF.fetch("http://localhost/s/demo-skill")).text();
    expect(html).toContain("npx skills add");
    expect(html).not.toContain("/i/");
  });

  it("hides a private skill from anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    expect((await SELF.fetch("http://localhost/s/other-skill")).status).toBe(404);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await SELF.fetch("http://localhost/s/nope")).status).toBe(404);
  });
});

describe("downloads", () => {
  beforeEach(resetDb);

  it("serves the latest version as an attachment", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), GOOD_MD, "public");
    const res = await SELF.fetch("http://localhost/s/demo-skill/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("demo-skill.zip");
  });

  it("serves a specific version", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch("http://localhost/s/demo-skill/v/1/download");
    expect(res.status).toBe(200);
  });

  it("refuses to serve a private skill to anonymous visitors", async () => {
    const { password } = await seedUser({ username: "alice" });
    await publish(await login("alice", password), OTHER_MD, "private");
    expect((await SELF.fetch("http://localhost/s/other-skill/download")).status).toBe(404);
  });
});

describe("visibility and deletion", () => {
  beforeEach(resetDb);

  it("toggles visibility", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "private");
    await post("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
    await post("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("deletes the skill and its r2 objects", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    await publish(cookie, GOOD_MD, "private");
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).not.toBeNull();
    const res = await post("/s/demo-skill/delete", cookie);
    expect(res.status).toBe(302);
    expect(await getSkill(env.DB, "demo-skill")).toBeNull();
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).toBeNull();
  });

  it("stops a member touching another user's skill", async () => {
    const alice = await seedUser({ username: "alice" });
    await publish(await login("alice", alice.password), GOOD_MD, "private");
    const bob = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", bob.password);
    expect((await post("/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await post("/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});
