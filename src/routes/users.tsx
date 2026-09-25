import { Hono } from "hono";
import {
  clearSession, hashPassword, membershipIn, MIN_PASSWORD_LENGTH, randomHex, requireAdmin, requireUser,
  startSession, verifyPassword,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import { flash } from "../flash";
import {
  countAdmins, countUsers, createFirstAdmin, createUser, deleteUserReassigning, getUserById,
  getUserByUsername, listUsers, rotateInstallKeys, touchLogin, updateApiTokenHash, updateInstallKey,
  updatePassword, updateUserRole,
} from "../db/queries";
import type { UserRow } from "../db/queries";
import { sha256Hex } from "../hash";
import { LoginPage, MePage, NewUserPage, SetupPage, UsersPage } from "../views/auth";

const USERNAME = /^[a-z0-9-]{2,32}$/;

const DUMMY_PASSWORD_HASH =
  "pbkdf2$10000$gjyRMe6k+HkicrCTiEY7zg==$ZV/Ne/ZKCLOQWmnxZmtXlwKrXq7/0Th3ydwHLStYv28=";

export const usersRoutes = new Hono<AppEnv>();

const roleOf = (value: unknown): "admin" | "member" => (value === "admin" ? "admin" : "member");

/** Re-render the user list with an error. */
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
    return page(c, <SetupPage error="Username must be 2-32 lowercase letters, digits or hyphens" />, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return page(c, <SetupPage error={`Password must be at least ${MIN_PASSWORD_LENGTH} characters`} />, 400);
  }
  const id = randomHex(8);
  const inserted = await createFirstAdmin(c.env.DB, {
    id, username, passwordHash: await hashPassword(password), installKey: randomHex(16),
  });
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
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) return page(c, <LoginPage error="Incorrect username or password" />, 401);
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

usersRoutes.post("/me/install-key/:project", requireUser, async (c) => {
  const user = c.get("user");
  const project = c.req.param("project");
  if (!membershipIn(user, project)) return c.notFound();
  await updateInstallKey(c.env.DB, project, user.id, randomHex(16));
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/api-token", requireUser, async (c) => {
  const user = c.get("user");
  const token = `sgt_${randomHex(16)}`;
  const api_token_hash = await sha256Hex(token);
  await updateApiTokenHash(c.env.DB, user.id, api_token_hash);
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
    return page(c, <MePage user={user} origin={origin} error="Current password is incorrect" />, 400);
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return page(c, <MePage user={user} origin={origin} error={`New password must be at least ${MIN_PASSWORD_LENGTH} characters`} />, 400);
  }
  await updatePassword(c.env.DB, user.id, await hashPassword(next));
  await flash(c, "Your password has been changed.");
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", requireAdmin, async (c) =>
  page(c, <UsersPage user={c.get("user")} users={await listUsers(c.env.DB)} />),
);

usersRoutes.get("/admin/users/new", requireAdmin, (c) => page(c, <NewUserPage user={c.get("user")} />));

usersRoutes.post("/admin/users/new", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const role = roleOf(body.role);
  const fail = (error: string) =>
    page(c, <NewUserPage user={c.get("user")} error={error} username={username} role={role} />, 400);
  if (!USERNAME.test(username)) return fail("Username must be 2-32 lowercase letters, digits or hyphens");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (await getUserByUsername(c.env.DB, username)) return fail("That username is taken");
  await createUser(c.env.DB, {
    id: randomHex(8),
    username,
    passwordHash: await hashPassword(password),
    role,
  });
  return c.redirect("/admin/users", 302);
});

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
      response: await usersError(c, admin, opts.selfError ?? "You cannot do this to your own account. Ask another admin."),
    };
  }
  return { ok: true, admin, target };
}

usersRoutes.post("/admin/users/:id/role", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: "You cannot change your own role. Ask another admin.",
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  const body = await c.req.parseBody();
  const role = roleOf(body.role);
  if (target.role === "admin" && role !== "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return usersError(c, admin, "You cannot demote the last admin");
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
    return usersError(c, guard.admin, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  await updatePassword(c.env.DB, guard.target.id, await hashPassword(password));
  await flash(c, `Password reset for ${guard.target.username}.`);
  return c.redirect("/admin/users", 302);
});

usersRoutes.post("/admin/users/:id/install-key", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  await rotateInstallKeys(c.env.DB, guard.target.id, () => randomHex(16));
  await flash(c, `Install keys rotated for ${guard.target.username}. The old install commands no longer work.`);
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
    selfError: "You cannot delete your own account. Ask another admin.",
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  if (target.role === "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return usersError(c, admin, "You cannot delete the last admin");
  }
  // Reassigns owner_id and author_id in the same batch as the delete; the
  // foreign keys make that mandatory — see deleteUserReassigning.
  await deleteUserReassigning(c.env.DB, target.id, admin.id);
  return c.redirect("/admin/users", 302);
});
