import { SELF } from "cloudflare:test";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionCsrf } from "../src/auth";
import type { Ctx } from "../src/auth";
import { SAFE_METHODS } from "../src/csrf";
import { getSkill, getUserById } from "../src/db/queries";
import app from "../src/index";
import { Layout } from "../src/views/layout";
import {
  csrfFor, env as bindings, GOOD_MD, installKey, login, ORIGIN, postForm, publishMarkdown, resetDb,
  seedAndLogin, seedUser,
} from "./helpers";
import type { Env } from "../src/types";

// `SESSION_SECRET` is a plain string binding, not one of the typed ones in
// helpers' `env`, so this file widens the same object rather than re-casting
// `cloudflare:test`'s.
const env = bindings as typeof bindings & { SESSION_SECRET: string };

// ---------------------------------------------------------------------------
// The two exemptions from the session-bound token check, each with a test
// below pinning the reason it is safe. Nothing else may skip the check.
// ---------------------------------------------------------------------------
const EXEMPT = new Set([
  // Bearer-authenticated; never reads the session cookie. See
  // "an /api/* route cannot be authenticated by a session cookie" below.
  "PUT /api/projects/:project/skills/:slug",
  // No session exists yet, so there is no session-bound token to send.
  // Covered by the Origin / Sec-Fetch-Site layer only — see TOKENLESS_PATHS.
  "POST /setup",
  "POST /login",
]);

// Every other state-changing route, mapped to a concrete path so the sweep
// below can actually fire a tokenless request at each one.
const PROTECTED: Record<string, (ids: { userId: string; slug: string }) => string> = {
  "POST /logout": () => "/logout",
  "POST /lang": () => "/lang",
  "POST /me/api-token": () => "/me/api-token",
  "POST /me/api-token/revoke": () => "/me/api-token/revoke",
  "POST /me/password": () => "/me/password",
  "POST /admin/users/new": () => "/admin/users/new",
  "POST /admin/users/:id/role": ({ userId }) => `/admin/users/${userId}/role`,
  "POST /admin/users/:id/password": ({ userId }) => `/admin/users/${userId}/password`,
  "POST /admin/users/:id/install-key": ({ userId }) => `/admin/users/${userId}/install-key`,
  "POST /admin/users/:id/api-token": ({ userId }) => `/admin/users/${userId}/api-token`,
  "POST /admin/users/:id/api-token/revoke": ({ userId }) => `/admin/users/${userId}/api-token/revoke`,
  "POST /admin/users/:id/delete": ({ userId }) => `/admin/users/${userId}/delete`,
  "POST /new": () => "/new",
  "POST /projects/new": () => "/projects/new",
  "POST /p/:project/install-key": () => "/p/default/install-key",
  "POST /p/:project/rename": () => "/p/default/rename",
  "POST /p/:project/members": () => "/p/default/members",
  "POST /p/:project/members/:userId/role": ({ userId }) => `/p/default/members/${userId}/role`,
  "POST /p/:project/members/:userId/publish": ({ userId }) => `/p/default/members/${userId}/publish`,
  "POST /p/:project/members/:userId/remove": ({ userId }) => `/p/default/members/${userId}/remove`,
  "POST /p/:project/delete": () => "/p/default/delete",
  "POST /p/:project/s/:slug/edit": ({ slug }) => `/p/default/s/${slug}/edit`,
  "POST /p/:project/s/:slug/upload": ({ slug }) => `/p/default/s/${slug}/upload`,
  "POST /p/:project/s/:slug/visibility": ({ slug }) => `/p/default/s/${slug}/visibility`,
  "POST /p/:project/s/:slug/move": ({ slug }) => `/p/default/s/${slug}/move`,
  "POST /p/:project/s/:slug/delete": ({ slug }) => `/p/default/s/${slug}/delete`,
};

// Read-only routes. Listed exhaustively rather than pattern-matched, because
// "is this GET state-changing?" cannot be decided mechanically: `SameSite=Lax`
// deliberately allows cookies on top-level GET navigation, so a mutating GET
// would be CSRF-able no matter what the middleware does. Pinning the list
// means adding a GET route forces someone to look at this comment and confirm
// the route only reads.
const READ_ONLY_GETS = new Set([
  "GET /healthz",
  "GET /.well-known/agent-skills/index.json",
  "GET /.well-known/skills/index.json",
  // The CLI's single-install fallback of appending another .well-known layer to the whole URL. Read-only: returns the narrowed index.
  "GET /.well-known/agent-skills/*",
  "GET /.well-known/skills/*",
  "GET /p/:project/.well-known/agent-skills/index.json",
  "GET /p/:project/.well-known/skills/index.json",
  "GET /p/:project/.well-known/agent-skills/*",
  "GET /p/:project/.well-known/skills/*",
  "GET /d/:slug/:file",
  "GET /p/:project/d/:slug/:file",
  "GET /setup",
  "GET /login",
  "GET /me",
  "GET /admin/users",
  "GET /admin/users/new",
  "GET /admin/users/:id",
  "GET /new",
  "GET /projects",
  "GET /projects/new",
  "GET /p/:project",
  "GET /p/:project/settings",
  "GET /p/:project/s/:slug/edit",
  "GET /p/:project/s/:slug/upload",
  "GET /",
  "GET /p/:project/s/:slug",
  "GET /p/:project/s/:slug/download",
  "GET /p/:project/s/:slug/v/:version/download",
]);

// `app.routes` is flattened across every sub-app mounted with `.route()`;
// middleware registered with `app.use("*")` shows up as `ALL /*`.
const registered = () =>
  app.routes.filter((r) => r.path !== "/*").map((r) => `${r.method} ${r.path}`);

const FORM = { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN };

const post = (path: string, cookie: string, body: BodyInit, headers: Record<string, string> = FORM) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { Cookie: cookie, ...headers }, body, redirect: "manual" });

describe("route inventory (guards against a new route slipping through)", () => {
  it("accounts for every registered route, with no stale entries in any list", () => {
    const all = registered();
    const mutating = all.filter((key) => !SAFE_METHODS.has(key.split(" ")[0]));
    expect(mutating.filter((key) => !EXEMPT.has(key) && !(key in PROTECTED))).toEqual([]);
    expect(all.filter((key) => key.startsWith("GET ") && !READ_ONLY_GETS.has(key))).toEqual([]);
    const known = new Set(all);
    expect([...EXEMPT].filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(PROTECTED).filter((k) => !known.has(k))).toEqual([]);
    expect([...READ_ONLY_GETS].filter((k) => !known.has(k))).toEqual([]);
  });
});

describe("token layer", () => {
  beforeEach(resetDb);

  it("rejects every protected route when the token is missing", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    await publishMarkdown(cookie, GOOD_MD, "private");
    const { user: target } = await seedUser({ username: "bob", role: "member" });
    const bobKey = await installKey(target.id);

    for (const [key, toPath] of Object.entries(PROTECTED)) {
      const path = toPath({ userId: target.id, slug: "demo-skill" });
      const res = await post(path, cookie, new URLSearchParams({ role: "admin", password: "a-very-long-password" }));
      expect(res.status, `${key} should reject a tokenless request`).toBe(403);
    }
    const bobAfter = await getUserById(env.DB, target.id);
    expect(bobAfter?.role).toBe("member");
    expect(await installKey(target.id)).toBe(bobKey);
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it.each<[string, () => Promise<string>]>([
    ["an empty", async () => ""],
    ["a wrong", async () => "f".repeat(32)],
    ["another session's", async () => csrfFor((await seedAndLogin({ username: "bob" })).cookie)],
  ])("rejects %s token", async (_label, tokenFor) => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await post("/p/default/install-key", cookie, new URLSearchParams({ _csrf: await tokenFor() }));
    expect(res.status).toBe(403);
  });

  // text/plain is one of the three content-types a cross-site form can send.
  // `parseBody` returns `{}` for it, so there is no token to find — the check
  // has to fail closed rather than treat "unparseable" as "no token required".
  it("rejects a text/plain body, which carries no parseable token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const body = `_csrf=${await csrfFor(cookie)}`;
    const res = await post("/p/default/install-key", cookie, body, { "Content-Type": "text/plain", Origin: ORIGIN });
    expect(res.status).toBe(403);
  });
});

describe("Origin / Sec-Fetch-Site layer", () => {
  beforeEach(resetDb);

  // The subdomain case SameSite=Lax leaves open: Lax is scoped to the
  // registrable domain, so a sibling subdomain counts as same-site and gets
  // the session cookie attached. Sec-Fetch-Site is what distinguishes it.
  it.each([
    ["neither Origin nor Sec-Fetch-Site", {}, 403],
    ["a cross-origin Origin", { Origin: "http://evil.example.com" }, 403],
    ["Sec-Fetch-Site: same-site", { "Sec-Fetch-Site": "same-site" }, 403],
    ["Sec-Fetch-Site: same-origin and no Origin", { "Sec-Fetch-Site": "same-origin" }, 302],
  ])("answers a valid token with %s with %i, never the generic 500", async (_label, headers, status) => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const body = new URLSearchParams({ _csrf: await csrfFor(cookie) });
    const res = await post("/p/default/install-key", cookie, body, { "Content-Type": FORM["Content-Type"], ...headers });
    expect(res.status).toBe(status);
    expect(await res.text()).not.toContain("Internal server error");
  });
});

describe("/api/* exemption", () => {
  beforeEach(resetDb);

  // This is what makes exempting `/api/*` by path sound rather than a guess:
  // the namespace has no cookie-authenticated door, so skipping the token
  // check there cannot expose anything.
  it("cannot be authenticated by a session cookie alone", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await SELF.fetch(`${ORIGIN}/api/projects/default/skills/demo-skill`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(404);
  });
});

describe("session payload", () => {
  beforeEach(resetDb);

  it("issues a distinct token per session", async () => {
    const { password } = await seedUser({ username: "alice" });
    const first = await csrfFor(await login("alice", password));
    const second = await csrfFor(await login("alice", password));
    expect(first).not.toBe(second);
  });

  it("treats a session minted without a csrf field as no session at all", async () => {
    const { user } = await seedUser({ username: "alice" });

    // A pre-CSRF session cookie, signed with the real secret so only the
    // missing `csrf` field distinguishes it from a current one.
    const minter = new Hono();
    minter.get("/", async (c) => {
      await setSignedCookie(
        c,
        SESSION_COOKIE,
        JSON.stringify({ uid: user.id, exp: Date.now() + 60_000 }),
        env.SESSION_SECRET,
        { path: "/" },
      );
      return c.text("ok");
    });
    const legacy = (await minter.request(`${ORIGIN}/`)).headers.get("Set-Cookie")!.split(";")[0];

    const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: legacy }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });
});

describe("page() and <Form>", () => {
  beforeEach(resetDb);

  it("keeps concurrent renders from seeing each other's token", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob" });

    const [a, b] = await Promise.all([csrfFor(alice.cookie), csrfFor(bob.cookie)]);
    expect(a).not.toBe(b);
    // Each token must be the one its own session actually holds.
    // `sessionCsrf` memoises the session read on the context, so the stub
    // needs the per-request variable storage a real Context provides.
    const sessionOf = async (cookie: string) => {
      const vars = new Map<string, unknown>();
      return sessionCsrf({
        env,
        req: { raw: new Request(ORIGIN, { headers: { Cookie: cookie } }) },
        get: (key: string) => vars.get(key),
        set: (key: string, value: unknown) => vars.set(key, value),
      } as unknown as Ctx);
    };
    expect(await sessionOf(alice.cookie)).toBe(a);
    expect(await sessionOf(bob.cookie)).toBe(b);
  });

  it("throws rather than emitting an empty token when rendered outside page()", async () => {
    const { user } = await seedUser({ username: "alice" });
    const bare = new Hono<{ Bindings: Env }>();
    // Layout renders the logout <Form> whenever a user is signed in.
    bare.get("/", (c) => c.html(<Layout title="t" user={user} />));
    bare.onError((err) => new Response(err.message, { status: 500 }));
    const res = await bare.request(`${ORIGIN}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("CsrfField rendered outside page()");
  });
});

describe("rendered forms", () => {
  beforeEach(resetDb);

  const formsIn = (html: string) =>
    [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const postFormsIn = (html: string) =>
    formsIn(html).filter((f) => /<form[^>]*\bmethod="post"/i.test(f));

  it("puts a token in every POST form on every signed-in page", async () => {
    const { user, cookie } = await seedAndLogin({ username: "root", role: "admin" });
    await publishMarkdown(cookie, GOOD_MD, "private");

    for (const path of [
      "/", "/p/default/s/demo-skill", "/me", "/admin/users", "/admin/users/new", `/admin/users/${user.id}`, "/new", "/p/default/s/demo-skill/edit",
      "/p/default/s/demo-skill/upload", "/projects", "/projects/new", "/p/default",
    ]) {
      const html = await (await SELF.fetch(`${ORIGIN}${path}`, { headers: { Cookie: cookie } })).text();
      const forms = postFormsIn(html);
      expect(forms.length, `${path} should render at least one POST form`).toBeGreaterThan(0);
      for (const form of forms) {
        expect(form, `a POST form on ${path} has no CSRF token`).toContain('name="_csrf"');
      }
    }
  });

  // Pinned so the two token-less pages read as a deliberate exemption rather
  // than an oversight. See TOKENLESS_PATHS in src/csrf.tsx.
  it("leaves the bootstrap and login forms without a token", async () => {
    const own = (html: string, action: string) => postFormsIn(html).filter((f) => f.includes(`action="${action}"`));

    const setup = await (await SELF.fetch(`${ORIGIN}/setup`)).text();
    expect(own(setup, "/setup")).toHaveLength(1);
    expect(setup).not.toContain('name="_csrf"');

    await seedUser({ username: "alice" });
    const loginHtml = await (await SELF.fetch(`${ORIGIN}/login`)).text();
    expect(own(loginHtml, "/login")).toHaveLength(1);
    expect(loginHtml).not.toContain('name="_csrf"');
  });

  // A token in a GET form would land in the query string and from there in
  // outgoing Referer headers.
  it("keeps the search form a token-less GET", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const searchForm = formsIn(html).find((f) => f.includes('action="/"'))!;
    expect(searchForm).toContain('method="get"');
    expect(searchForm).not.toContain("_csrf");
  });
});
