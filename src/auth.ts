import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { decodeBase64, encodeBase64 } from "hono/utils/encode";
import { getSkill, getViewer, getViewerByApiTokenHash, listProjects } from "./db/queries";
import type { Membership, SkillRow, SkillScope, Viewer } from "./db/queries";
import { sha256Hex, toHex } from "./hash";
import type { Env } from "./types";

/**
 * The one Hono environment every app and route module is typed with.
 *
 * `user` is set by `requireUser` below, so a handler behind it reads the
 * signed-in user off the context instead of resolving it again. `session` is
 * the memoised session read — see `readSession`.
 */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: Viewer;
    session: Promise<SessionPayload | null>;
  };
}

export type Ctx = Context<AppEnv>;

export const PBKDF2_ITERATIONS = 10_000;
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_COOKIE = "sg_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Name of the hidden form field carrying the CSRF token. See src/csrf.tsx. */
export const CSRF_FIELD = "_csrf";

const enc = new TextEncoder();

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${encodeBase64(salt.buffer)}$${encodeBase64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  let salt: Uint8Array;
  try {
    salt = decodeBase64(parts[2]);
  } catch {
    return false;
  }
  const bits = await deriveBits(password, salt, iterations);
  return constantTimeEqual(encodeBase64(bits), parts[3]);
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * The signed-cookie session payload. `csrf` is the per-session CSRF token:
 * binding it to the session (rather than to a second, independent cookie) is
 * what makes the token resistant to cookie injection from a sibling
 * subdomain — see the header comment in src/csrf.tsx for the full argument.
 */
interface SessionPayload {
  uid: string;
  exp: number;
  csrf: string;
}

export async function startSession(c: Ctx, userId: string): Promise<void> {
  const payload = JSON.stringify({
    uid: userId,
    exp: Date.now() + SESSION_TTL_MS,
    csrf: randomHex(16),
  } satisfies SessionPayload);
  await setSignedCookie(c, SESSION_COOKIE, payload, c.env.SESSION_SECRET, cookieOptions(c, SESSION_TTL_MS / 1000));
}

export function cookieOptions(c: Ctx, maxAge: number): CookieOptions {
  return { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge };
}

export function clearSession(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// Single place that reads and validates the session cookie, so `currentUser`
// and `sessionCsrf` can never disagree about whether a session is usable.
//
// A payload with no `csrf` is treated as no session at all. Sessions issued
// before CSRF protection existed are exactly that shape, so everyone signed in
// at deploy time gets logged out once and signs back in. That one-time cost is
// deliberate: the alternative — honouring csrf-less sessions — would hand an
// attacker a downgrade switch back to the unprotected behaviour.
//
// Memoised on the context: verifying the cookie's HMAC is a WebCrypto
// import+verify, and a single request asks for the session up to three times
// (the CSRF middleware, `requireUser`, and `page()` rendering the token).
// Caching the *promise* rather than the payload keeps "no session" — a
// perfectly normal null — distinguishable from "not looked up yet".
function readSession(c: Ctx): Promise<SessionPayload | null> {
  const cached = c.get("session");
  if (cached) return cached;
  const pending = loadSession(c);
  c.set("session", pending);
  return pending;
}

async function loadSession(c: Ctx): Promise<SessionPayload | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!raw) return null;
  let payload: { uid?: unknown; exp?: unknown; csrf?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload.uid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if (typeof payload.csrf !== "string" || payload.csrf === "") return null;
  return { uid: payload.uid, exp: payload.exp, csrf: payload.csrf };
}

export async function currentUser(c: Ctx): Promise<Viewer | null> {
  const session = await readSession(c);
  if (!session) return null;
  return await getViewer(c.env.DB, session.uid);
}

/** The current session's CSRF token, or null when there is no usable session. */
export async function sessionCsrf(c: Ctx): Promise<string | null> {
  return (await readSession(c))?.csrf ?? null;
}

export async function userFromApiToken(c: Ctx): Promise<Viewer | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  return await getViewerByApiTokenHash(c.env.DB, await sha256Hex(token));
}

export function membershipIn(viewer: Viewer, project: string): Membership | undefined {
  return viewer.memberships.find((m) => m.project === project);
}

export function canManageProject(viewer: Viewer, project: string): boolean {
  return viewer.role === "admin" || membershipIn(viewer, project)?.role === "admin";
}

export function canPublishTo(viewer: Viewer, project: string): boolean {
  return viewer.role === "admin" || membershipIn(viewer, project) !== undefined;
}

export function canView(viewer: Viewer | null, skill: Pick<SkillRow, "visibility" | "project">): boolean {
  if (skill.visibility === "public") return true;
  return viewer !== null && canPublishTo(viewer, skill.project);
}

export function canManage(viewer: Viewer, skill: Pick<SkillRow, "project" | "owner_id">): boolean {
  if (canManageProject(viewer, skill.project)) return true;
  return skill.owner_id === viewer.id && membershipIn(viewer, skill.project) !== undefined;
}

export function skillScope(viewer: Viewer | null): SkillScope {
  if (viewer === null) return { kind: "public" };
  if (viewer.role === "admin") return { kind: "all" };
  return { kind: "member", userId: viewer.id };
}

export async function publishableProjects(
  db: D1Database,
  viewer: Viewer,
): Promise<Array<{ slug: string; name: string }>> {
  if (viewer.role === "admin") return listProjects(db);
  return viewer.memberships.map((m) => ({ slug: m.project, name: m.project_name }));
}

/**
 * Resolve the session user or redirect to /login, and hand the user to the
 * handler through `c.get("user")`.
 *
 * Registered per route (`routes.post(path, requireUser, handler)`) rather
 * than as a blanket `use()`: which routes demand a session is then visible in
 * the route table instead of being a prologue every new handler has to
 * remember to copy. src/csrf.tsx's layer-2 middleware leans on exactly that
 * invariant.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  c.set("user", user);
  return next();
};

export async function requireManagedSkill(
  c: Ctx,
  project: string,
  slug: string,
  action: string,
): Promise<{ ok: true; skill: SkillRow } | { ok: false; response: Response }> {
  const user = c.get("user");
  const skill = await getSkill(c.env.DB, project, slug);
  if (!skill || !canView(user, skill)) return { ok: false, response: await c.notFound() };
  if (!canManage(user, skill)) {
    return { ok: false, response: c.text(`You are not allowed to ${action} this skill`, 403) };
  }
  return { ok: true, skill };
}

/** `requireUser`, plus an admin-only gate. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("Admins only", 403);
  c.set("user", user);
  return next();
};
