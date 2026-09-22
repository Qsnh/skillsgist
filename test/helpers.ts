import { env as rawEnv, SELF } from "cloudflare:test";
import { hashPassword, randomHex } from "../src/auth";
import { createUser, getUserByUsername } from "../src/db/queries";
import type { UserRow } from "../src/db/queries";

// `cloudflare:test`'s `env` types as the ambient `Cloudflare.Env` (an empty
// interface until `wrangler types` wires up project-specific bindings, which
// is out of scope here — see test/db.test.ts for the same cast). Local cast
// only; runtime behavior is unaffected.
const env = rawEnv as unknown as { DB: D1Database };

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

export async function login(username: string, password: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("Set-Cookie");
  if (!cookie) throw new Error(`login failed: ${res.status}`);
  return cookie.split(";")[0];
}
