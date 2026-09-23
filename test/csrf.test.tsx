import { SELF } from "cloudflare:test";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionCsrf } from "../src/auth";
import type { Ctx } from "../src/auth";
import { page, SAFE_METHODS } from "../src/csrf";
import { getSkill, getUserById } from "../src/db/queries";
import app from "../src/index";
import { Layout } from "../src/views/layout";
import {
  csrfFor, env as bindings, GOOD_MD, login, ORIGIN, postForm, publishMarkdown, resetDb,
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
  "PUT /api/skills/:slug",
  // No session exists yet, so there is no session-bound token to send.
  // Covered by the Origin / Sec-Fetch-Site layer only — see TOKENLESS_PATHS.
  "POST /setup",
  "POST /login",
]);

// Every other state-changing route, mapped to a concrete path so the sweep
// below can actually fire a tokenless request at each one.
const PROTECTED: Record<string, (ids: { userId: string; slug: string }) => string> = {
  "POST /logout": () => "/logout",
  "POST /me/install-key": () => "/me/install-key",
  "POST /me/api-token": () => "/me/api-token",
  "POST /me/api-token/revoke": () => "/me/api-token/revoke",
  "POST /me/password": () => "/me/password",
  "POST /admin/users": () => "/admin/users",
  "POST /admin/users/:id/role": ({ userId }) => `/admin/users/${userId}/role`,
  "POST /admin/users/:id/password": ({ userId }) => `/admin/users/${userId}/password`,
  "POST /admin/users/:id/install-key": ({ userId }) => `/admin/users/${userId}/install-key`,
  "POST /admin/users/:id/api-token/revoke": ({ userId }) => `/admin/users/${userId}/api-token/revoke`,
  "POST /admin/users/:id/delete": ({ userId }) => `/admin/users/${userId}/delete`,
  "POST /new": () => "/new",
  "POST /s/:slug/edit": ({ slug }) => `/s/${slug}/edit`,
  "POST /s/:slug/upload": ({ slug }) => `/s/${slug}/upload`,
  "POST /s/:slug/visibility": ({ slug }) => `/s/${slug}/visibility`,
  "POST /s/:slug/delete": ({ slug }) => `/s/${slug}/delete`,
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
  "GET /d/:slug/:file",
  "GET /i/:key/d/:slug/:file",
  "GET /i/:key/*",
  "GET /setup",
  "GET /login",
  "GET /me",
  "GET /admin/users",
  "GET /new",
  "GET /s/:slug/edit",
  "GET /s/:slug/upload",
  "GET /",
  "GET /s/:slug",
  "GET /s/:slug/download",
  "GET /s/:slug/v/:version/download",
]);

// `app.routes` is flattened across every sub-app mounted with `.route()`;
// middleware registered with `app.use("*")` shows up as `ALL /*`.
const registered = () =>
  app.routes.filter((r) => r.path !== "/*").map((r) => `${r.method} ${r.path}`);

describe("route inventory (guards against a new route slipping through)", () => {
  it("accounts for every state-changing route", () => {
    const mutating = registered().filter((key) => !SAFE_METHODS.has(key.split(" ")[0]));
    const unaccounted = mutating.filter((key) => !EXEMPT.has(key) && !(key in PROTECTED));
    expect(unaccounted).toEqual([]);
  });

  it("has no stale entries in either list", () => {
    const all = new Set(registered());
    expect([...EXEMPT].filter((k) => !all.has(k))).toEqual([]);
    expect(Object.keys(PROTECTED).filter((k) => !all.has(k))).toEqual([]);
    expect([...READ_ONLY_GETS].filter((k) => !all.has(k))).toEqual([]);
  });

  it("registers no state-changing GET route", () => {
    const gets = registered().filter((key) => key.startsWith("GET "));
    expect(gets.filter((key) => !READ_ONLY_GETS.has(key))).toEqual([]);
  });
});

describe("token layer", () => {
  beforeEach(resetDb);

  it("rejects every protected route when the token is missing", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    await publishMarkdown(cookie, GOOD_MD, "private");
    const { user: target } = await seedUser({ username: "bob", role: "member" });

    for (const [key, toPath] of Object.entries(PROTECTED)) {
      const path = toPath({ userId: target.id, slug: "demo-skill" });
      const res = await SELF.fetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          Cookie: cookie,
        },
        // A plausible body for whichever route this is, minus the token.
        body: new URLSearchParams({ role: "admin", password: "a-very-long-password" }),
        redirect: "manual",
      });
      expect(res.status, `${key} should reject a tokenless request`).toBe(403);
    }
    // None of those 15 rejected requests mutated anything: bob is untouched
    // (no role change, no key rotation, no delete) and the skill still exists.
    const bobAfter = await getUserById(env.DB, target.id);
    expect(bobAfter?.role).toBe("member");
    expect(bobAfter?.install_key).toBe(target.install_key);
    expect(await getSkill(env.DB, "demo-skill")).not.toBeNull();
  });

  it("accepts a request carrying the session's token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await postForm("/me/install-key", cookie);
    expect(res.status).toBe(302);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong", "f".repeat(32)],
  ])("rejects a $0 token", async (_label, token) => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const body = new URLSearchParams();
    if (token !== undefined) body.set("_csrf", token);
    const res = await SELF.fetch(`${ORIGIN}/me/install-key`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: cookie },
      body,
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  it("rejects another session's token", async () => {
    const alice = await seedUser({ username: "alice" });
    const bob = await seedUser({ username: "bob" });
    const aliceCookie = await login("alice", alice.password);
    const bobCookie = await login("bob", bob.password);
    const bobToken = await csrfFor(bobCookie);

    const res = await SELF.fetch(`${ORIGIN}/me/install-key`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: aliceCookie },
      body: new URLSearchParams({ _csrf: bobToken }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  // text/plain is one of the three content-types a cross-site form can send.
  // `parseBody` returns `{}` for it, so there is no token to find — the check
  // has to fail closed rather than treat "unparseable" as "no token required".
  it("rejects a text/plain body, which carries no parseable token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const token = await csrfFor(cookie);
    const res = await SELF.fetch(`${ORIGIN}/me/install-key`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: ORIGIN, Cookie: cookie },
      body: `_csrf=${token}`,
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});

describe("Origin / Sec-Fetch-Site layer", () => {
  beforeEach(resetDb);

  const postWith = async (headers: Record<string, string>) => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const token = await csrfFor(cookie);
    return SELF.fetch(`${ORIGIN}/me/install-key`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...headers },
      body: new URLSearchParams({ _csrf: token }),
      redirect: "manual",
    });
  };

  it("rejects a request with neither Origin nor Sec-Fetch-Site", async () => {
    expect((await postWith({})).status).toBe(403);
  });

  it("rejects a cross-origin Origin even with a valid token", async () => {
    expect((await postWith({ Origin: "http://evil.example.com" })).status).toBe(403);
  });

  // The subdomain case SameSite=Lax leaves open: Lax is scoped to the
  // registrable domain, so a sibling subdomain counts as same-site and gets
  // the session cookie attached. Sec-Fetch-Site is what distinguishes it.
  it("rejects Sec-Fetch-Site: same-site", async () => {
    expect((await postWith({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  });

  it("accepts Sec-Fetch-Site: same-origin with no Origin header", async () => {
    expect((await postWith({ "Sec-Fetch-Site": "same-origin" })).status).toBe(302);
  });

  it("answers with 403, not the generic 500 from app.onError", async () => {
    const res = await postWith({});
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Internal server error");
  });
});

describe("/api/* exemption", () => {
  beforeEach(resetDb);

  it("publishes with a Bearer token, no Origin and no CSRF token", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const tokenRes = await postForm("/me/api-token", cookie);
    const apiToken = /sgt_[a-f0-9]{32}/.exec(await tokenRes.text())![0];

    const res = await SELF.fetch(`${ORIGIN}/api/skills/demo-skill`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown" },
      body: GOOD_MD,
    });
    expect(res.status).toBe(201);
  });

  // This is what makes exempting `/api/*` by path sound rather than a guess:
  // the namespace has no cookie-authenticated door, so skipping the token
  // check there cannot expose anything.
  it("cannot be authenticated by a session cookie alone", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const res = await SELF.fetch(`${ORIGIN}/api/skills/demo-skill`, {
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
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toMatch(/^[a-f0-9]{32}$/);
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
    const alice = await seedUser({ username: "alice" });
    const bob = await seedUser({ username: "bob" });
    const aliceCookie = await login("alice", alice.password);
    const bobCookie = await login("bob", bob.password);

    const [a, b] = await Promise.all([csrfFor(aliceCookie), csrfFor(bobCookie)]);
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
    expect(await sessionOf(aliceCookie)).toBe(a);
    expect(await sessionOf(bobCookie)).toBe(b);
  });

  it("throws rather than emitting an empty token when rendered outside page()", async () => {
    const { user } = await seedUser({ username: "alice" });
    const bare = new Hono<{ Bindings: Env }>();
    // Layout renders the logout <Form> whenever a user is signed in.
    bare.get("/", (c) => c.html(<Layout title="t" user={user} />));
    bare.onError(() => new Response("boom", { status: 500 }));
    expect((await bare.request(`${ORIGIN}/`)).status).toBe(500);
  });

  it("emits the token when the same tree goes through page()", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const wrapped = new Hono<{ Bindings: Env }>();
    wrapped.get("/", (c) => page(c as unknown as Ctx, <Layout title="t" user={user} />));
    const res = await wrapped.request(`${ORIGIN}/`, { headers: { Cookie: cookie } }, env);
    expect(await res.text()).toContain(`value="${await csrfFor(cookie)}"`);
  });
});

describe("rendered forms", () => {
  beforeEach(resetDb);

  const formsIn = (html: string) =>
    [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const postFormsIn = (html: string) =>
    formsIn(html).filter((f) => /<form[^>]*\bmethod="post"/i.test(f));

  it("puts a token in every POST form on every signed-in page", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    await publishMarkdown(cookie, GOOD_MD, "private");

    for (const path of [
      "/", "/s/demo-skill", "/me", "/admin/users", "/new", "/s/demo-skill/edit", "/s/demo-skill/upload",
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
    const setup = await (await SELF.fetch(`${ORIGIN}/setup`)).text();
    expect(postFormsIn(setup)).toHaveLength(1);
    expect(setup).not.toContain('name="_csrf"');

    await seedUser({ username: "alice" });
    const loginHtml = await (await SELF.fetch(`${ORIGIN}/login`)).text();
    expect(postFormsIn(loginHtml)).toHaveLength(1);
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
