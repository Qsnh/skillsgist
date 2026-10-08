import { Hono } from "hono";
import { currentUser, requireUser } from "../auth";
import type { AppEnv } from "../auth";
import { normalizeUserCode } from "../credentials";
import { page } from "../csrf";
import {
  approveLogin, codeEntryLocked, denyLogin, getDecidedLogin, getLoginByUserCode, recordCodeFailure,
} from "../db/logins";
import type { Viewer } from "../db/queries";
import { localeOf, messages } from "../i18n";
import { formatList } from "../i18n/format";
import { safeNext } from "../paths";
import { DeviceCodePage, DeviceConfirmPage, DeviceDonePage } from "../views/device";

export const deviceRoutes = new Hono<AppEnv>();

const values = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

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
  if (!user) {
    const here = raw ? `/device?code=${encodeURIComponent(raw)}` : "/device";
    return c.redirect(`/login?next=${encodeURIComponent(safeNext(here))}`, 302);
  }
  return page(c, <DeviceCodePage user={user} code={normalizeUserCode(raw) ?? ""} />);
});

deviceRoutes.post("/device", requireUser, async (c) => {
  const user = c.get("user");
  const t = messages(c);
  const body = await c.req.parseBody({ all: true });
  const raw = values(body.code)[0] ?? "";
  const now = Date.now();
  if (await codeEntryLocked(c.env.DB, user.id, now)) {
    return page(c, <DeviceCodePage user={user} code={raw} error={t.device.locked} />, 429);
  }
  const code = normalizeUserCode(raw);
  const login = code ? await getLoginByUserCode(c.env.DB, code) : null;
  if (login && login.user_id === user.id) return c.redirect(`/device/${login.id}`, 302);
  if (login?.status === "pending" && login.expires_at <= now) {
    return page(c, <DeviceCodePage user={user} code="" error={t.device.expired} />, 400);
  }
  if (!code || !login || login.status !== "pending") {
    await recordCodeFailure(c.env.DB, user.id, now);
    return page(c, <DeviceCodePage user={user} code={raw} error={t.device.badCode} />, 400);
  }
  const lost = async () =>
    (await getLoginByUserCode(c.env.DB, code))?.user_id === user.id
      ? c.redirect(`/device/${login.id}`, 302)
      : page(c, <DeviceCodePage user={user} code="" error={t.device.badCode} />, 400);
  const decision = values(body.decision)[0];
  if (decision === "deny") {
    if (!(await denyLogin(c.env.DB, login.id, user.id, now))) return lost();
    return c.redirect(`/device/${login.id}`, 302);
  }
  if (decision === "approve") {
    const chosen = ownProjects(user, values(body.project));
    if (chosen.length === 0) {
      return page(c, <DeviceConfirmPage user={user} login={login} code={code} checked={[]} error={t.device.chooseProject} />, 400);
    }
    if (!(await approveLogin(c.env.DB, login.id, user.id, chosen, now))) return lost();
    return c.redirect(`/device/${login.id}`, 302);
  }
  return page(c, <DeviceConfirmPage user={user} login={login} code={code} checked={preselected(user, login.requested_scope)} />);
});

deviceRoutes.get("/device/:id", requireUser, async (c) => {
  const user = c.get("user");
  const login = await getDecidedLogin(c.env.DB, c.req.param("id"), user.id);
  if (login?.status === "denied") return page(c, <DeviceDonePage user={user} projects={null} />);
  if (!login || login.projects.length === 0) return c.redirect("/device", 302);
  return page(c, <DeviceDonePage user={user} projects={formatList(localeOf(c), login.projects)} />);
});
