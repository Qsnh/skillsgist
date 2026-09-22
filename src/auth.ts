import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { getUserById } from "./db/queries";
import type { SkillRow, UserRow } from "./db/queries";
import type { Env } from "./types";

export type Ctx = Context<{ Bindings: Env }>;

export const PBKDF2_ITERATIONS = 10_000;
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_COOKIE = "sg_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: string, b: string): boolean {
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
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  let salt: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
  } catch {
    return false;
  }
  const bits = await deriveBits(password, salt, iterations);
  return constantTimeEqual(toBase64(bits), parts[3]);
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startSession(c: Ctx, userId: string): Promise<void> {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS });
  await setSignedCookie(c, SESSION_COOKIE, payload, c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSession(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentUser(c: Ctx): Promise<UserRow | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (!raw) return null;
  let payload: { uid?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload.uid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return await getUserById(c.env.DB, payload.uid);
}

export async function userFromApiToken(c: Ctx): Promise<UserRow | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const hash = await sha256Hex(token);
  return await c.env.DB.prepare("SELECT * FROM users WHERE api_token_hash = ?")
    .bind(hash)
    .first<UserRow>();
}

export function canManage(user: UserRow, skill: SkillRow): boolean {
  return user.role === "admin" || user.id === skill.owner_id;
}
