import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/auth";
import { countUsers, getSkill, getUserByUsername, getVersion } from "../src/db/queries";
import {
  apiToken, env, GOOD_MD, login, ORIGIN, postForm, publishMarkdown, resetDb, seedAndLogin,
  seedUser,
} from "./helpers";

// `/setup` and `/login` are the two mutating routes with no session-bound CSRF
// token (see TOKENLESS_PATHS in src/csrf.tsx), so they post anonymously.
const anon = (path: string, data: Record<string, string>) => postForm(path, null, data);

describe("/setup", () => {
  beforeEach(resetDb);

  it("is reachable while no user exists", async () => {
    const res = await SELF.fetch(`${ORIGIN}/setup`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Create the first admin");
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
    expect((await SELF.fetch(`${ORIGIN}/setup`)).status).toBe(404);
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
    expect(await bad.text()).toContain("Incorrect username or password");
    expect(await missing.text()).toContain("Incorrect username or password");
  });

  it("still runs the password derivation when the username doesn't exist", async () => {
    // Structural proxy for the timing-safety property DUMMY_PASSWORD_HASH
    // exists for: asserting on wall-clock timing would be flaky, so assert
    // instead that the derivation is reached at all.
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
    const res = await SELF.fetch(`${ORIGIN}/me`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("shows the Account title without the username chip or role label", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const html = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
    const head = /<header class="cf-head">([\s\S]*?)<\/header>/.exec(html)?.[1];
    expect(head).toContain("Account");
    expect(head).not.toContain("alice");
    expect(head).not.toContain("cf-vis");
  });

  it("shows a ready-to-copy install command", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("puts exactly the install command inside the copyable element", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const html = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
    const text = /<code class="cf-command-text">([^<]*)<\/code>/.exec(html)?.[1];
    expect(text).toBe(`npx skills add ${ORIGIN}/i/${user.install_key}`);
  });

  it("gives the one-time api token its own copy button", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const html = await (await postForm("/me/api-token", cookie)).text();
    expect(html.match(/class="cf-command-copy"/g)).toHaveLength(2);
    expect(html).toMatch(/<code class="cf-command-text">sgt_[a-f0-9]{32}<\/code>/);
  });

  it("rotates the install key", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/install-key", cookie);
    expect(res.status).toBe(302);
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.install_key).not.toBe(user.install_key);
  });

  it("issues an api token once and stores only its hash", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/api-token", cookie);
    const html = await res.text();
    const match = /sgt_[a-f0-9]{32}/.exec(html);
    expect(match).not.toBeNull();
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.api_token_hash).not.toBeNull();
    expect(after?.api_token_hash).not.toContain(match![0]);
  });

  it("changes the password when the current one is supplied", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/password", cookie, {
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
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const res = await SELF.fetch(`${ORIGIN}/admin/users`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("lets an admin create a member and returns to the list", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/admin/users/new", cookie, {
      username: "carol",
      password: "carols-long-password",
      role: "member",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/users");
    const carol = await getUserByUsername(env.DB, "carol");
    expect(carol?.role).toBe("member");
  });

  it("links to the add-user page instead of embedding the form", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const html = await (await SELF.fetch(`${ORIGIN}/admin/users`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('href="/admin/users/new"');
    expect(html).not.toContain('action="/admin/users/new"');
    expect(html).not.toContain('name="username"');
  });

  it("no longer creates accounts from the list URL", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/admin/users", cookie, {
      username: "carol",
      password: "carols-long-password",
      role: "member",
    });
    expect(res.status).toBe(404);
    expect(await getUserByUsername(env.DB, "carol")).toBeNull();
  });

  // The UI side of adminTarget's self-targeting refusal: the role-toggle and
  // delete forms must be absent from the viewer's own row while remaining
  // present on every other row.
  it("hides the role-toggle and delete controls on the viewer's own row only", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const cookie = root.cookie;
    await seedUser({ username: "carol", role: "member" });
    const html = await (await SELF.fetch(`${ORIGIN}/admin/users`, { headers: { Cookie: cookie } })).text();

    expect(html).toContain(`/admin/users/${root.user.id}/install-key`);
    expect(html).not.toContain(`/admin/users/${root.user.id}/role`);
    expect(html).not.toContain(`/admin/users/${root.user.id}/delete`);

    const carol = await getUserByUsername(env.DB, "carol");
    expect(html).toContain(`/admin/users/${carol!.id}/role`);
    expect(html).toContain(`/admin/users/${carol!.id}/delete`);
  });
});

describe("/admin/users/new", () => {
  beforeEach(resetDb);

  it("is forbidden for members", async () => {
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const get = await SELF.fetch(`${ORIGIN}/admin/users/new`, { headers: { Cookie: cookie } });
    expect(get.status).toBe(403);
    const post = await postForm("/admin/users/new", cookie, {
      username: "carol",
      password: "carols-long-password",
      role: "member",
    });
    expect(post.status).toBe(403);
    expect(await getUserByUsername(env.DB, "carol")).toBeNull();
  });

  it("renders a form that posts to itself with a Cancel back to the list", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await SELF.fetch(`${ORIGIN}/admin/users/new`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/users/new"');
    expect(html).toContain('name="username"');
    expect(html).toContain('<a href="/admin/users" class="cf-btn cf-btn-outline">Cancel</a>');
    expect(html).not.toContain('<option value="admin" selected="">');
  });

  it("re-renders itself with the error and the typed values on a short password", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/admin/users/new", cookie, {
      username: "carol",
      password: "short",
      role: "admin",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Password must be at least 12 characters");
    expect(html).toContain('action="/admin/users/new"');
    expect(html).not.toContain('class="cf-table"');
    expect(html).toContain('value="carol"');
    expect(html).toContain('<option value="admin" selected="">admin</option>');
    expect(html).not.toContain('value="short"');
    expect(await getUserByUsername(env.DB, "carol")).toBeNull();
  });

  it("rejects a malformed username", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/admin/users/new", cookie, {
      username: "Carol!",
      password: "carols-long-password",
      role: "member",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Username must be 2-32 lowercase letters, digits or hyphens");
    expect(html).toContain('action="/admin/users/new"');
    expect(html).not.toContain('class="cf-table"');
    expect(html).toContain('value="Carol!"');
    expect(await getUserByUsername(env.DB, "Carol!")).toBeNull();
  });

  it("rejects a taken username without touching the existing account", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: carol } = await seedUser({ username: "carol", role: "member" });
    const res = await postForm("/admin/users/new", cookie, {
      username: "carol",
      password: "another-long-password",
      role: "admin",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("That username is taken");
    expect(html).toContain('action="/admin/users/new"');
    expect(html).not.toContain('class="cf-table"');
    expect(html).toContain('value="carol"');
    expect(html).toContain('<option value="admin" selected="">admin</option>');
    expect(html).not.toContain('value="another-long-password"');
    const after = await getUserByUsername(env.DB, "carol");
    expect(after?.role).toBe("member");
    expect(after?.password_hash).toBe(carol.password_hash);
  });
});

// Spec §7.1 specifies GET/POST /admin/users covering create, change role,
// reset password and delete. These five routes are the revocation levers a
// departed member's account needs: without them an admin has no way to demote,
// rotate a leaked install_key, or remove the account at all — only the member
// themselves could rotate their own key from /me.
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
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const target = await seedUser({ username: "carol", role: "member" });
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/${target.user.id}/${path}`, cookie, body);
      expect(res.status).toBe(403);
    }
  });

  it("404s for an unknown user id on every route", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/does-not-exist/${path}`, cookie, body);
      expect(res.status).toBe(404);
    }
  });

  it("lets an admin change a member's role", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/role`, cookie, { role: "admin" });
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "carol"))?.role).toBe("admin");
  });

  it("lets an admin reset a member's password", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/password`, cookie, {
      password: "carols-new-long-password",
    });
    expect(res.status).toBe(302);
    await login("carol", "carols-new-long-password");
  });

  it("rejects a too-short password reset with 400", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/password`, cookie, { password: "short" });
    expect(res.status).toBe(400);
  });

  it("lets an admin revoke a member's api token", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedAndLogin({ username: "carol", role: "member" });
    const carolCookie = target.cookie;
    await postForm("/me/api-token", carolCookie);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).not.toBeNull();

    const res = await postForm(`/admin/users/${target.user.id}/api-token/revoke`, cookie);
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).toBeNull();
  });

  it("refuses to demote the last remaining admin", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm(`/admin/users/${user.id}/role`, cookie, { role: "member" });
    expect(res.status).toBe(400);
    expect((await getUserByUsername(env.DB, "root"))?.role).toBe("admin");
  });

  it("still allows demoting an admin when another admin remains", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const other = await seedUser({ username: "second-admin", role: "admin" });
    const res = await postForm(`/admin/users/${other.user.id}/role`, cookie, { role: "member" });
    expect(res.status).toBe(302);
    expect((await getUserByUsername(env.DB, "second-admin"))?.role).toBe("member");
  });

  it("refuses to delete the last remaining admin", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm(`/admin/users/${user.id}/delete`, cookie);
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(1);
  });

  // The last-admin guard only checks the *count* of admins, so on its own it
  // never stops an admin from targeting their own id while a second admin
  // exists — which is exactly the corruption deleteUserReassigning's
  // `reassignTo` precondition describes. Refusal must not depend on how many
  // other admins there are.
  describe("self-targeting guard", () => {
    it("refuses to let an admin delete themselves even when a second admin exists", async () => {
      const { user: root, cookie: rootCookie } = await seedAndLogin({ username: "root", role: "admin" });
      await seedUser({ username: "second-admin", role: "admin" });

      await publishMarkdown(rootCookie, GOOD_MD, "public");

      const res = await postForm(`/admin/users/${root.id}/delete`, rootCookie);
      expect(res.status).toBe(400);
      expect(await getUserByUsername(env.DB, "root")).not.toBeNull();
      expect((await getSkill(env.DB, "demo-skill"))?.owner_id).toBe(root.id);
    });

    it("refuses to let an admin demote themselves even when a second admin exists", async () => {
      const { user: root, cookie: rootCookie } = await seedAndLogin({ username: "root", role: "admin" });
      await seedUser({ username: "second-admin", role: "admin" });

      const res = await postForm(`/admin/users/${root.id}/role`, rootCookie, { role: "member" });
      expect(res.status).toBe(400);
      expect((await getUserByUsername(env.DB, "root"))?.role).toBe("admin");
    });

    it("still lets a different admin delete them, with reassignment intact", async () => {
      const { user: root, cookie: rootCookie } = await seedAndLogin({ username: "root", role: "admin" });
      const second = await seedAndLogin({ username: "second-admin", role: "admin" });
      const secondCookie = second.cookie;

      await publishMarkdown(rootCookie, GOOD_MD, "public");

      const res = await postForm(`/admin/users/${root.id}/delete`, secondCookie);
      expect(res.status).toBe(302);
      expect(await getUserByUsername(env.DB, "root")).toBeNull();
      expect((await getSkill(env.DB, "demo-skill"))?.owner_id).toBe(second.user.id);
    });
  });

  // The immediate revocation lever: install_key is a plaintext capability
  // granting read access to every private skill, and rotating it must
  // invalidate the old one at the exact endpoint the CLI uses.
  it("rotating a member's install key revokes the old one and enables the new one", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "dave", role: "member" });
    const oldKey = target.user.install_key;

    const before = await SELF.fetch(`${ORIGIN}/i/${oldKey}/.well-known/agent-skills/index.json`);
    expect(before.status).toBe(200);

    const res = await postForm(`/admin/users/${target.user.id}/install-key`, cookie);
    expect(res.status).toBe(302);

    const afterOld = await SELF.fetch(`${ORIGIN}/i/${oldKey}/.well-known/agent-skills/index.json`);
    expect(afterOld.status).toBe(404);

    const updated = await getUserByUsername(env.DB, "dave");
    expect(updated?.install_key).not.toBe(oldKey);
    const afterNew = await SELF.fetch(
      `${ORIGIN}/i/${updated!.install_key}/.well-known/agent-skills/index.json`,
    );
    expect(afterNew.status).toBe(200);
  });

  it("reassigns owned skills and version authorship to the acting admin on delete, and keeps the skill downloadable", async () => {
    const { user: root, cookie: rootCookie } = await seedAndLogin({ username: "root", role: "admin" });
    const member = await seedAndLogin({ username: "erin", role: "member" });
    const memberCookie = member.cookie;

    await publishMarkdown(memberCookie, GOOD_MD, "public");

    const res = await postForm(`/admin/users/${member.user.id}/delete`, rootCookie);
    expect(res.status).toBe(302);

    expect(await getUserByUsername(env.DB, "erin")).toBeNull();
    const skill = await getSkill(env.DB, "demo-skill");
    expect(skill?.owner_id).toBe(root.id);
    const version = await getVersion(env.DB, "demo-skill", 1);
    expect(version?.author_id).toBe(root.id);

    const download = await SELF.fetch(`${ORIGIN}/s/demo-skill/download`, { headers: { Cookie: rootCookie } });
    expect(download.status).toBe(200);
  });
});
