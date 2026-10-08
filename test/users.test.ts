import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/auth";
import { countUsers, getSkill, getUserByUsername, getVersion } from "../src/db/queries";
import { FLASH_COOKIE } from "../src/flash";
import { sha256Hex } from "../src/hash";
import {
  apiToken, bearer, env, fetchWith, FLASH_CLEARED, flashCookie, follow, get, GOOD_MD, installKey, joinProject,
  login, membership, ORIGIN, postForm, publishMarkdown, putSkill, resetDb, seedAndLogin, seedProject, seedUser,
  signInDevice,
} from "./helpers";

const anon = (path: string, data: Record<string, string>) => postForm(path, null, data);

const changePassword = (cookie: string, current: string, next = "another-long-password") =>
  postForm("/me/password", cookie, { current, next });

const confirmBlocks = (html: string, name: string) =>
  html.match(new RegExp(`<details class="cf-confirm" name="${name}">[\\s\\S]*?</details>`, "g")) ?? [];

describe("/setup", () => {
  beforeEach(resetDb);

  it("is reachable only while no user exists", async () => {
    const res = await get("/setup");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Create the first admin");
    await seedUser();
    expect((await get("/setup")).status).toBe(404);
  });

  it("creates the first admin, signs them in, and cannot run again", async () => {
    const res = await anon("/setup", { username: "root", password: "a-very-long-password" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
    const user = await getUserByUsername(env.DB, "root");
    expect(user?.role).toBe("admin");
    const joined = await membership(user!.id);
    expect(joined?.role).toBe("member");
    expect(joined?.install_key).toMatch(/^sgi_[a-f0-9]{64}$/);
    expect(joined?.can_publish).toBe(1);

    const second = await anon("/setup", { username: "intruder", password: "another-long-password" });
    expect(second.status).toBe(404);
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(await countUsers(env.DB)).toBe(1);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await anon("/setup", { username: "root", password: "short" });
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(0);
  });
});

describe("/login", () => {
  beforeEach(resetDb);

  it("signs in with the right password and gives the same generic error for a bad password and a missing user", async () => {
    const { password } = await seedUser({ username: "alice" });
    const ok = await anon("/login", { username: "alice", password });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Set-Cookie")).toContain("sg_session=");
    const bad = await anon("/login", { username: "alice", password: "wrong-password-x" });
    const spy = vi.spyOn(auth, "verifyPassword");
    try {
      const missing = await anon("/login", { username: "nobody", password: "wrong-password-x" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(bad.status).toBe(401);
      expect(missing.status).toBe(401);
      expect(await bad.text()).toContain("Incorrect username or password");
      expect(await missing.text()).toContain("Incorrect username or password");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/me", () => {
  beforeEach(resetDb);

  it("shows only the Account title, no install key and no flash", async () => {
    await seedProject("team-b", "Team B");
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b", "b".repeat(32));
    const res = await get("/me", cookie);
    expect(res.status).toBe(200);
    expect(flashCookie(res)).toBeUndefined();
    const html = await res.text();
    expect(html).not.toContain("cf-done");
    const head = /<header class="cf-head">([\s\S]*?)<\/header>/.exec(html)?.[1];
    expect(head).toContain("Account");
    expect(head).not.toContain("alice");
    expect(head).not.toContain("cf-vis");
    expect(html).not.toContain("Install keys");
    expect(html).not.toContain("npx skillsgist add");
    expect(html).not.toContain(await installKey(user.id));
    expect(html).not.toContain("b".repeat(32));
    expect(html).not.toContain("install-key");
  });

  it("issues an api token once, with its own copy button, and stores only its hash", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const html = await (await postForm("/me/api-token", cookie)).text();
    expect(html.match(/class="cf-command-copy"/g)).toHaveLength(1);
    const token = /<code class="cf-command-text">(sgt_[a-f0-9]{32})<\/code>/.exec(html)?.[1];
    expect((await getUserByUsername(env.DB, "alice"))?.api_token_hash).toBe(await sha256Hex(token!));
  });

  it("puts token revocation behind a confirm step, and offers none without a token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const page = async () => (await get("/me", cookie)).text();
    expect(await page()).not.toContain("/me/api-token/revoke");

    await postForm("/me/api-token", cookie);
    const html = await page();
    const blocks = confirmBlocks(html, "revoke-api-token");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<summary class="cf-btn cf-btn-danger">Revoke</summary>');
    expect(blocks[0]).toContain('<p class="cf-hint">Revoking stops your current token from working at once');
    expect(blocks[0]).toContain('action="/me/api-token/revoke"');
    expect(blocks[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke API token</button>');
    expect(html.split("/me/api-token/revoke")).toHaveLength(2);
  });

  it("changes the password and confirms it once through a short-lived, http-only flash", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const res = await changePassword(cookie, password);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/me");
    for (const attr of [/Max-Age=60/i, /Path=\//i, /HttpOnly/i, /SameSite=Lax/i]) expect(flashCookie(res)).toMatch(attr);
    const shown = await follow(res, cookie);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toMatch(
      /<p class="cf-done" role="status">[\s\S]*?Your password has been changed, and every computer signed in with the CLI was signed out\.<\/span><\/p>/,
    );
    expect(html).not.toContain("cf-alert");
    expect(flashCookie(shown)).toMatch(FLASH_CLEARED);
    expect(await (await get("/me", cookie)).text()).not.toContain("cf-done");
    await login("alice", "another-long-password");
  });

  it("does not show one session's flash in another session", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob" });
    const res = await changePassword(alice.cookie, alice.password);
    expect(flashCookie(res)).toBeDefined();
    const shown = await follow(res, bob.cookie);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).not.toContain("cf-done");
    expect(html).not.toContain("Your password has been changed.");
    expect(flashCookie(shown)).toMatch(FLASH_CLEARED);
  });

  it("ignores and clears a flash cookie it did not sign, or a signed session value planted as one", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    for (const planted of [
      `${FLASH_COOKIE}=Visit%20evil.example`,
      `${FLASH_COOKIE}=${encodeURIComponent(`Visit evil.example.${"A".repeat(43)}=`)}`,
      cookie.replace(/^sg_session=/, `${FLASH_COOKIE}=`),
    ]) {
      const res = await get("/me", `${cookie}; ${planted}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("cf-done");
      expect(html).not.toContain("evil.example");
      expect(html).not.toContain("&quot;uid&quot;");
      expect(flashCookie(res)).toMatch(FLASH_CLEARED);
    }
  });

  it("sets no flash when the change is refused", async () => {
    const { password, cookie } = await seedAndLogin({ username: "alice" });
    const wrong = await changePassword(cookie, "wrong-password-x");
    expect(wrong.status).toBe(400);
    expect(flashCookie(wrong)).toBeUndefined();
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("Current password is incorrect");
    expect(wrongHtml).not.toContain("cf-done");
    const short = await changePassword(cookie, password, "short");
    expect(short.status).toBe(400);
    expect(flashCookie(short)).toBeUndefined();
    expect(await short.text()).not.toContain("cf-done");
  });
});

describe("CLI sign-ins on /me", () => {
  beforeEach(resetDb);

  it("lists each signed-in computer with its usable projects and revokes one behind a confirm step", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const { id, token } = await signInDevice(user.id, ["default"]);
    const html = await (await get("/me", cookie)).text();
    expect(html).toContain("CLI sign-ins");
    expect(html).toContain("test-laptop");
    expect(html).toContain("Default");
    expect(html).toMatch(new RegExp(`<details class="cf-confirm" name="revoke-cli-login">[\\s\\S]*?action="/me/cli-logins/${id}/revoke"`));
    const res = await postForm(`/me/cli-logins/${id}/revoke`, cookie);
    expect(res.status).toBe(302);
    expect(await (await follow(res, cookie)).text()).toContain("Signed test-laptop out.");
    expect((await fetchWith("/api/whoami", bearer(token))).status).toBe(401);
  });

  it("marks a computer with no usable project, and one unused for 90 days", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await signInDevice(user.id, []);
    await signInDevice(user.id, ["default"], Date.now() - 91 * 24 * 60 * 60 * 1000);
    const html = await (await get("/me", cookie)).text();
    expect(html).toContain("No usable projects");
    expect(html).toContain("Expired");
  });

  it("says how to sign in when no computer is signed in", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    expect(await (await get("/me", cookie)).text()).toContain("<code>npx skillsgist login http://localhost</code>");
  });

  it("404s revoking another user's sign-in", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const bob = await seedUser({ username: "bob" });
    const { id, token } = await signInDevice(bob.user.id, ["default"]);
    expect((await postForm(`/me/cli-logins/${id}/revoke`, cookie)).status).toBe(404);
    expect((await fetchWith("/api/whoami", bearer(token))).status).toBe(200);
  });

  it("signs every computer out when the password changes", async () => {
    const { user, cookie, password } = await seedAndLogin({ username: "alice" });
    const { token } = await signInDevice(user.id, ["default"]);
    const res = await postForm("/me/password", cookie, { current: password, next: "another-long-password" });
    expect(res.status).toBe(302);
    expect((await fetchWith("/api/whoami", bearer(token))).status).toBe(401);
  });
});

describe("/admin/users", () => {
  beforeEach(resetDb);

  it("lets an admin create a member and returns to the list", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await postForm("/admin/users/new", cookie, { username: "carol", password: "carols-long-password", role: "member" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/users");
    const carol = await getUserByUsername(env.DB, "carol");
    expect(carol?.role).toBe("member");
    expect(await membership(carol!.id)).toBeNull();
  });

  it("lists each account's role, projects, created skills, join date and last sign-in, linked to its settings", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    await seedProject("team-b", "Team B");
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    await joinProject(carol.user.id, "team-b", "c".repeat(32));
    await publishMarkdown(carol.cookie, GOOD_MD, "private", "default");
    await env.DB.prepare("UPDATE users SET created_at = ?, last_login_at = NULL WHERE id = ?")
      .bind(Date.UTC(2026, 8, 1), carol.user.id)
      .run();

    const html = await (await get("/admin/users", root.cookie)).text();
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

    expect(html).toContain('href="/admin/users/new"');
    expect(html).not.toContain('action="/admin/users/new"');
    expect(html).not.toContain('name="username"');
    expect(html).not.toContain('<th scope="col">Actions</th>');
    for (const action of ["role", "password", "install-key", "api-token", "api-token/revoke", "delete"]) {
      expect(html).not.toContain(`/${action}"`);
    }
  });
});

describe("/admin/users/new", () => {
  beforeEach(resetDb);

  it("renders a form that posts to itself with a Cancel back to the list", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const res = await get("/admin/users/new", cookie);
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

  it.each([
    ["a short password", "carol", "short", "Password must be at least 12 characters"],
    ["a malformed username", "Carol!", "carols-long-password", "Username must be 2-32 lowercase letters, digits or hyphens"],
    ["a taken username", "taken", "another-long-password", "That username is taken"],
  ])("re-renders itself with the error and the typed values on %s", async (_label, username, password, error) => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: taken } = await seedUser({ username: "taken", role: "member" });
    const res = await postForm("/admin/users/new", cookie, { username, password, role: "admin" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(error);
    expect(html).toContain('action="/admin/users/new"');
    expect(html).not.toContain('class="cf-table"');
    expect(html).toContain(`value="${username}"`);
    expect(html).toContain('<option value="admin" selected="">admin</option>');
    expect(html).not.toContain(`value="${password}"`);
    expect(await countUsers(env.DB)).toBe(2);
    const after = await getUserByUsername(env.DB, "taken");
    expect(after?.role).toBe("member");
    expect(after?.password_hash).toBe(taken.password_hash);
  });
});

// Spec §7.1 specifies GET/POST /admin/users covering create, change role,
// reset password and delete. These five routes are the revocation levers a
// departed member's account needs: without them an admin has no way to demote,
// rotate a leaked install_key, or remove the account at all — only the member
// themselves could rotate their own key from /me.
describe("/admin/users/:id", () => {
  beforeEach(resetDb);

  it("gives an admin every control over another account, with revocation behind a confirm step", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const carol = await seedAndLogin({ username: "carol", role: "member" });
    await postForm("/me/api-token", carol.cookie);
    const res = await get(`/admin/users/${carol.user.id}`, cookie);
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
    expect(html).toContain(`action="/admin/users/${id}/api-token"`);
    expect(html).toContain("Generating a token replaces carol&#39;s current one at once.");
    expect(html).toContain(`action="/admin/users/${id}/password"`);
    expect(html).toContain(`action="/admin/users/${id}/delete"`);
    expect(html.split(`/admin/users/${id}/api-token/revoke`)).toHaveLength(2);
    const blocks = confirmBlocks(html, "revoke-api-token");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<summary class="cf-btn cf-btn-danger">Revoke API token</summary>');
    expect(blocks[0]).toContain('<p class="cf-hint">Revoking stops carol&#39;s current token from working at once');
    expect(blocks[0]).toContain(`action="/admin/users/${id}/api-token/revoke"`);
    expect(blocks[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke carol&#39;s token</button>');
  });

  it("leaves the role and delete controls off the viewer's own page, and lets them manage their own token", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const id = root.user.id;
    const html = await (await get(`/admin/users/${id}`, root.cookie)).text();
    expect(html).toContain(`action="/admin/users/${id}/install-key"`);
    expect(html).toContain(`action="/admin/users/${id}/password"`);
    expect(html).toContain(`action="/admin/users/${id}/api-token"`);
    expect(html).toContain("The new token is shown only once, on this page.");
    expect(html).not.toContain("replaces your current one");
    expect(html).not.toContain(`/admin/users/${id}/role`);
    expect(html).not.toContain(`/admin/users/${id}/delete`);
    expect(html).toContain("Only another admin can change your role.");

    const res = await postForm(`/admin/users/${id}/api-token`, root.cookie);
    expect(res.status).toBe(200);
    const token = /sgt_[a-f0-9]{32}/.exec(await res.text())?.[0];
    expect((await getUserByUsername(env.DB, "root"))?.api_token_hash).toBe(await sha256Hex(token!));
    const after = await (await get(`/admin/users/${id}`, root.cookie)).text();
    expect(after.split(`/admin/users/${id}/api-token/revoke`)).toHaveLength(2);
    const own = confirmBlocks(after, "revoke-api-token");
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('<p class="cf-hint">Revoking stops your current token from working at once');
    expect(own[0]).toContain('<button type="submit" class="cf-btn cf-btn-danger">Revoke your token</button>');
  });

  it("says an account in no project has no install keys, one without a token has nothing to revoke, and puts deletion behind a confirm step", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: dave } = await seedUser({ username: "dave", role: "member", project: null });
    const html = await (await get(`/admin/users/${dave.id}`, cookie)).text();
    expect(html).toContain("dave is in no project and has no CLI sign-ins.");
    expect(html).not.toContain(`/admin/users/${dave.id}/install-key`);
    expect(html).toContain('<span class="cf-status-value">not generated</span>');
    expect(html).not.toContain(`/admin/users/${dave.id}/api-token/revoke`);
    expect(html).toContain(`action="/admin/users/${dave.id}/api-token"`);
    expect(html).not.toContain("replaces dave");
    const blocks = html.match(/<div class="cf-actions"><details class="cf-confirm" name="delete-user">[\s\S]*?<\/details><\/div>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(`<summary class="cf-btn cf-btn-danger">Delete account</summary>`);
    expect(blocks[0]).toContain(`<p class="cf-hint">Deleting reassigns`);
    expect(blocks[0]).toContain(`action="/admin/users/${dave.id}/delete"`);
    expect(blocks[0]).toContain(`<button type="submit" class="cf-btn cf-btn-danger">Delete dave</button>`);
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

    expect((await putSkill(old, GOOD_MD, { project: "default" })).status).toBe(404);
    expect((await putSkill(token!, GOOD_MD, { project: "default" })).status).toBe(201);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(carol.user.id);

    const again = await (await get(`/admin/users/${carol.user.id}`, cookie)).text();
    expect(again).not.toContain(token!);
    expect(again).toContain('<span class="cf-status-value cf-status-on">active</span>');
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

  it("denies every admin page and route to a member with 403", async () => {
    const { user, cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const target = await seedUser({ username: "carol", role: "member" });
    for (const path of ["/admin/users", "/admin/users/new", `/admin/users/${target.user.id}`, `/admin/users/${user.id}`]) {
      expect((await get(path, cookie)).status, path).toBe(403);
    }
    const create = await postForm("/admin/users/new", cookie, { username: "dave", password: "daves-long-password" });
    expect(create.status).toBe(403);
    expect(await getUserByUsername(env.DB, "dave")).toBeNull();
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/${target.user.id}/${path}`, cookie, body);
      expect(res.status).toBe(403);
      expect(flashCookie(res)).toBeUndefined();
    }
  });

  it("404s for an unknown user id on every route", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    expect((await get("/admin/users/does-not-exist", cookie)).status).toBe(404);
    for (const { path, body } of endpoints) {
      const res = await postForm(`/admin/users/does-not-exist/${path}`, cookie, body);
      expect(res.status).toBe(404);
      expect(flashCookie(res)).toBeUndefined();
    }
  });

  it("lets an admin promote a member, and demote them again while another admin remains", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    for (const role of ["admin", "member"]) {
      const res = await postForm(`/admin/users/${target.user.id}/role`, cookie, { role });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
      expect((await getUserByUsername(env.DB, "carol"))?.role).toBe(role);
    }
  });

  it("lets an admin reset a member's password, refusing a short one, and confirms it by username", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "carol", role: "member" });
    const short = await postForm(`/admin/users/${target.user.id}/password`, cookie, { password: "short" });
    expect(short.status).toBe(400);
    expect(flashCookie(short)).toBeUndefined();
    const shortHtml = await short.text();
    expect(shortHtml).toContain("Password must be at least 12 characters");
    expect(shortHtml).toContain('<h1 class="cf-head-title">carol settings</h1>');
    expect(shortHtml).not.toContain('value="short"');
    expect(shortHtml).not.toContain("cf-done");

    const res = await postForm(`/admin/users/${target.user.id}/password`, cookie, { password: "carols-new-long-password" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    await login("carol", "carols-new-long-password");
    const html = await (await follow(res, cookie)).text();
    expect(html).toMatch(
      /<p class="cf-done" role="status">[\s\S]*?Password reset for carol\. Their computers signed in with the CLI were signed out\.<\/span><\/p>/,
    );
  });

  it("lets an admin revoke a member's api token", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedAndLogin({ username: "carol", role: "member" });
    await postForm("/me/api-token", target.cookie);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).not.toBeNull();

    const res = await postForm(`/admin/users/${target.user.id}/api-token/revoke`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    expect((await getUserByUsername(env.DB, "carol"))?.api_token_hash).toBeNull();
  });

  // The last-admin guard only checks the *count* of admins, so on its own it
  // never stops an admin from targeting their own id while a second admin
  // exists — which is exactly the corruption deleteUserReassigning's
  // `reassignTo` precondition describes. Refusal must not depend on how many
  // other admins there are.
  it.each([
    ["the only admin", false],
    ["one of two admins", true],
  ])("refuses to let %s demote or delete themselves", async (_label, second) => {
    const { user: root, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    if (second) await seedUser({ username: "second-admin", role: "admin" });
    await publishMarkdown(cookie, GOOD_MD, "public");

    const demote = await postForm(`/admin/users/${root.id}/role`, cookie, { role: "member" });
    expect(demote.status).toBe(400);
    const demoted = await demote.text();
    expect(demoted).toContain('<h1 class="cf-head-title">root settings</h1>');
    expect(demoted).toContain('<p class="cf-alert" role="alert">');
    const del = await postForm(`/admin/users/${root.id}/delete`, cookie);
    expect(del.status).toBe(400);
    expect(await del.text()).toContain("You cannot delete your own account. Ask another admin.");
    expect((await getUserByUsername(env.DB, "root"))?.role).toBe("admin");
    expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(root.id);
  });

  it("rotating a member's install keys revokes every old one and enables the new ones", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "dave", role: "member" });
    await joinProject(target.user.id, "team-b", "b".repeat(32));
    const keys = () => Promise.all([installKey(target.user.id), installKey(target.user.id, "team-b")]);
    const oldKeys = await keys();

    const res = await postForm(`/admin/users/${target.user.id}/install-key`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/users/${target.user.id}`);
    const html = await (await follow(res, cookie)).text();
    expect(html).toMatch(
      /<p class="cf-done" role="status">[\s\S]*?Rotated dave&#39;s install keys and signed their computers out\.<\/span><\/p>/,
    );

    const newKeys = await keys();
    expect(newKeys[0]).not.toBe(newKeys[1]);
    for (const key of newKeys) {
      expect(key).toMatch(/^sgi_[a-f0-9]{64}$/);
      expect(oldKeys).not.toContain(key);
    }
  });

  it("signs a member's computers out when an admin resets their password or rotates their install keys", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const target = await seedUser({ username: "dave", role: "member" });
    const first = await signInDevice(target.user.id, ["default"]);
    await postForm(`/admin/users/${target.user.id}/password`, cookie, { password: "a-fresh-long-password" });
    expect((await fetchWith("/api/whoami", bearer(first.token))).status).toBe(401);
    const second = await signInDevice(target.user.id, ["default"]);
    const page = await (await get(`/admin/users/${target.user.id}`, cookie)).text();
    expect(page).toContain("dave has 1 install key, one per project, and 1 CLI sign-in.");
    await postForm(`/admin/users/${target.user.id}/install-key`, cookie);
    expect((await fetchWith("/api/whoami", bearer(second.token))).status).toBe(401);
  });

  it.each(["member", "admin"] as const)(
    "reassigns a deleted %s's skills and version authorship to the acting admin, and keeps the skill downloadable",
    async (role) => {
      const { user: root, cookie } = await seedAndLogin({ username: "root", role: "admin" });
      const erin = await seedAndLogin({ username: "erin", role });
      await publishMarkdown(erin.cookie, GOOD_MD, "public");

      const res = await postForm(`/admin/users/${erin.user.id}/delete`, cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/users");
      const listed = await (await follow(res, cookie)).text();
      expect(listed).toMatch(/<p class="cf-done" role="status">[\s\S]*?Deleted erin\.<\/span><\/p>/);

      expect(await getUserByUsername(env.DB, "erin")).toBeNull();
      expect((await getSkill(env.DB, "default", "demo-skill"))?.owner_id).toBe(root.id);
      expect((await getVersion(env.DB, "default", "demo-skill", 1))?.author_id).toBe(root.id);
      expect((await get("/p/default/s/demo-skill/download", cookie)).status).toBe(200);
    },
  );
});
