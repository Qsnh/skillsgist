import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/auth";
import { addMembership, countUsers, getSkill, getUserByUsername, getVersion } from "../src/db/queries";
import { FLASH_COOKIE } from "../src/flash";
import { sha256Hex } from "../src/hash";
import {
  apiToken, env, FLASH_CLEARED, flashCookie, follow, GOOD_MD, installKey, login, ORIGIN, postForm, publishMarkdown,
  resetDb, seedAndLogin, seedProject, seedUser,
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
    const membership = await env.DB.prepare(
      "SELECT role, install_key FROM memberships WHERE project = 'default' AND user_id = ?",
    )
      .bind(user!.id)
      .first<{ role: string; install_key: string }>();
    expect(membership?.role).toBe("member");
    expect(membership?.install_key).toMatch(/^[a-f0-9]{32}$/);
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

  it("gives the one-time api token its own copy button", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const html = await (await postForm("/me/api-token", cookie)).text();
    expect(html.match(/class="cf-command-copy"/g)).toHaveLength(1);
    expect(html).toMatch(/<code class="cf-command-text">sgt_[a-f0-9]{32}<\/code>/);
  });

  it("shows no install key, even to a user in several projects", async () => {
    await seedProject("team-b", "Team B");
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await addMembership(env.DB, { project: "team-b", userId: user.id, role: "member", installKey: "b".repeat(32) });
    const html = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
    expect(html).not.toContain("Install keys");
    expect(html).not.toContain("npx skills add");
    expect(html).not.toContain(await installKey(user.id));
    expect(html).not.toContain("b".repeat(32));
    expect(html).not.toContain("install-key");
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

  it("puts token revocation behind a confirm step, and offers none without a token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const page = async () => (await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } })).text();
    expect(await page()).not.toContain("/me/api-token/revoke");

    await postForm("/me/api-token", cookie);
    const html = await page();
    const blocks = html.match(/<details class="cf-confirm" name="revoke-api-token">[\s\S]*?<\/details>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<summary class="cf-btn cf-btn-danger">Revoke</summary>');
    expect(blocks[0]).toContain('<p class="cf-hint">Revoking stops your current token from working at once');
    expect(blocks[0]).toContain('action="/me/api-token/revoke"');
    expect(blocks[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke API token</button>');
    expect(html.split("/me/api-token/revoke")).toHaveLength(2);
  });

  it("changes the password when the current one is supplied", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/password", cookie, {
      current: password,
      next: "another-long-password",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/me");
    await login("alice", "another-long-password");
  });

  it("confirms a password change once on the account page", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/password", cookie, {
      current: password,
      next: "another-long-password",
    });
    const shown = await follow(res, cookie);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toMatch(/<p class="cf-done" role="status">[\s\S]*?Your password has been changed\.<\/span><\/p>/);
    expect(html).not.toContain("cf-alert");
    expect(flashCookie(shown)).toMatch(FLASH_CLEARED);
    const again = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
    expect(await again.text()).not.toContain("cf-done");
  });

  it("sets the flash cookie http-only, same-site and short-lived", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/password", cookie, {
      current: password,
      next: "another-long-password",
    });
    const line = flashCookie(res);
    expect(line).toMatch(/Max-Age=60/i);
    expect(line).toMatch(/Path=\//i);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
  });

  it("leaves the flash cookie alone on a page load without one", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(flashCookie(res)).toBeUndefined();
    expect(await res.text()).not.toContain("cf-done");
  });

  it("does not render a signed session value planted as a flash", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const planted = cookie.replace(/^sg_session=/, `${FLASH_COOKIE}=`);
    const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: `${cookie}; ${planted}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("cf-done");
    expect(html).not.toContain("&quot;uid&quot;");
    expect(flashCookie(res)).toMatch(FLASH_CLEARED);
  });

  it("does not show one session's flash in another session", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob" });
    const res = await postForm("/me/password", alice.cookie, {
      current: alice.password,
      next: "another-long-password",
    });
    const flashed = flashCookie(res)?.split(";")[0];
    expect(flashed).toBeDefined();
    const shown = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: `${bob.cookie}; ${flashed}` } });
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).not.toContain("cf-done");
    expect(html).not.toContain("Your password has been changed.");
    expect(flashCookie(shown)).toMatch(FLASH_CLEARED);
  });

  it("ignores and clears a flash cookie it did not sign", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const forged = [
      `${FLASH_COOKIE}=Visit%20evil.example`,
      `${FLASH_COOKIE}=${encodeURIComponent(`Visit evil.example.${"A".repeat(43)}=`)}`,
    ];
    for (const planted of forged) {
      const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: `${cookie}; ${planted}` } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("cf-done");
      expect(html).not.toContain("evil.example");
      expect(flashCookie(res)).toMatch(FLASH_CLEARED);
    }
  });

  it("sets no flash when the change is refused", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const wrong = await postForm("/me/password", cookie, {
      current: "wrong-password-x",
      next: "another-long-password",
    });
    expect(wrong.status).toBe(400);
    expect(flashCookie(wrong)).toBeUndefined();
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("Current password is incorrect");
    expect(wrongHtml).not.toContain("cf-done");
    const short = await postForm("/me/password", cookie, { current: password, next: "short" });
    expect(short.status).toBe(400);
    expect(flashCookie(short)).toBeUndefined();
    expect(await short.text()).not.toContain("cf-done");
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
    const joined = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?")
      .bind(carol!.id)
      .first<{ n: number }>();
    expect(joined?.n).toBe(0);
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

  it("lists each account's role, projects, created skills, join date and last sign-in, linked to its settings", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    await seedProject("team-b", "Team B");
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    await addMembership(env.DB, { project: "team-b", userId: carol.user.id, role: "member", installKey: "c".repeat(32) });
    await publishMarkdown(carol.cookie, GOOD_MD, "private", "default");
    await env.DB.prepare("UPDATE users SET created_at = ?, last_login_at = NULL WHERE id = ?")
      .bind(Date.UTC(2026, 8, 1), carol.user.id)
      .run();

    const html = await (await SELF.fetch(`${ORIGIN}/admin/users`, { headers: { Cookie: root.cookie } })).text();
    const row = (name: string) => html.split("<tr>").find((r) => r.includes(`>${name}</a>`));

    const theirs = row("carol");
    expect(theirs).toContain(`<a href="/admin/users/${carol.user.id}" class="cf-link cf-user-name">carol</a>`);
    expect(theirs).toContain('<span class="cf-vis cf-vis-private">member</span>');
    expect(theirs).toContain('<td data-label="Projects" class="cf-table-date">2</td>');
    expect(theirs).toContain('<td data-label="Skills" class="cf-table-date">1</td>');
    expect(theirs).toContain('<td data-label="Joined" class="cf-table-date">Sep 1, 2026</td>');
    expect(theirs).toContain('<td data-label="Last sign-in" class="cf-table-date">—</td>');

    const own = row("root");
    expect(own).toContain(`<a href="/admin/users/${root.user.id}" class="cf-link cf-user-name">root</a>`);
    expect(own).toContain('<span class="cf-tag">You</span>');
    expect(own).toContain('<td data-label="Skills" class="cf-table-date">0</td>');

    expect(html).not.toContain('<th scope="col">Actions</th>');
    for (const action of ["role", "password", "install-key", "api-token", "api-token/revoke", "delete"]) {
      expect(html).not.toContain(`/${action}"`);
    }
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
    expect(html).toContain(
      "New accounts start in no project. Add them to a project from its settings page to give them access to its private skills.",
    );
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
describe("/admin/users/:id", () => {
  beforeEach(resetDb);

  const view = (id: string, cookie: string) =>
    SELF.fetch(`${ORIGIN}/admin/users/${id}`, { headers: { Cookie: cookie }, redirect: "manual" });

  it("is forbidden for members and 404s for an unknown id", async () => {
    const bob = await seedAndLogin({ username: "bob", role: "member" });
    expect((await view(bob.user.id, bob.cookie)).status).toBe(403);
    const root = await seedAndLogin({ username: "root", role: "admin" });
    expect((await view("does-not-exist", root.cookie)).status).toBe(404);
  });

  it("gives an admin every control over another account", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    await postForm("/me/api-token", carol.cookie);
    const res = await view(carol.user.id, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const id = carol.user.id;
    expect(html).toContain('<h1 class="cf-head-title">carol settings</h1>');
    expect(html).toMatch(/<div class="cf-head-lede">Joined [A-Z][a-z]{2} \d{1,2}, \d{4}, last signed in [A-Z][a-z]{2} \d{1,2}, \d{4}\.<\/div>/);
    expect(html).not.toContain("Every account is listed on");
    expect(html).toContain(`action="/admin/users/${id}/role"`);
    expect(html).toContain("Promote to admin");
    expect(html).toContain(`action="/admin/users/${id}/install-key"`);
    expect(html).toContain('<span class="cf-status-value cf-status-on">active</span>');
    expect(html).toContain(`action="/admin/users/${id}/api-token/revoke"`);
    expect(html).toContain(`action="/admin/users/${id}/api-token"`);
    expect(html).toContain("Generating a token replaces carol&#39;s current one at once.");
    expect(html).toContain(`action="/admin/users/${id}/password"`);
    expect(html).toContain(`action="/admin/users/${id}/delete"`);
  });

  it("leaves the role and delete controls off the viewer's own page", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const id = root.user.id;
    const html = await (await view(id, root.cookie)).text();
    expect(html).toContain(`action="/admin/users/${id}/install-key"`);
    expect(html).toContain(`action="/admin/users/${id}/password"`);
    expect(html).toContain(`action="/admin/users/${id}/api-token"`);
    expect(html).toContain("The new token is shown only once, on this page.");
    expect(html).not.toContain("replaces your current one");
    expect(html).not.toContain(`/admin/users/${id}/role`);
    expect(html).not.toContain(`/admin/users/${id}/delete`);
    expect(html).toContain("Only another admin can change your role.");
  });

  it("says an account in no project has no install keys, and one without a token has nothing to revoke", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: dave } = await seedUser({ username: "dave", role: "member", project: null });
    const html = await (await view(dave.id, cookie)).text();
    expect(html).toContain("dave is in no project, so they have no install keys.");
    expect(html).not.toContain(`/admin/users/${dave.id}/install-key`);
    expect(html).toContain('<span class="cf-status-value">not generated</span>');
    expect(html).not.toContain(`/admin/users/${dave.id}/api-token/revoke`);
    expect(html).toContain(`action="/admin/users/${dave.id}/api-token"`);
    expect(html).not.toContain("replaces dave");
  });

  it("puts account deletion behind a confirm step that names the user", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: carol } = await seedUser({ username: "carol", role: "member" });
    const html = await (await view(carol.id, cookie)).text();
    const blocks =
      html.match(/<div class="cf-actions"><details class="cf-confirm" name="delete-user">[\s\S]*?<\/details><\/div>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(`<summary class="cf-btn cf-btn-danger">Delete account</summary>`);
    expect(blocks[0]).toContain(`<p class="cf-hint">Deleting reassigns`);
    expect(blocks[0]).toContain(`action="/admin/users/${carol.id}/delete"`);
    expect(blocks[0]).toContain(`<button type="submit" class="cf-btn cf-btn-danger">Delete carol</button>`);
  });

  it("puts API token revocation behind a confirm step that names the user", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    await postForm("/me/api-token", carol.cookie);
    await postForm("/me/api-token", root.cookie);
    const blocksOn = async (id: string) => {
      const html = await (await view(id, root.cookie)).text();
      expect(html.split(`/admin/users/${id}/api-token/revoke`)).toHaveLength(2);
      return html.match(/<details class="cf-confirm" name="revoke-api-token">[\s\S]*?<\/details>/g) ?? [];
    };

    const other = await blocksOn(carol.user.id);
    expect(other).toHaveLength(1);
    expect(other[0]).toContain('<summary class="cf-btn cf-btn-danger">Revoke API token</summary>');
    expect(other[0]).toContain('<p class="cf-hint">Revoking stops carol&#39;s current token from working at once');
    expect(other[0]).toContain(`action="/admin/users/${carol.user.id}/api-token/revoke"`);
    expect(other[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke carol&#39;s token</button>');

    const own = await blocksOn(root.user.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('<p class="cf-hint">Revoking stops your current token from working at once');
    expect(own[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke your token</button>');
  });

  it("lets an admin generate a token for another account, shows it once and replaces the old one", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    const old = await apiToken(carol.cookie);

    const res = await postForm(`/admin/users/${carol.user.id}/api-token`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1 class="cf-head-title">carol settings</h1>');
    const token = /<code class="cf-command-text">(sgt_[a-f0-9]{32})<\/code>/.exec(html)?.[1];
    expect(token).toBeDefined();
    expect(html).toContain("This token is shown once. Save it now.");
    expect(html.match(/class="cf-command-copy"/g)).toHaveLength(1);

    const put = (bearer: string) =>
      SELF.fetch(`${ORIGIN}/api/projects/default/skills/demo-skill`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "text/markdown" },
        body: GOOD_MD,
      });
    expect((await put(old)).status).toBe(404);
    expect((await put(token!)).status).toBe(201);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(carol.user.id);

    const again = await (await view(carol.user.id, cookie)).text();
    expect(again).not.toContain(token!);
    expect(again).toContain('<span class="cf-status-value cf-status-on">active</span>');
  });

  it("lets an admin generate their own token from their own settings page", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm(`/admin/users/${root.user.id}/api-token`, root.cookie);
    expect(res.status).toBe(200);
    const token = /sgt_[a-f0-9]{32}/.exec(await res.text())?.[0];
    expect(token).toBeDefined();
    expect((await getUserByUsername(env.DB, "root"))?.api_token_hash).toBe(await sha256Hex(token!));
  });
});

describe("/admin/users/:id/*", () => {
  beforeEach(resetDb);

  const endpoints: Array<{ path: string; body: Record<string, string> }> = [
    { path: "role", body: { role: "admin" } },
    { path: "password", body: { password: "another-long-password" } },
    { path: "install-key", body: {} },
    { path: "api-token", body: {} },
    { path: "api-token/revoke", body: {} },
    { path: "delete", body: {} },
  ];

  it("denies every route to a member with 403", async () => {
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const target = await seedUser({ username: "carol", role: "member" });
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/${target.user.id}/${path}`, cookie, body);
      expect(res.status).toBe(403);
      expect(flashCookie(res)).toBeUndefined();
    }
  });

  it("404s for an unknown user id on every route", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/does-not-exist/${path}`, cookie, body);
      expect(res.status).toBe(404);
      expect(flashCookie(res)).toBeUndefined();
    }
  });

  it("lets an admin change a member's role", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/role`, cookie, { role: "admin" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    expect((await getUserByUsername(env.DB, "carol"))?.role).toBe("admin");
  });

  it("lets an admin reset a member's password and confirms it by username", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/password`, cookie, {
      password: "carols-new-long-password",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    await login("carol", "carols-new-long-password");
    const html = await (await follow(res, cookie)).text();
    expect(html).toMatch(/<p class="cf-done" role="status">[\s\S]*?Password reset for carol\.<\/span><\/p>/);
  });

  it("rejects a too-short password reset with 400 and no flash", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const res = await postForm(`/admin/users/${target.user.id}/password`, cookie, { password: "short" });
    expect(res.status).toBe(400);
    expect(flashCookie(res)).toBeUndefined();
    const html = await res.text();
    expect(html).toContain("Password must be at least 12 characters");
    expect(html).toContain('<h1 class="cf-head-title">carol settings</h1>');
    expect(html).not.toContain('value="short"');
    expect(html).not.toContain("cf-done");
  });

  it("lets an admin revoke a member's api token", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedAndLogin({ username: "carol", role: "member" });
    const carolCookie = target.cookie;
    await postForm("/me/api-token", carolCookie);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).not.toBeNull();

    const res = await postForm(`/admin/users/${target.user.id}/api-token/revoke`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).toBeNull();
  });

  it("refuses to demote the last remaining admin", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm(`/admin/users/${user.id}/role`, cookie, { role: "member" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<h1 class="cf-head-title">root settings</h1>');
    expect(html).toContain('<p class="cf-alert" role="alert">');
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
      expect(await res.text()).toContain("You cannot delete your own account. Ask another admin.");
      expect(await getUserByUsername(env.DB, "root")).not.toBeNull();
      expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(root.id);
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
      expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(second.user.id);
    });
  });

  it("rotating a member's install keys revokes every old one and enables the new ones", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "dave", role: "member" });
    await addMembership(env.DB, { project: "team-b", userId: target.user.id, role: "member", installKey: "b".repeat(32) });
    const keys = () => Promise.all([installKey(target.user.id), installKey(target.user.id, "team-b")]);
    const index = (key: string) => SELF.fetch(`${ORIGIN}/i/${key}/.well-known/agent-skills/index.json`);
    const oldKeys = await keys();
    for (const key of oldKeys) expect((await index(key)).status).toBe(200);

    const res = await postForm(`/admin/users/${target.user.id}/install-key`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    const html = await (await follow(res, cookie)).text();
    expect(html).toMatch(
      /<p class="cf-done" role="status">[\s\S]*?Install keys rotated for dave\. The old install commands no longer work\.<\/span><\/p>/,
    );

    for (const key of oldKeys) expect((await index(key)).status).toBe(404);
    const newKeys = await keys();
    expect(newKeys[0]).not.toBe(newKeys[1]);
    for (const key of newKeys) {
      expect(oldKeys).not.toContain(key);
      expect((await index(key)).status).toBe(200);
    }
  });

  it("reassigns owned skills and version authorship to the acting admin on delete, and keeps the skill downloadable", async () => {
    const { user: root, cookie: rootCookie } = await seedAndLogin({ username: "root", role: "admin" });
    const member = await seedAndLogin({ username: "erin", role: "member" });
    const memberCookie = member.cookie;

    await publishMarkdown(memberCookie, GOOD_MD, "public");

    const res = await postForm(`/admin/users/${member.user.id}/delete`, rootCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/users");
    const listed = await (await follow(res, rootCookie)).text();
    expect(listed).toMatch(/<p class="cf-done" role="status">[\s\S]*?Deleted erin\.<\/span><\/p>/);

    expect(await getUserByUsername(env.DB, "erin")).toBeNull();
    const skill = await getSkill(env.DB, "default", "demo-skill");
    expect(skill?.owner_id).toBe(root.id);
    const version = await getVersion(env.DB, "default", "demo-skill", 1);
    expect(version?.author_id).toBe(root.id);

    const download = await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill/download`, { headers: { Cookie: rootCookie } });
    expect(download.status).toBe(200);
  });
});
