import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { currentUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { normalizeUserCode } from "../credentials";
import { page } from "../csrf";
import {
  approveLogin, claimCodeAttempt, denyLogin, getDecidedLogin, getLoginByUserCode, refundCodeAttempt,
} from "../db/logins";
import { getViewer } from "../db/queries";
import type { Viewer } from "../db/queries";
import { localeOf, messages } from "../i18n";
import { formatList } from "../i18n/format";
import { safeNext } from "../paths";
import { DeviceCodePage, DeviceConfirmPage, DeviceDonePage } from "../views/device";

export const deviceRoutes = new Hono<AppEnv>();

const values = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

const codePage = (raw: string) => (raw ? `/device?code=${encodeURIComponent(raw)}` : "/device");

const signInFirst = (c: Ctx, back: string) => c.redirect(`/login?next=${encodeURIComponent(safeNext(back))}`, 302);

const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (user) {
    c.set("user", user);
    return next();
  }
  if (c.req.method === "GET") return signInFirst(c, c.req.path);
  return signInFirst(c, codePage(values((await c.req.parseBody()).code)[0] ?? ""));
};

function ownProjects(user: Viewer, wanted: string[]): string[] {
  const own = new Set(user.memberships.map((m) => m.project));
  return [...new Set(wanted.filter((project) => own.has(project)))];
}

function preselected(user: Viewer, scope: string | null): string[] {
  const chosen = ownProjects(user, (scope ?? "").split(" "));
  if (chosen.length === 0 && user.memberships.length === 1) return [user.memberships[0].project];
  return chosen;
}

deviceRoutes.get("/device", async (c) => {
  const user = await currentUser(c);
  const raw = c.req.query("code") ?? "";
  if (!user) return signInFirst(c, codePage(raw));
  return page(c, <DeviceCodePage user={user} code={normalizeUserCode(raw) ?? ""} />);
});

deviceRoutes.post("/device", signedIn, async (c) => {
  const user = c.get("user");
  const t = messages(c);
  const body = await c.req.parseBody({ all: true });
  const raw = values(body.code)[0] ?? "";
  const now = Date.now();
  const code = normalizeUserCode(raw);
  const login = code ? await getLoginByUserCode(c.env.DB, code) : null;
  if (login && login.user_id === user.id) return c.redirect(`/device/${login.id}`, 302);
  if (!(await claimCodeAttempt(c.env.DB, user.id, now))) {
    return page(c, <DeviceCodePage user={user} code={raw} error={t.device.locked} />, 429);
  }
  if (!code || !login || login.status !== "pending") {
    return page(c, <DeviceCodePage user={user} code={raw} error={t.device.badCode} />, 400);
  }
  await refundCodeAttempt(c.env.DB, user.id);
  if (login.expires_at <= now) {
    return page(c, <DeviceCodePage user={user} code="" error={t.device.expired} />, 400);
  }
  const confirm = (viewer: Viewer, checked: string[], error?: string) =>
    page(
      c,
      <DeviceConfirmPage user={viewer} login={login} code={code} checked={checked} error={error} />,
      error ? 400 : undefined,
      codePage(code),
    );
  const lost = async () => {
    const current = await getLoginByUserCode(c.env.DB, code);
    if (current?.user_id === user.id) return c.redirect(`/device/${login.id}`, 302);
    if (current?.status === "pending" && current.expires_at > Date.now()) {
      return confirm((await getViewer(c.env.DB, user.id)) ?? user, [], t.device.projectsGone);
    }
    return page(c, <DeviceCodePage user={user} code="" error={t.device.badCode} />, 400);
  };
  const decision = values(body.decision)[0];
  if (decision === "deny") {
    if (!(await denyLogin(c.env.DB, login.id, user.id, now))) return lost();
    return c.redirect(`/device/${login.id}`, 302);
  }
  if (decision === "approve") {
    const chosen = ownProjects(user, values(body.project));
    if (chosen.length === 0) return confirm(user, [], t.device.chooseProject);
    if (!(await approveLogin(c.env.DB, login.id, user.id, chosen, now))) return lost();
    return c.redirect(`/device/${login.id}`, 302);
  }
  return confirm(user, preselected(user, login.requested_scope));
});

deviceRoutes.get("/device/:id", signedIn, async (c) => {
  const user = c.get("user");
  const login = await getDecidedLogin(c.env.DB, c.req.param("id"), user.id);
  if (login?.status === "denied") return page(c, <DeviceDonePage user={user} projects={null} />);
  if (!login || login.projects.length === 0) return c.redirect("/device", 302);
  return page(c, <DeviceDonePage user={user} projects={formatList(localeOf(c), login.projects)} />);
});
