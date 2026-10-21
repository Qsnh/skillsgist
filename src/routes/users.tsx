import { Hono } from "hono";
import {
  burnPasswordCheck, clearSession, hashPassword, MIN_PASSWORD_LENGTH, randomHex, requireAdmin, requireUser, roleOf,
  startSession, USERNAME, verifyPassword,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { loginExpired, loginIdleCutoff, newInstallKey } from "../credentials";
import { page } from "../csrf";
import { deleteUserLogin, listUserLogins } from "../db/logins";
import { flash } from "../flash";
import { messages } from "../i18n";
import {
  countAdmins, countUsers, createFirstAdmin, createUser, deleteUserReassigning, getUserById,
  getUserByUsername, getUserSummary, listUserSummaries, rotateInstallKeys, touchLogin, updateApiTokenHash, updatePassword,
  updateUserRole,
} from "../db/queries";
import type { Db } from "../db/database";
import type { UserRow, Viewer } from "../db/queries";
import { sha256Hex } from "../hash";
import { safeNext, userSettingsPath } from "../paths";
import { clientKey, retryAfterSeconds } from "../rate-limit";
import { LoginPage, MePage, NewUserPage, SetupPage, UserSettingsPage, UsersPage } from "../views/auth";

export const usersRoutes = new Hono<AppEnv>();

function issueApiToken(db: Db, userId: string): { token: string; hash: string } {
  const token = `sgt_${randomHex(16)}`;
  const hash = sha256Hex(token);
  updateApiTokenHash(db, userId, hash);
  return { token, hash };
}

async function mePage(c: Ctx, user: Viewer, extra: { newToken?: string; error?: string } = {}): Promise<Response> {
  const logins = listUserLogins(c.env.db, user.id);
  return page(
    c,
    <MePage user={user} logins={logins} newToken={extra.newToken} error={extra.error} />,
    extra.error ? 400 : undefined,
    "/me",
  );
}

const userSettings = async (
  c: Ctx,
  id: string,
  extra: { error?: string; newToken?: string } = {},
): Promise<Response> => {
  const target = getUserSummary(c.env.db, id, loginIdleCutoff(Date.now()));
  if (!target) return c.notFound();
  return page(
    c,
    <UserSettingsPage user={c.get("user")} target={target} error={extra.error} newToken={extra.newToken} />,
    extra.error ? 400 : undefined,
    userSettingsPath(target.id),
  );
};

usersRoutes.get("/setup", async (c) => {
  if (countUsers(c.env.db) > 0) return c.notFound();
  return page(c, <SetupPage />);
});

usersRoutes.post("/setup", async (c) => {
  if (countUsers(c.env.db) > 0) return c.notFound();
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
  const inserted = createFirstAdmin(c.env.db, {
    id, username, passwordHash: await hashPassword(password), installKey: newInstallKey(),
  });
  if (!inserted) return c.notFound();
  await startSession(c, id);
  return c.redirect("/", 302);
});

usersRoutes.get("/login", async (c) => page(c, <LoginPage next={safeNext(c.req.query("next"))} />));

usersRoutes.post("/login", async (c) => {
  const limiter = c.env.limiters.signIn;
  const address = clientKey(c.env.clientIp);
  const blocked = limiter.wait(address);
  const body = blocked > 0 ? {} : await c.req.parseBody();
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const next = safeNext(body.next ?? c.req.query("next"));
  if (blocked > 0) {
    c.header("Retry-After", retryAfterSeconds(blocked));
    return page(c, <LoginPage error={messages(c).auth.tooManySignIns} next={next} />, 429);
  }
  const user = getUserByUsername(c.env.db, username);
  if (!user) await burnPasswordCheck(password);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    limiter.hit(address);
    return page(c, <LoginPage error={messages(c).auth.badCredentials} next={next} />, 401);
  }
  touchLogin(c.env.db, user.id, Date.now());
  await startSession(c, user.id);
  return c.redirect(next, 302);
});

usersRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/", 302);
});

usersRoutes.get("/me", requireUser, (c) => mePage(c, c.get("user")));

usersRoutes.post("/me/api-token", requireUser, async (c) => {
  const user = c.get("user");
  const { token, hash } = issueApiToken(c.env.db, user.id);
  return mePage(c, { ...user, api_token_hash: hash }, { newToken: token });
});

usersRoutes.post("/me/api-token/revoke", requireUser, async (c) => {
  updateApiTokenHash(c.env.db, c.get("user").id, null);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/password", requireUser, async (c) => {
  const user = c.get("user");
  const t = messages(c);
  const body = await c.req.parseBody();
  if (!(await verifyPassword(String(body.current ?? ""), user.password_hash))) {
    return mePage(c, user, { error: t.auth.currentPasswordWrong });
  }
  const next = String(body.next ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return mePage(c, user, { error: t.auth.newPasswordTooShort(MIN_PASSWORD_LENGTH) });
  }
  updatePassword(c.env.db, user.id, await hashPassword(next));
  await flash(c, t.auth.passwordChanged);
  return c.redirect("/me", 302);
});

usersRoutes.post("/me/cli-logins/:id/revoke", requireUser, async (c) => {
  const login = deleteUserLogin(c.env.db, c.get("user").id, c.req.param("id"));
  if (!login) return c.notFound();
  const t = messages(c);
  const name = login.device_name || t.auth.unnamedComputer;
  await flash(c, loginExpired(login.last_used_at, Date.now()) ? t.auth.cliLoginRemoved(name) : t.auth.cliLoginRevoked(name));
  return c.redirect("/me", 302);
});

usersRoutes.get("/admin/users", requireAdmin, (c) =>
  page(c, <UsersPage user={c.get("user")} users={listUserSummaries(c.env.db, loginIdleCutoff(Date.now()))} />),
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
  if (getUserByUsername(c.env.db, username)) return fail(t.users.usernameTaken);
  createUser(c.env.db, {
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
  const target = getUserById(c.env.db, id);
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
  if (target.role === "admin" && role !== "admin" && countAdmins(c.env.db) <= 1) {
    return userSettings(c, target.id, { error: messages(c).users.lastAdminDemote });
  }
  updateUserRole(c.env.db, target.id, role);
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
  updatePassword(c.env.db, guard.target.id, await hashPassword(password));
  await flash(c, messages(c).users.passwordReset(guard.target.username));
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/install-key", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  rotateInstallKeys(c.env.db, guard.target.id, newInstallKey);
  await flash(c, messages(c).users.keysRotated(guard.target.username));
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/api-token", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  const { token } = issueApiToken(c.env.db, guard.target.id);
  return userSettings(c, guard.target.id, { newToken: token });
});

usersRoutes.post("/admin/users/:id/api-token/revoke", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), { allowSelf: true });
  if (!guard.ok) return guard.response;
  updateApiTokenHash(c.env.db, guard.target.id, null);
  return c.redirect(userSettingsPath(guard.target.id), 302);
});

usersRoutes.post("/admin/users/:id/delete", requireAdmin, async (c) => {
  const guard = await adminTarget(c, c.req.param("id"), {
    selfError: messages(c).users.notOwnDelete,
  });
  if (!guard.ok) return guard.response;
  const { admin, target } = guard;
  if (target.role === "admin" && countAdmins(c.env.db) <= 1) {
    return userSettings(c, target.id, { error: messages(c).users.lastAdminDelete });
  }
  deleteUserReassigning(c.env.db, target.id, admin.id);
  await flash(c, messages(c).users.deleted(target.username));
  return c.redirect("/admin/users", 302);
});
