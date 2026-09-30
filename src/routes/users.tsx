import { Hono } from "hono";
import {
  clearSession, hashPassword, MIN_PASSWORD_LENGTH, newInstallKey, randomHex, requireAdmin, requireUser, roleOf,
  startSession, verifyPassword,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import { flash } from "../flash";
import { messages } from "../i18n";
import {
  countAdmins, countUsers, createFirstAdmin, createUser, deleteUserReassigning, getUserById,
  getUserByUsername, getUserSummary, listUserSummaries, rotateInstallKeys, touchLogin, updateApiTokenHash, updatePassword,
  updateUserRole,
} from "../db/queries";
import type { UserRow } from "../db/queries";
import { sha256Hex } from "../hash";
import { userSettingsPath } from "../paths";
import { LoginPage, MePage, NewUserPage, SetupPage, UserSettingsPage, UsersPage } from "../views/auth";

export const USERNAME = /^[a-z0-9-]{2,32}$/;

const DUMMY_PASSWORD_HASH =
  "pbkdf2$10000$gjyRMe6k+HkicrCTiEY7zg==$ZV/Ne/ZKCLOQWmnxZmtXlwKrXq7/0Th3ydwHLStYv28=";

export const usersRoutes = new Hono<AppEnv>();

async function issueApiToken(db: D1Database, userId: string): Promise<{ token: string; hash: string }> {
  const token = `sgt_${randomHex(16)}`;
  const hash = await sha256Hex(token);
  await updateApiTokenHash(db, userId, hash);
  return { token, hash };
}

const userSettings = async (
  c: Ctx,
  id: string,
  extra: { error?: string; newToken?: string } = {},
): Promise<Response> => {
  const target = await getUserSummary(c.env.DB, id);
  if (!target) return c.notFound();
  return page(
    c,
    <UserSettingsPage user={c.get("user")} target={target} error={extra.error} newToken={extra.newToken} />,
    extra.error ? 400 : undefined,
    userSettingsPath(target.id),
  );
};

usersRoutes.get("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  return page(c, <SetupPage />);
});

usersRoutes.post("/setup", async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return c.notFound();
  const t = messages(c);
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!USERNAME.test(username)) {
    return page(c, <SetupPage error={t.auth.usernameInvalid} />, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return page(c, <SetupPage error={t.auth.passwordTooShort(MIN_PASSWORD_LENGTH)} />, 400);
  }
  const id = randomHex(8);
  const inserted = await createFirstAdmin(c.env.DB, {
    id, username, passwordHash: await hashPassword(password), installKey: newInstallKey(),
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
  if (!user || !ok) return page(c, <LoginPage error={messages(c).auth.badCredentials} />, 401);
  await Promise.all([touchLogin(c.env.DB, user.id, Date.now()), startSession(c, user.id)]);
  return c.redirect("/", 302);
});

usersRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/", 302);
});

usersRoutes.get("/me", requireUser, async (c) => page(c, <MePage user={c.get("user")} />));

usersRoutes.post("/me/api-token", requireUser, async (c) => {
  const user = c.get("user");
  const { token, hash } = await issueApiToken(c.env.DB, user.id);
  return page(c, <MePage user={{ ...user, api_token_hash: hash }} newToken={token} />, undefined, "/me");
});

usersRoutes.post("/me/api-token/revoke", requireUser, async (c) => {
  await updateApiTokenHash(c.env.DB, c.get("user").id, null);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/password", requireUser, async (c) => {
  const user = c.get("user");
  const t = messages(c);
  const body = await c.req.parseBody();
  if (!(await verifyPassword(String(body.current ?? ""), user.password_hash))) {
    return page(c, <MePage user={user} error={t.auth.currentPasswordWrong} />, 400, "/me");
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return page(c, <MePage user={user} error={t.auth.newPasswordTooShort(MIN_PASSWORD_LENGTH)} />, 400, "/me");
  }
  await updatePassword(c.env.DB, user.id, await hashPassword(next));
  await flash(c, t.auth.passwordChanged);
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", requireAdmin, async (c) =>
  page(c, <UsersPage user={c.get("user")} users={await listUserSummaries(c.env.DB)} />),
);

usersRoutes.get("/admin/users/new", requireAdmin, (c) => page(c, <NewUserPage user={c.get("user")} />));

usersRoutes.post("/admin/users/new", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const role = roleOf(body.role);
  const t = messages(c);
  const fail = (error: string) =>
    page(c, <NewUserPage user={c.get("user")} error={error} username={username} role={role} />, 400);
  if (!USERNAME.test(username)) return fail(t.auth.usernameInvalid);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(t.auth.passwordTooShort(MIN_PASSWORD_LENGTH));
  }
  if (await getUserByUsername(c.env.DB, username)) return fail(t.users.usernameTaken);
  await createUser(c.env.DB, {
    id: randomHex(8),
    username,
    passwordHash: await hashPassword(password),
    role,
  });
  return c.redirect("/admin/users", 302);
});

usersRoutes.get("/admin/users/:id", requireAdmin, (c) => userSettings(c, c.req.param("id")));

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
      response: await userSettings(c, target.id, { error: opts.selfError ?? messages(c).users.notToSelf }),
    };
  }
  return { ok: true, admin, target };
}

usersRoutes.post("/admin/users/:id/role", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: messages(c).users.notOwnRole,
  });
  if (!guard.ok) return guard.response;
  const { target } = guard;
  const body = await c.req.parseBody();
  const role = roleOf(body.role);
  if (target.role === "admin" && role !== "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return userSettings(c, target.id, { error: messages(c).users.lastAdminDemote });
  }
  await updateUserRole(c.env.DB, target.id, role);
  return c.redirect(userSettingsPath(target.id), 302);
});

usersRoutes.post("/admin/users/:id/password", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  const body = await c.req.parseBody();
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return userSettings(c, guard.target.id, { error: messages(c).auth.passwordTooShort(MIN_PASSWORD_LENGTH) });
  }
  await updatePassword(c.env.DB, guard.target.id, await hashPassword(password));
  await flash(c, messages(c).users.passwordReset(guard.target.username));
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/install-key", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  await rotateInstallKeys(c.env.DB, guard.target.id, newInstallKey);
  await flash(c, messages(c).users.keysRotated(guard.target.username));
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/api-token", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  const { token } = await issueApiToken(c.env.DB, guard.target.id);
  return userSettings(c, guard.target.id, { newToken: token });
});

usersRoutes.post("/admin/users/:id/api-token/revoke", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  await updateApiTokenHash(c.env.DB, guard.target.id, null);
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/delete", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: messages(c).users.notOwnDelete,
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  if (target.role === "admin" && (await countAdmins(c.env.DB)) <= 1) {
    return userSettings(c, target.id, { error: messages(c).users.lastAdminDelete });
  }
  // Reassigns owner_id and author_id in the same batch as the delete; the
  // foreign keys make that mandatory — see deleteUserReassigning.
  await deleteUserReassigning(c.env.DB, target.id, admin.id);
  await flash(c, messages(c).users.deleted(target.username));
  return c.redirect("/admin/users", 302);
});
