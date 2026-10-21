import { readFileSync } from "node:fs";
import { app } from "../src/app";
import { hashPassword, randomHex } from "../src/auth";
import { DEFAULT_LIMITS } from "../src/config";
import type { Config } from "../src/config";
import { newDeviceCode, newDeviceToken, newInstallKey, newUserCode } from "../src/credentials";
import { MEMORY, openDatabase, transaction } from "../src/db/database";
import { recordDownload } from "../src/db/downloads";
import type { DownloadSource } from "../src/db/downloads";
import { activateLogin, approveLogin, createPendingLogin } from "../src/db/logins";
import { addMembership, createProject, createUser, DEFAULT_PROJECT, getUserByUsername } from "../src/db/queries";
import type { UserRow } from "../src/db/queries";
import { FLASH_COOKIE } from "../src/flash";
import { GeoIp } from "../src/geoip";
import { sha256Hex } from "../src/hash";
import { RateLimiter } from "../src/rate-limit";
import type { RateLimiters } from "../src/rate-limit";
import type { IndexEntry } from "../src/registry";
import type { Env } from "../src/types";
import { MemoryStorage } from "./memory-storage";

const FIXTURES = {
  FLAT_ZIP: "flat.zip",
  WRAPPED_ZIP: "wrapped.zip",
  FLAT_DOT_TAR_GZ: "flat-dot.tar.gz",
  SYMLINK_TAR_GZ: "symlink.tar.gz",
  BSDTAR_PADDED_TAR_GZ: "bsdtar-padded.tar.gz",
  NO_SKILL_MD_ZIP: "no-skill-md.zip",
};

export const fixturePath = (file: string) => new URL(`./fixtures/${file}`, import.meta.url);

export const fixture = (name: keyof typeof FIXTURES) => new Uint8Array(readFileSync(fixturePath(FIXTURES[name])));

export const GEOIP_FIXTURE = fixturePath("geoip-country.mmdb").pathname;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    publicUrl: null,
    trustProxy: 0,
    dataDir: "",
    databasePath: MEMORY,
    sessionSecret: "test-secret-that-is-long-enough-for-hmac",
    s3: {
      endpoint: "http://s3.invalid",
      region: "us-east-1",
      bucket: "skillsgist",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    },
    retentionDays: 90,
    geoip: { path: GEOIP_FIXTURE, autoUpdate: false },
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

export const unlimited = (): RateLimiters => ({
  deviceAuthorization: new RateLimiter(Number.MAX_SAFE_INTEGER, 1),
  signIn: new RateLimiter(Number.MAX_SAFE_INTEGER, 1),
});

const geoip = new GeoIp(GEOIP_FIXTURE);
geoip.load();

export const storage = new MemoryStorage();

export const env: Env = {
  db: openDatabase(MEMORY),
  storage,
  geoip,
  config: testConfig(),
  limiters: unlimited(),
  clientIp: null,
};

export type AppRequestInit = RequestInit & { clientIp?: string | null; env?: Partial<Env> };

export function appFetch(url: string, init: AppRequestInit = {}): Promise<Response> {
  const { clientIp, env: overrides, ...request } = init;
  return Promise.resolve(
    app.fetch(new Request(url, request), { ...env, ...overrides, clientIp: clientIp === undefined ? env.clientIp : clientIp }),
  );
}

export const ORIGIN = "http://localhost";

/** A valid SKILL.md, used wherever a test just needs *some* publishable skill. */
export const GOOD_MD =
  "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo\n";

/** A second one, for the tests that need two distinct skills. */
export const OTHER_MD = "---\nname: other-skill\ndescription: Another skill.\n---\n\n# Other\n";

export const FLAT_FILES = ["SKILL.md", "references/api.md", "scripts/run.sh"];

// Every state-changing request needs an Origin header now: `hono/csrf` rejects
// a form POST that carries neither `Origin` nor `Sec-Fetch-Site`, and a
// server-side `Request` sends neither on its own the way a browser would.
// Anything that posts through these helpers gets it for free.
const SAME_ORIGIN = { Origin: ORIGIN };

export async function resetDb(): Promise<void> {
  env.db.close();
  env.db = openDatabase(MEMORY);
  env.db.prepare("UPDATE projects SET created_at = 0 WHERE slug = ?").run(DEFAULT_PROJECT);
  env.config = testConfig();
  env.limiters = unlimited();
  storage.clear();
}

export interface SeedOptions {
  username?: string;
  role?: "admin" | "member";
  password?: string;
  project?: string | null;
  projectRole?: "admin" | "member";
}

export async function seedUser(opts: SeedOptions = {}): Promise<{ user: UserRow; password: string }> {
  const username = opts.username ?? "alice";
  const password = opts.password ?? "a-very-long-password";
  const role = opts.role ?? "admin";
  const id = randomHex(8);
  createUser(env.db, { id, username, passwordHash: await hashPassword(password), role });
  const project = opts.project === undefined ? DEFAULT_PROJECT : opts.project;
  if (project !== null) joinProject(id, project, newInstallKey(), opts.projectRole);
  const user = getUserByUsername(env.db, username);
  if (!user) throw new Error("seedUser failed");
  return { user, password };
}

/**
 * Seed a user and log them in. The username appears once, so it can't drift
 * between the two halves and silently log in as somebody else.
 */
export async function seedAndLogin(
  opts: SeedOptions = {},
): Promise<{ user: UserRow; password: string; cookie: string }> {
  const { user, password } = await seedUser(opts);
  return { user, password, cookie: await login(user.username, password) };
}

export async function login(username: string, password: string): Promise<string> {
  const res = await appFetch(`${ORIGIN}/login`, {
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
  const res = await appFetch(`${ORIGIN}/me`, { headers: { Cookie: cookie } });
  const match = /name="_csrf" value="([a-f0-9]{32})"/.exec(await res.text());
  if (!match) throw new Error(`no CSRF token rendered on /me (status ${res.status})`);
  return match[1];
}

/** POST a urlencoded form. Pass `cookie: null` to post as an anonymous visitor. */
export async function postForm(
  path: string,
  cookie: string | null,
  data: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const fields = cookie ? { ...data, _csrf: await csrfFor(cookie) } : data;
  return appFetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...SAME_ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

export async function postFields(path: string, cookie: string, fields: Array<[string, string]>): Promise<Response> {
  const body = new URLSearchParams(fields);
  body.set("_csrf", await csrfFor(cookie));
  return appFetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...SAME_ORIGIN, Cookie: cookie },
    body,
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
  return appFetch(`${ORIGIN}${path}`, {
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
  project?: string,
): Promise<void> {
  const res = await postMultipart("/new", cookie, { markdown, visibility, ...(project ? { project } : {}) });
  if (res.status !== 302) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
}

export async function seedWithSkills(
  opts: SeedOptions,
  ...skills: Array<[markdown: string, visibility: "public" | "private", project?: string]>
): Promise<{ user: UserRow; password: string; cookie: string }> {
  const login = await seedAndLogin(opts);
  for (const [markdown, visibility, project] of skills) await publishMarkdown(login.cookie, markdown, visibility, project);
  return login;
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
  opts: SeedOptions = {},
): Promise<{ user: UserRow; cookie: string; token: string }> {
  const { user, cookie } = await seedAndLogin(opts);
  return { user, cookie, token: await apiToken(cookie) };
}

export const FLASH_CLEARED = new RegExp(`^${FLASH_COOKIE}=;.*Max-Age=0`, "i");

export function setCookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

export const flashCookie = (res: Response) => setCookieLine(res, FLASH_COOKIE);

export async function follow(res: Response, cookie: string): Promise<Response> {
  const location = res.headers.get("Location");
  if (!location) throw new Error(`not a redirect: ${res.status}`);
  const flashed = flashCookie(res)?.split(";")[0];
  return appFetch(`${ORIGIN}${location}`, {
    headers: { Cookie: flashed ? `${cookie}; ${flashed}` : cookie },
    redirect: "manual",
  });
}

export const seedProject = (slug: string, name: string = slug) => createProject(env.db, { slug, name });

export async function twoProjects(aliceRole: "admin" | "member" = "admin") {
  await seedProject("team-b", "Team B");
  const alice = await seedAndLogin({ username: "alice", role: aliceRole });
  const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
  return { alice, bob };
}

export const joinProject = (
  userId: string,
  project: string,
  key: string = newInstallKey(),
  role: "admin" | "member" = "member",
  canPublish: boolean = true,
) => addMembership(env.db, { project, userId, role, installKey: key, canPublish });

export const membership = (userId: string, project: string = DEFAULT_PROJECT) =>
  (env.db
    .prepare("SELECT role, install_key, can_publish FROM memberships WHERE project = ? AND user_id = ?")
    .get(project, userId) as { role: string; install_key: string; can_publish: number } | undefined) ?? null;

export const denyPublish = (userId: string, project: string = DEFAULT_PROJECT) =>
  env.db.prepare("UPDATE memberships SET can_publish = 0 WHERE project = ? AND user_id = ?").run(project, userId);

export async function installKey(userId: string, project: string = DEFAULT_PROJECT): Promise<string> {
  const row = membership(userId, project);
  if (!row) throw new Error(`${userId} is not a member of ${project}`);
  return row.install_key;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function signInDevice(
  userId: string,
  projects: string[],
  lastUsedAt: number = Date.now(),
  deviceName: string = "test-laptop",
): Promise<{ id: string; token: string }> {
  const id = randomHex(16);
  const now = Date.now();
  const created = createPendingLogin(env.db, {
    id, userCode: newUserCode(), deviceCodeHash: sha256Hex(newDeviceCode()), deviceName,
    country: null, requestedScope: null, now,
  });
  if (!created) throw new Error("signInDevice: createPendingLogin failed");
  if (!approveLogin(env.db, id, userId, projects, now)) throw new Error("signInDevice: approveLogin failed");
  const token = newDeviceToken();
  if (!activateLogin(env.db, id, sha256Hex(token), lastUsedAt)) throw new Error("signInDevice: activateLogin failed");
  return { id, token };
}

export async function indexAt(base: string, alias: "agent-skills" | "skills" = "agent-skills"): Promise<IndexEntry[]> {
  const res = await appFetch(`${ORIGIN}${base}/.well-known/${alias}/index.json`);
  if (res.status !== 200) throw new Error(`${base} index answered ${res.status}`);
  return ((await res.json()) as { skills: IndexEntry[] }).skills;
}

export const indexNames = async (base: string, alias?: "agent-skills" | "skills") =>
  (await indexAt(base, alias)).map((s) => s.name);

export const fetchWith = (path: string, headers: Record<string, string> = {}) =>
  appFetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });

export const get = (path: string, cookie?: string) => fetchWith(path, cookie ? { Cookie: cookie } : {});

export function putSkill(
  token: string,
  body: RequestInit["body"],
  opts: { slug?: string; contentType?: string; visibility?: string; project?: string } = {},
): Promise<Response> {
  const query = opts.visibility === undefined ? "" : `?visibility=${opts.visibility}`;
  const slug = opts.slug ?? "demo-skill";
  return appFetch(`${ORIGIN}/api/projects/${opts.project ?? "default"}/skills/${slug}${query}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": opts.contentType ?? "text/markdown",
    },
    body,
  });
}

export const cellMeta = (html: string) => /<p class="cf-cell-meta">([\s\S]*?)<\/p>/.exec(html)?.[1];

export interface LogSeed {
  at?: number;
  version?: number;
  source?: DownloadSource;
  userId?: string | null;
  username?: string | null;
  deviceName?: string | null;
  country?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function seedLog(skillId: string, seed: LogSeed = {}): void {
  const recorded = recordDownload(env.db, {
    skillId,
    version: seed.version ?? 1,
    downloader: {
      source: seed.source ?? "anonymous",
      userId: seed.userId ?? null,
      username: seed.username ?? null,
      deviceName: seed.deviceName ?? null,
    },
    country: seed.country ?? null,
    ip: seed.ip ?? null,
    userAgent: seed.userAgent ?? null,
    at: seed.at ?? Date.now(),
  });
  if (!recorded) throw new Error(`seedLog: no skill ${skillId}`);
}

export const seedLogs = (skillId: string, count: number, at: number) =>
  transaction(env.db, () => {
    for (let i = 0; i < count; i++) seedLog(skillId, { at });
  });

export const withConfig = (overrides: Partial<Config>): Partial<Env> => ({ config: testConfig(overrides) });
