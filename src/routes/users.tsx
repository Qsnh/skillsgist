import { Hono } from "hono";
import {
  clearSession, currentUser, hashPassword, MIN_PASSWORD_LENGTH, randomHex,
  sha256Hex, startSession, verifyPassword,
} from "../auth";
import {
  countUsers, createFirstAdmin, createUser, getUserById, getUserByUsername, listUsers,
  touchLogin, updateApiTokenHash, updateInstallKey, updatePassword,
} from "../db/queries";
import type { Env } from "../types";
import { LoginPage, MePage, SetupPage, UsersPage } from "../views/auth";

const USERNAME = /^[a-z0-9-]{2,32}$/;

// A well-formed but unusable password hash (`pbkdf2$10000$<salt>$<key>`),
// generated once offline for a throwaway password no real account uses. When
// `/login` is given a username that doesn't exist, we still run
// `verifyPassword` against this constant so the response takes the same
// PBKDF2-derivation time as a real wrong-password attempt. Without it, an
// attacker can enumerate usernames by timing how fast `/login` answers.
const DUMMY_PASSWORD_HASH =
  "pbkdf2$10000$gjyRMe6k+HkicrCTiEY7zg==$ZV/Ne/ZKCLOQWmnxZmtXlwKrXq7/0Th3ydwHLStYv28=";

export const usersRoutes = new Hono<{ Bindings: Env }>();

usersRoutes.get("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return c.html(<SetupPage />);
});

usersRoutes.post("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!USERNAME.test(username)) {
    return c.html(<SetupPage error="用户名必须是 2-32 位的小写字母、数字或连字符" />, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.html(<SetupPage error={`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
  }
  const id = randomHex(8);
  const inserted = await createFirstAdmin(c.env.DB, {
    id, username, passwordHash: await hashPassword(password), installKey: randomHex(16),
  });
  // The cheap `countUsers` check above is just the common-path short-circuit
  // (skips hashing a password once bootstrapped). `createFirstAdmin` is the
  // actual guard: it and the insert are one atomic statement, so a second
  // request that raced past the check above still can't insert a second
  // bootstrap admin.
  if (!inserted) return c.notFound();
  await startSession(c, id);
  return c.redirect("/", 302);
});

usersRoutes.get("/login", async (c) => c.html(<LoginPage />));

usersRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const user = await getUserByUsername(c.env.DB, username);
  // Always run the derivation, even when no such user exists, so the two
  // failure paths take the same time and a username can't be enumerated by
  // timing responses.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) return c.html(<LoginPage error="用户名或密码不正确" />, 401);
  await touchLogin(c.env.DB, user.id, Date.now());
  await startSession(c, user.id);
  return c.redirect("/", 302);
});

usersRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/", 302);
});

usersRoutes.get("/me", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  return c.html(<MePage user={user} origin={new URL(c.req.url).origin} />);
});

usersRoutes.post("/me/install-key", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  await updateInstallKey(c.env.DB, user.id, randomHex(16));
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/api-token", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const token = `sgt_${randomHex(16)}`;
  await updateApiTokenHash(c.env.DB, user.id, await sha256Hex(token));
  const fresh = await getUserById(c.env.DB, user.id);
  return c.html(<MePage user={fresh ?? user} origin={new URL(c.req.url).origin} newToken={token} />);
});

usersRoutes.post("/me/api-token/revoke", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  await updateApiTokenHash(c.env.DB, user.id, null);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/password", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const body = await c.req.parseBody();
  const origin = new URL(c.req.url).origin;
  if (!(await verifyPassword(String(body.current ?? ""), user.password_hash))) {
    return c.html(<MePage user={user} origin={origin} error="当前密码不正确" />, 400);
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return c.html(<MePage user={user} origin={origin} error={`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
  }
  await updatePassword(c.env.DB, user.id, await hashPassword(next));
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("仅管理员可访问", 403);
  return c.html(<UsersPage user={user} users={await listUsers(c.env.DB)} />);
});

usersRoutes.post("/admin/users", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  if (user.role !== "admin") return c.text("仅管理员可访问", 403);
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const role = body.role === "admin" ? "admin" : "member";
  const fail = async (error: string) =>
    c.html(<UsersPage user={user} users={await listUsers(c.env.DB)} error={error} />, 400);
  if (!USERNAME.test(username)) return fail("用户名必须是 2-32 位的小写字母、数字或连字符");
  if (password.length < MIN_PASSWORD_LENGTH) return fail(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  if (await getUserByUsername(c.env.DB, username)) return fail("用户名已存在");
  await createUser(c.env.DB, {
    id: randomHex(8), username, passwordHash: await hashPassword(password), role, installKey: randomHex(16),
  });
  return c.redirect("/admin/users", 302);
});
