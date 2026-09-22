import { env as rawEnv, SELF } from "cloudflare:test";
import { hashPassword, randomHex } from "../src/auth";
import { createUser, getUserByUsername } from "../src/db/queries";
import type { UserRow } from "../src/db/queries";

/**
 * The worker's bindings, typed.
 *
 * `cloudflare:test`'s `env` types as the ambient `Cloudflare.Env` — an empty
 * interface until `wrangler types` wires up project-specific bindings, which
 * is out of scope here. Local cast only; runtime behavior is unaffected. One
 * cast, exported, so it isn't restated in every test file.
 *
 * The `*_ZIP` / `*_TAR_GZ` entries are binary fixtures. They can't be read
 * with `node:fs` from inside a pool-workers test — the worker's `node:fs` is
 * a sandboxed, empty virtual filesystem with no bridge to the host disk — so
 * `vitest.config.ts` reads them in plain Node and hands them in as
 * `dataBlobBindings`. Use `fixture()` below to get the bytes.
 */
export const env = rawEnv as unknown as {
  DB: D1Database;
  BUCKET: R2Bucket;
  FLAT_ZIP: ArrayBuffer;
  WRAPPED_ZIP: ArrayBuffer;
  FLAT_DOT_TAR_GZ: ArrayBuffer;
  SYMLINK_TAR_GZ: ArrayBuffer;
  BSDTAR_PADDED_TAR_GZ: ArrayBuffer;
  NO_SKILL_MD_ZIP: ArrayBuffer;
};

type FixtureName = {
  [K in keyof typeof env]: (typeof env)[K] extends ArrayBuffer ? K : never;
}[keyof typeof env];

export const fixture = (name: FixtureName) => new Uint8Array(env[name]);

export const ORIGIN = "http://localhost";

/** A valid SKILL.md, used wherever a test just needs *some* publishable skill. */
export const GOOD_MD =
  "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

/** A second one, for the tests that need two distinct skills. */
export const OTHER_MD = "---\nname: other-skill\ndescription: Another skill.\n---\n\n# Other\n";

// Every state-changing request needs an Origin header now: `hono/csrf` rejects
// a form POST that carries neither `Origin` nor `Sec-Fetch-Site`, and neither
// `SELF.fetch` nor Node's `fetch` sends either on its own the way a browser
// would. Anything that posts through these helpers gets it for free.
const SAME_ORIGIN = { Origin: ORIGIN };

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM versions"),
    env.DB.prepare("DELETE FROM skills"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

export async function seedUser(
  opts: { username?: string; role?: "admin" | "member"; password?: string } = {},
): Promise<{ user: UserRow; password: string }> {
  const username = opts.username ?? "alice";
  const password = opts.password ?? "a-very-long-password";
  await createUser(env.DB, {
    id: randomHex(8),
    username,
    passwordHash: await hashPassword(password),
    role: opts.role ?? "admin",
    installKey: randomHex(16),
  });
  const user = await getUserByUsername(env.DB, username);
  if (!user) throw new Error("seedUser failed");
  return { user, password };
}

/**
 * Seed a user and log them in. The username appears once, so it can't drift
 * between the two halves and silently log in as somebody else.
 */
export async function seedAndLogin(
  opts: { username?: string; role?: "admin" | "member"; password?: string } = {},
): Promise<{ user: UserRow; password: string; cookie: string }> {
  const { user, password } = await seedUser(opts);
  return { user, password, cookie: await login(user.username, password) };
}

export async function login(username: string, password: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...SAME_ORIGIN },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("Set-Cookie");
  if (!cookie) throw new Error(`login failed: ${res.status}`);
  return cookie.split(";")[0];
}

/**
 * The session's CSRF token, read back out of a rendered page.
 *
 * Scraping the HTML rather than deriving the token from `SESSION_SECRET` is
 * deliberate: it means every helper below also proves the form actually
 * rendered a token, so a view that stopped emitting one would fail the whole
 * suite rather than quietly weakening it.
 */
export async function csrfFor(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
  const match = /name="_csrf" value="([a-f0-9]{32})"/.exec(await res.text());
  if (!match) throw new Error(`no CSRF token rendered on /me (status ${res.status})`);
  return match[1];
}

/** POST a urlencoded form. Pass `cookie: null` to post as an anonymous visitor. */
export async function postForm(
  path: string,
  cookie: string | null,
  data: Record<string, string> = {},
): Promise<Response> {
  const fields = cookie ? { ...data, _csrf: await csrfFor(cookie) } : data;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...SAME_ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** POST a multipart form (the upload routes). `fields` may carry File values. */
export async function postMultipart(
  path: string,
  cookie: string | null,
  fields: Record<string, string | Blob>,
): Promise<Response> {
  const form = new FormData();
  if (cookie) form.set("_csrf", await csrfFor(cookie));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: form,
    redirect: "manual",
  });
}

/** Publish `markdown` through `POST /new`, failing loudly if it doesn't redirect. */
export async function publishMarkdown(
  cookie: string,
  markdown: string,
  visibility: "public" | "private",
): Promise<void> {
  const res = await postMultipart("/new", cookie, { markdown, visibility });
  if (res.status !== 302) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
}

/** Mint an API token for `cookie`, reading it back out of the rendered page. */
export async function apiToken(cookie: string): Promise<string> {
  const res = await postForm("/me/api-token", cookie);
  const match = /sgt_[a-f0-9]{32}/.exec(await res.text());
  if (!match) throw new Error(`no token issued (status ${res.status})`);
  return match[0];
}

/** Seed a user, log them in, and mint an API token for them. */
export async function seedAndToken(
  opts: { username?: string; role?: "admin" | "member" } = {},
): Promise<{ user: UserRow; cookie: string; token: string }> {
  const { user, cookie } = await seedAndLogin(opts);
  return { user, cookie, token: await apiToken(cookie) };
}
