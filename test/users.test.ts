import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/auth";
import { countUsers, getSkill, getUserByUsername, getVersion } from "../src/db/queries";
import { login, postForm, publishMarkdown, resetDb, seedUser } from "./helpers";

// See test/db.test.ts for why `env` needs a local cast here.
const env = rawEnv as unknown as { DB: D1Database };

const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

// `/setup` and `/login` are the two mutating routes with no session-bound CSRF
// token (see TOKENLESS_PATHS in src/csrf.tsx), so they post anonymously.
const anon = (path: string, data: Record<string, string>) => postForm(path, null, data);

const postAs = (path: string, cookie: string, data: Record<string, string> = {}) =>
  postForm(path, cookie, data);

describe("/setup", () => {
  beforeEach(resetDb);

  it("is reachable while no user exists", async () => {
    const res = await SELF.fetch("http://localhost/setup");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("创建管理员");
  });

  it("creates the first admin and signs them in", async () => {
    const res = await anon("/setup", { username: "root", password: "a-very-long-password" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
    const user = await getUserByUsername(env.DB, "root");
    expect(user?.role).toBe("admin");
    expect(user?.install_key).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await anon("/setup", { username: "root", password: "short" });
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(0);
  });

  it("returns 404 once a user exists", async () => {
    await seedUser();
    expect((await SELF.fetch("http://localhost/setup")).status).toBe(404);
  });

  it("cannot bootstrap a second admin after the first succeeds", async () => {
    const first = await anon("/setup", { username: "root", password: "a-very-long-password" });
    expect(first.status).toBe(302);

    const second = await anon("/setup", { username: "intruder", password: "another-long-password" });
    expect(second.status).toBe(404);
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(await countUsers(env.DB)).toBe(1);
  });
});

describe("/login", () => {
  beforeEach(resetDb);

  it("sets a session cookie on success", async () => {
    const { password } = await seedUser({ username: "alice" });
    const res = await anon("/login", { username: "alice", password });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
  });

  it("gives the same generic error for a bad password and a missing user", async () => {
    await seedUser({ username: "alice" });
    const bad = await anon("/login", { username: "alice", password: "wrong-password-x" });
    const missing = await anon("/login", { username: "nobody", password: "wrong-password-x" });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await bad.text()).toContain("用户名或密码不正确");
    expect(await missing.text()).toContain("用户名或密码不正确");
  });

  it("still runs the password derivation when the username doesn't exist", async () => {
    // Structural proxy for the timing-safety property: a missing user must
    // not skip `verifyPassword`, or the two failure paths take measurably
    // different CPU time and a username can be enumerated by timing. We
    // don't assert on wall-clock timing (flaky); we assert the call happens.
    const spy = vi.spyOn(auth, "verifyPassword");
    try {
      const res = await anon("/login", { username: "nobody", password: "wrong-password-x" });
      expect(res.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/me", () => {
  beforeEach(resetDb);

  it("redirects anonymous visitors to /login", async () => {
    const res = await SELF.fetch("http://localhost/me", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("shows a ready-to-copy install command", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me", { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("rotates the install key", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await postAs("/me/install-key", cookie);
    expect(res.status).toBe(302);
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.install_key).not.toBe(user.install_key);
  });

  it("issues an api token once and stores only its hash", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await postAs("/me/api-token", cookie);
    const html = await res.text();
    const match = /sgt_[a-f0-9]{32}/.exec(html);
    expect(match).not.toBeNull();
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.api_token_hash).not.toBeNull();
    expect(after?.api_token_hash).not.toContain(match![0]);
  });

  it("changes the password when the current one is supplied", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await postAs("/me/password", cookie, {
      current: password,
      next: "another-long-password",
    });
    expect(res.status).toBe(302);
    await login("alice", "another-long-password");
  });
});

describe("/admin/users", () => {
  beforeEach(resetDb);

  it("is forbidden for members", async () => {
    const { password } = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", password);
    const res = await SELF.fetch("http://localhost/admin/users", { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("lets an admin create a member", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const res = await postAs("/admin/users", cookie, {
      username: "carol",
      password: "carols-long-password",
      role: "member",
    });
    expect(res.status).toBe(302);
    const carol = await getUserByUsername(env.DB, "carol");
    expect(carol?.role).toBe("member");
  });

  // Regression 1 (scoped re-review): the server refuses a self-targeted
  // role change or delete outright, but a UI that still renders a control
  // the server will always reject is a bad guard on its own — the
  // role-toggle and delete forms (and the delete note) must be absent from
  // the viewer's own row, while remaining present on every other row.
  it("hides the role-toggle and delete controls on the viewer's own row only", async () => {
    const root = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", root.password);
    await seedUser({ username: "carol", role: "member" });
    const html = await (await SELF.fetch("http://localhost/admin/users", { headers: { Cookie: cookie } })).text();

    expect(html).toContain(`/admin/users/${root.user.id}/install-key`);
    expect(html).not.toContain(`/admin/users/${root.user.id}/role`);
    expect(html).not.toContain(`/admin/users/${root.user.id}/delete`);

    const carol = await getUserByUsername(env.DB, "carol");
    expect(html).toContain(`/admin/users/${carol!.id}/role`);
    expect(html).toContain(`/admin/users/${carol!.id}/delete`);
  });
});

// Final-review Fix 3: spec §7.1 specifies GET/POST /admin/users covering
// 建号 (create), 改角色 (change role), 重置密码 (reset password) and 删号
// (delete) — only create existed. These five routes are the revocation
// levers a departed member's account needs: without them an admin has no
// way to demote, rotate a leaked install_key, or remove the account at
// all, only the member themselves could rotate their own key from /me.
describe("/admin/users/:id/*", () => {
  beforeEach(resetDb);

  const endpoints: Array<{ path: string; body: Record<string, string> }> = [
    { path: "role", body: { role: "admin" } },
    { path: "password", body: { password: "another-long-password" } },
    { path: "install-key", body: {} },
    { path: "api-token/revoke", body: {} },
    { path: "delete", body: {} },
  ];

  it("denies every route to a member with 403", async () => {
    const { password } = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", password);
    const target = await seedUser({ username: "carol", role: "member" });
    for (const { path, body } of endpoints) {
      const res = await postAs(`/admin/users/${target.user.id}/${path}`, cookie, body);
      expect(res.status).toBe(403);
    }
  });

  it("404s for an unknown user id on every route", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    for (const { path, body } of endpoints) {
      const res = await postAs(`/admin/users/does-not-exist/${path}`, cookie, body);
      expect(res.status).toBe(404);
    }
  });

  it("lets an admin change a member's role", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postAs(`/admin/users/${target.user.id}/role`, cookie, { role: "admin" });
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "carol"))?.role).toBe("admin");
  });

  it("lets an admin reset a member's password", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postAs(`/admin/users/${target.user.id}/password`, cookie, {
      password: "carols-new-long-password",
    });
    expect(res.status).toBe(302);
    await login("carol", "carols-new-long-password");
  });

  it("rejects a too-short password reset with 400", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postAs(`/admin/users/${target.user.id}/password`, cookie, { password: "short" });
    expect(res.status).toBe(400);
  });

  it("lets an admin revoke a member's api token", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const target = await seedUser({ username: "carol", role: "member" });
    const carolCookie = await login("carol", target.password);
    await postAs("/me/api-token", carolCookie);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).not.toBeNull();

    const res = await postAs(`/admin/users/${target.user.id}/api-token/revoke`, cookie);
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).toBeNull();
  });

  it("refuses to demote the last remaining admin", async () => {
    const { user, password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const res = await postAs(`/admin/users/${user.id}/role`, cookie, { role: "member" });
    expect(res.status).toBe(400);
    expect((await getUserByUsername(env.DB, "root"))?.role).toBe("admin");
  });

  it("still allows demoting an admin when another admin remains", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const other = await seedUser({ username: "second-admin", role: "admin" });
    const res = await postAs(`/admin/users/${other.user.id}/role`, cookie, { role: "member" });
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "second-admin"))?.role).toBe("member");
  });

  it("refuses to delete the last remaining admin", async () => {
    const { user, password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const res = await postAs(`/admin/users/${user.id}/delete`, cookie);
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(1);
  });

  // Regression 1 (scoped re-review of the final fix wave): the last-admin
  // guard only checks the *count* of admins, so it never stopped an admin
  // from targeting their own id while a second admin exists.
  // deleteUserReassigning(db, target.id, admin.id) then runs with the same
  // id on both sides — the owner_id reassignment is a no-op, and the very
  // next statement deletes that row, leaving every skill the admin owned
  // pointing at a user id that no longer exists (and silently vanishing
  // from listSkills's INNER JOIN). Self-service demotion/deletion must be
  // refused outright, regardless of how many other admins exist — that's
  // simpler than trying to make self-reassignment work, and it just means
  // "remove my own account" is something another admin does instead.
  describe("self-targeting guard", () => {
    it("refuses to let an admin delete themselves even when a second admin exists", async () => {
      const { user: root, password: rootPw } = await seedUser({ username: "root", role: "admin" });
      const rootCookie = await login("root", rootPw);
      await seedUser({ username: "second-admin", role: "admin" });

      await publishMarkdown(rootCookie, GOOD_MD, "public");

      const res = await postAs(`/admin/users/${root.id}/delete`, rootCookie);
      expect(res.status).toBe(400);
      expect(await getUserByUsername(env.DB, "root")).not.toBeNull();
      expect((await getSkill(env.DB, "demo-skill"))?.owner_id).toBe(root.id);
    });

    it("refuses to let an admin demote themselves even when a second admin exists", async () => {
      const { user: root, password: rootPw } = await seedUser({ username: "root", role: "admin" });
      const rootCookie = await login("root", rootPw);
      await seedUser({ username: "second-admin", role: "admin" });

      const res = await postAs(`/admin/users/${root.id}/role`, rootCookie, { role: "member" });
      expect(res.status).toBe(400);
      expect((await getUserByUsername(env.DB, "root"))?.role).toBe("admin");
    });

    it("still lets a different admin delete them, with reassignment intact", async () => {
      const { user: root, password: rootPw } = await seedUser({ username: "root", role: "admin" });
      const rootCookie = await login("root", rootPw);
      const second = await seedUser({ username: "second-admin", role: "admin" });
      const secondCookie = await login("second-admin", second.password);

      await publishMarkdown(rootCookie, GOOD_MD, "public");

      const res = await postAs(`/admin/users/${root.id}/delete`, secondCookie);
      expect(res.status).toBe(302);
      expect(await getUserByUsername(env.DB, "root")).toBeNull();
      expect((await getSkill(env.DB, "demo-skill"))?.owner_id).toBe(second.user.id);
    });
  });

  // The immediate revocation lever: install_key is a plaintext capability
  // granting read access to every private skill, and rotating it must
  // invalidate the old one at the exact endpoint the CLI uses.
  it("rotating a member's install key revokes the old one and enables the new one", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const target = await seedUser({ username: "dave", role: "member" });
    const oldKey = target.user.install_key;

    const before = await SELF.fetch(`http://localhost/i/${oldKey}/.well-known/agent-skills/index.json`);
    expect(before.status).toBe(200);

    const res = await postAs(`/admin/users/${target.user.id}/install-key`, cookie);
    expect(res.status).toBe(302);

    const afterOld = await SELF.fetch(`http://localhost/i/${oldKey}/.well-known/agent-skills/index.json`);
    expect(afterOld.status).toBe(404);

    const updated = await getUserByUsername(env.DB, "dave");
    expect(updated?.install_key).not.toBe(oldKey);
    const afterNew = await SELF.fetch(
      `http://localhost/i/${updated!.install_key}/.well-known/agent-skills/index.json`,
    );
    expect(afterNew.status).toBe(200);
  });

  it("reassigns owned skills and version authorship to the acting admin on delete, and keeps the skill downloadable", async () => {
    const { user: root, password: rootPw } = await seedUser({ username: "root", role: "admin" });
    const rootCookie = await login("root", rootPw);
    const member = await seedUser({ username: "erin", role: "member" });
    const memberCookie = await login("erin", member.password);

    await publishMarkdown(memberCookie, GOOD_MD, "public");

    const res = await postAs(`/admin/users/${member.user.id}/delete`, rootCookie);
    expect(res.status).toBe(302);

    expect(await getUserByUsername(env.DB, "erin")).toBeNull();
    const skill = await getSkill(env.DB, "demo-skill");
    expect(skill?.owner_id).toBe(root.id);
    const version = await getVersion(env.DB, "demo-skill", 1);
    expect(version?.author_id).toBe(root.id);

    const download = await SELF.fetch("http://localhost/s/demo-skill/download", { headers: { Cookie: rootCookie } });
    expect(download.status).toBe(200);
  });
});
