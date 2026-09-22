import { Hono } from "hono";
import {
  clearSession, hashPassword, MIN_PASSWORD_LENGTH, randomHex, requireAdmin, requireUser,
  startSession, verifyPassword,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import {
  countAdmins, countUsers, createFirstAdmin, createUser, deleteUserReassigning, getUserById,
  getUserByUsername, listUsers, touchLogin, updateApiTokenHash, updateInstallKey, updatePassword,
  updateUserRole,
} from "../db/queries";
import type { UserRow } from "../db/queries";
import { sha256Hex } from "../hash";
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

export const usersRoutes = new Hono<AppEnv>();

const roleOf = (value: unknown): "admin" | "member" => (value === "admin" ? "admin" : "member");

/** Re-render the user list with an error. Every 400 on these routes is this. */
const usersError = async (c: Ctx, admin: UserRow, error: string) =>
  page(c, <UsersPage user={admin} users={await listUsers(c.env.DB)} error={error} />, 400);

usersRoutes.get("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return page(c, <SetupPage />);
});

usersRoutes.post("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!USERNAME.test(username)) {
    return page(c, <SetupPage error="用户名必须是 2-32 位的小写字母、数字或连字符" />, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return page(c, <SetupPage error={`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
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

usersRoutes.get("/login", async (c) => page(c, <LoginPage />));

usersRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const user = await getUserByUsername(c.env.DB, username);
  // Never skip the derivation — see DUMMY_PASSWORD_HASH.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) return page(c, <LoginPage error="用户名或密码不正确" />, 401);
  await Promise.all([touchLogin(c.env.DB, user.id, Date.now()), startSession(c, user.id)]);
  return c.redirect("/", 302);
});

usersRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/", 302);
});

usersRoutes.get("/me", requireUser, async (c) =>
  page(c, <MePage user={c.get("user")} origin={new URL(c.req.url).origin} />),
);

usersRoutes.post("/me/install-key", requireUser, async (c) => {
  await updateInstallKey(c.env.DB, c.get("user").id, randomHex(16));
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/api-token", requireUser, async (c) => {
  const user = c.get("user");
  const token = `sgt_${randomHex(16)}`;
  const api_token_hash = await sha256Hex(token);
  await updateApiTokenHash(c.env.DB, user.id, api_token_hash);
  // The hash is the only column that changed and we just computed it — no
  // need to read the row back to render it.
  return page(
    c,
    <MePage user={{ ...user, api_token_hash }} origin={new URL(c.req.url).origin} newToken={token} />,
  );
});

usersRoutes.post("/me/api-token/revoke", requireUser, async (c) => {
  await updateApiTokenHash(c.env.DB, c.get("user").id, null);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/password", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const origin = new URL(c.req.url).origin;
  if (!(await verifyPassword(String(body.current ?? ""), user.password_hash))) {
    return page(c, <MePage user={user} origin={origin} error="当前密码不正确" />, 400);
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return page(c, <MePage user={user} origin={origin} error={`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符`} />, 400);
  }
  await updatePassword(c.env.DB, user.id, await hashPassword(next));
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", requireAdmin, async (c) =>
  page(c, <UsersPage user={c.get("user")} users={await listUsers(c.env.DB)} />),
);

usersRoutes.post("/admin/users", requireAdmin, async (c) => {
  const admin = c.get("user");
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!USERNAME.test(username)) {
    return usersError(c, admin, "用户名必须是 2-32 位的小写字母、数字或连字符");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return usersError(c, admin, `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  if (await getUserByUsername(c.env.DB, username)) return usersError(c, admin, "用户名已存在");
  await createUser(c.env.DB, {
    id: randomHex(8),
    username,
    passwordHash: await hashPassword(password),
    role: roleOf(body.role),
    installKey: randomHex(16),
  });
  return c.redirect("/admin/users", 302);
});

// Admin-only revocation levers (spec §7.1: 建号、改角色、重置密码、删号).
// Every route below is admin-only (`requireAdmin`) and 404s for an unknown
// target id, checked before any mutation.

/**
 * The `:id` target of an admin route.
 *
 * `allowSelf` defaults to false, so a new destructive lever added next to
 * these gets the safe behaviour without its author having to think of it.
 * Self-targeting is refused rather than made to work: `deleteUserReassigning`
 * cannot reassign a user's rows to itself (it rejects that outright), and
 * changing your own role from the admin panel while your session is live is
 * the same class of footgun. "Remove or demote my own account" is something
 * another admin does.
 */
async function adminTarget(
  c: Ctx,
  id: string,
  opts: { allowSelf?: boolean; selfError?: string } = {},
): Promise<{ ok: true; admin: UserRow; target: UserRow } | { ok: false; response: Response }> {
  const admin = c.get("user");
  const target = await getUserById(c.env.DB, id);
  if (!target) return { ok: false, response: await c.notFound() };
  if (target.id === admin.id && !opts.allowSelf) {
    return {
      ok: false,
      response: await usersError(c, admin, opts.selfError ?? "不能对自己的账号执行这个操作，请让另一位管理员操作"),
    };
  }
  return { ok: true, admin, target };
}

usersRoutes.post("/admin/users/:id/role", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: "不能修改自己的角色，请让另一位管理员操作",
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  const body = await c.req.parseBody();
  const role = roleOf(body.role);
  if (target.role === "admin" && role !== "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return usersError(c, admin, "不能取消最后一个管理员的权限");
  }
  await updateUserRole(c.env.DB, target.id, role);
  return c.redirect("/admin/users", 302);
});

usersRoutes.post("/admin/users/:id/password", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  const body = await c.req.parseBody();
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return usersError(c, guard.admin, `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  await updatePassword(c.env.DB, guard.target.id, await hashPassword(password));
  return c.redirect("/admin/users", 302);
});

usersRoutes.post("/admin/users/:id/install-key", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  await updateInstallKey(c.env.DB, guard.target.id, randomHex(16));
  return c.redirect("/admin/users", 302);
});

usersRoutes.post("/admin/users/:id/api-token/revoke", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  await updateApiTokenHash(c.env.DB, guard.target.id, null);
  return c.redirect("/admin/users", 302);
});

usersRoutes.post("/admin/users/:id/delete", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: "不能删除自己的账号，请让另一位管理员操作",
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  if (target.role === "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return usersError(c, admin, "不能删除最后一个管理员");
  }
  // Reassigns owner_id and author_id in the same batch as the delete; the
  // foreign keys make that mandatory — see deleteUserReassigning.
  await deleteUserReassigning(c.env.DB, target.id, admin.id);
  return c.redirect("/admin/users", 302);
});
