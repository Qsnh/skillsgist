import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getProject, getSkill } from "../src/db/queries";
import {
  env, follow, GOOD_MD, installKey, ORIGIN, OTHER_MD, postForm, publishMarkdown as publish, resetDb, seedAndLogin,
  seedProject, seedUser,
} from "./helpers";

const get = (path: string, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });

const membership = (project: string, userId: string) =>
  env.DB.prepare("SELECT role, install_key FROM memberships WHERE project = ? AND user_id = ?")
    .bind(project, userId)
    .first<{ role: string; install_key: string }>();

const indexStatus = async (key: string) =>
  (await SELF.fetch(`${ORIGIN}/i/${key}/.well-known/agent-skills/index.json`)).status;

describe("/projects", () => {
  beforeEach(resetDb);

  it("redirects anonymous visitors to /login", async () => {
    const res = await get("/projects");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("lists only the projects a member is in, by name", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "alice", role: "member" });
    const html = await (await get("/projects", cookie)).text();
    expect(html).toContain('<a href="/p/default" class="cf-link cf-user-name">Default</a>');
    expect(html).not.toContain('href="/p/team-b"');
    expect(html).not.toContain('href="/projects/new"');
  });

  it("lists every project for an instance admin and offers New project", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin", project: null });
    const html = await (await get("/projects", cookie)).text();
    expect(html).toContain('href="/p/default"');
    expect(html).toContain('href="/p/team-b"');
    expect(html).toContain('href="/projects/new"');
  });

  it("is linked from the account menu", async () => {
    const { cookie } = await seedAndLogin({ username: "alice", role: "member" });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('<a href="/projects" class="cf-menu-item">Projects</a>');
  });
});

describe("/projects/new", () => {
  beforeEach(resetDb);

  it("lets an instance admin create a project, without joining it", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/projects/new", cookie, { name: "  Team B  ", slug: "team-b" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/team-b");
    expect(await getProject(env.DB, "team-b")).toMatchObject({ slug: "team-b", name: "Team B" });
    expect((await get("/p/team-b", cookie)).status).toBe(200);
    expect(await membership("team-b", user.id)).toBeNull();
  });

  it.each([
    ["an empty name", { name: "   ", slug: "team-b" }, "Project names must be 1-64 characters on one line"],
    ["a malformed address", { name: "Team B", slug: "Team B!" }, "Addresses must be 2-32 lowercase letters, digits or hyphens"],
    ["a taken address", { name: "Team B", slug: "default" }, "That address is taken"],
    ["a taken name in other letter case", { name: "DEFAULT", slug: "team-b" }, "That name is taken"],
  ])("re-renders with an error for %s", async (_label, fields, error) => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/projects/new", cookie, fields);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(error);
    expect(html).toContain(`value="${fields.slug}"`);
    expect(await getProject(env.DB, "team-b")).toBeNull();
  });

  it("is for instance admins only", async () => {
    const { cookie } = await seedAndLogin({ username: "bob", role: "member", projectRole: "admin" });
    expect((await get("/projects/new", cookie)).status).toBe(403);
    expect((await postForm("/projects/new", cookie, { name: "Team B", slug: "team-b" })).status).toBe(403);
  });
});

describe("/p/:project", () => {
  beforeEach(resetDb);

  it("404s a project with no public skills for someone outside it, and an unknown project", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "alice", role: "member" });
    expect((await get("/p/team-b", cookie)).status).toBe(404);
    expect((await get("/p/team-b")).status).toBe(404);
    expect((await get("/p/nope", cookie)).status).toBe(404);
  });

  it("shows anyone the public part of a project that has public skills", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");
    const res = await get("/p/default");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Default");
    expect(html).toContain(`npx skills add ${ORIGIN}/p/default`);
    expect(html).toContain('href="/p/default/s/demo-skill"');
    expect(html).not.toContain("other-skill");
    expect(html).not.toContain("alice");
  });

  it("shows a member their install command, every skill and the members, with no controls", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await seedUser({ username: "bob", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private");
    const html = await (await get("/p/default", alice.cookie)).text();
    expect(html).toContain(`npx skills add ${ORIGIN}/i/${await installKey(alice.user.id)}`);
    expect(html).toContain('href="/p/default/s/demo-skill"');
    expect(html).toContain("bob");
    expect(html).not.toContain('action="/p/default/members"');
    expect(html).not.toContain('action="/p/default/rename"');
    expect(html).not.toContain("/remove");
    expect(html).not.toContain('action="/p/default/delete"');
  });

  it("gives a project admin the member and rename controls but not project deletion", async () => {
    const lead = await seedAndLogin({ username: "lead", role: "member", projectRole: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });
    await seedUser({ username: "carol", role: "member", project: null });
    const html = await (await get("/p/default", lead.cookie)).text();
    expect(html).toContain('action="/p/default/members"');
    expect(html).toContain(`action="/p/default/members/${bob.id}/role"`);
    expect(html).toContain(`action="/p/default/members/${bob.id}/remove"`);
    expect(html).toContain('action="/p/default/rename"');
    expect(html).toContain(">carol</option>");
    expect(html).not.toContain(">bob</option>");
    expect(html).not.toContain('action="/p/default/delete"');
  });

  it("tells an instance admin outside the project that they have no key for it", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const html = await (await get("/p/team-b", cookie)).text();
    expect(html).toContain("You are not a member of Team B, so you have no install key for it.");
    expect(html).not.toContain("npx skills add");
    expect(html).toContain(">root</option>");
    expect(html).toContain('action="/p/team-b/delete"');
  });
});

describe("renaming a project", () => {
  beforeEach(resetDb);

  it("lets a project admin rename it, keeping its address and keys", async () => {
    const lead = await seedAndLogin({ username: "lead", role: "member", projectRole: "admin" });
    const key = await installKey(lead.user.id);
    const res = await postForm("/p/default/rename", lead.cookie, { name: "Platform" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/default");
    expect(await (await follow(res, lead.cookie)).text()).toContain("Renamed the project to Platform.");
    expect((await getProject(env.DB, "default"))?.name).toBe("Platform");
    expect(await installKey(lead.user.id)).toBe(key);
    expect(await indexStatus(key)).toBe(200);
  });

  it("refuses an empty name or one another project has", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const empty = await postForm("/p/default/rename", cookie, { name: " " });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Project names must be 1-64 characters on one line");
    const taken = await postForm("/p/default/rename", cookie, { name: "team b" });
    expect(taken.status).toBe(400);
    expect(await taken.text()).toContain("That name is taken");
    expect((await getProject(env.DB, "default"))?.name).toBe("Default");
  });

  it("allows changing only the letter case of the project's own name", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    expect((await postForm("/p/default/rename", cookie, { name: "DEFAULT" })).status).toBe(302);
    expect((await getProject(env.DB, "default"))?.name).toBe("DEFAULT");
  });

  it("is refused to a plain member", async () => {
    const { cookie } = await seedAndLogin({ username: "alice", role: "member" });
    expect((await postForm("/p/default/rename", cookie, { name: "Mine" })).status).toBe(403);
    expect((await getProject(env.DB, "default"))?.name).toBe("Default");
  });
});

describe("project membership", () => {
  beforeEach(resetDb);

  it("lets a project admin add an account, whose new key works at once", async () => {
    await seedProject("team-b", "Team B");
    const lead = await seedAndLogin({ username: "lead", role: "member", project: "team-b", projectRole: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });

    const res = await postForm("/p/team-b/members", lead.cookie, { user: bob.id, role: "member" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/team-b");
    const html = await (await follow(res, lead.cookie)).text();
    expect(html).toMatch(/<p class="cf-done" role="status">[\s\S]*?Added bob to Team B\.<\/span><\/p>/);

    const row = await membership("team-b", bob.id);
    expect(row?.role).toBe("member");
    expect(row?.install_key).toMatch(/^[a-f0-9]{32}$/);
    expect(row?.install_key).not.toBe(await installKey(bob.id));
    expect(await indexStatus(row!.install_key)).toBe(200);
  });

  it("refuses to add an existing member or an unknown account", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });

    const again = await postForm("/p/default/members", cookie, { user: bob.id, role: "admin" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("bob is already a member");
    expect((await membership("default", bob.id))?.role).toBe("member");

    const unknown = await postForm("/p/default/members", cookie, { user: "nobody", role: "member" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("Choose an account to add");
  });

  it("stops a plain member managing members", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });
    const { user: carol } = await seedUser({ username: "carol", role: "member", project: null });
    expect((await postForm("/p/default/members", alice.cookie, { user: carol.id, role: "member" })).status).toBe(403);
    expect((await postForm(`/p/default/members/${bob.id}/role`, alice.cookie, { role: "admin" })).status).toBe(403);
    expect((await postForm(`/p/default/members/${bob.id}/remove`, alice.cookie)).status).toBe(403);
    expect(await membership("default", carol.id)).toBeNull();
    expect((await membership("default", bob.id))?.role).toBe("member");
  });

  it("404s the member forms for someone outside the project", async () => {
    await seedProject("team-b", "Team B");
    const outsider = await seedAndLogin({ username: "alice", role: "member" });
    const { user: bob } = await seedUser({ username: "bob", role: "member", project: "team-b" });
    expect((await postForm(`/p/team-b/members/${bob.id}/remove`, outsider.cookie)).status).toBe(404);
    expect(await membership("team-b", bob.id)).not.toBeNull();
  });

  it("promotes a member to project admin, who can then manage others' skills", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    const bob = await seedAndLogin({ username: "bob", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private");
    expect((await postForm("/p/default/s/demo-skill/visibility", bob.cookie)).status).toBe(403);

    expect((await postForm(`/p/default/members/${bob.user.id}/role`, cookie, { role: "admin" })).status).toBe(302);
    expect((await membership("default", bob.user.id))?.role).toBe("admin");
    expect((await postForm("/p/default/s/demo-skill/visibility", bob.cookie)).status).toBe(302);
  });

  it("removing a member revokes their key and their view of the project's private skills", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const bob = await seedAndLogin({ username: "bob", role: "member" });
    await publish(cookie, GOOD_MD, "private");
    const key = await installKey(bob.user.id);

    const res = await postForm(`/p/default/members/${bob.user.id}/remove`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/default");
    const html = await (await follow(res, cookie)).text();
    expect(html).toContain("Removed bob from Default. Their install key for it no longer works.");
    expect(await indexStatus(key)).toBe(404);
    expect((await get("/p/default/s/demo-skill", bob.cookie)).status).toBe(404);
  });

  it("sends a project admin who removes themselves back to /projects", async () => {
    const lead = await seedAndLogin({ username: "lead", role: "member", projectRole: "admin" });
    const res = await postForm(`/p/default/members/${lead.user.id}/remove`, lead.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/projects");
    expect(await membership("default", lead.user.id)).toBeNull();
  });
});

describe("a demoted instance admin", () => {
  beforeEach(resetDb);

  it("loses project-admin power over Default once demoted", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const second = await seedAndLogin({ username: "second-admin", role: "admin" });
    const bob = await seedAndLogin({ username: "bob", role: "member" });
    await publish(bob.cookie, GOOD_MD, "private");

    expect((await postForm(`/admin/users/${second.user.id}/role`, root.cookie, { role: "member" })).status).toBe(302);

    expect((await postForm("/p/default/s/demo-skill/visibility", second.cookie)).status).toBe(403);
    expect((await postForm(`/p/default/members/${bob.user.id}/remove`, second.cookie)).status).toBe(403);
  });
});

describe("deleting a project", () => {
  beforeEach(resetDb);

  it("refuses while the project has skills", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    await publish(cookie, GOOD_MD, "private");
    const res = await postForm("/p/default/delete", cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Default still has skills. Move or delete them first.");
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
    expect(await membership("default", user.id)).not.toBeNull();
  });

  it("deletes an empty project and every membership in it", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member", project: "team-b" });
    const key = await installKey(bob.id, "team-b");

    const res = await postForm("/p/team-b/delete", cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/projects");
    expect(await (await follow(res, cookie)).text()).toContain("Deleted project Team B.");
    expect((await get("/p/team-b", cookie)).status).toBe(404);
    expect(await membership("team-b", bob.id)).toBeNull();
    expect(await indexStatus(key)).toBe(404);
  });

  it("is for instance admins only", async () => {
    await seedProject("team-b", "Team B");
    const lead = await seedAndLogin({ username: "lead", role: "member", project: "team-b", projectRole: "admin" });
    expect((await postForm("/p/team-b/delete", lead.cookie)).status).toBe(403);
  });
});
