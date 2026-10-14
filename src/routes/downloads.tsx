import { Hono } from "hono";
import { canManage, canView, requireAdmin, requireUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import { DOWNLOAD_SOURCES, downloadStats, filterNames, listDownloadLogs, NO_FILTER } from "../db/downloads";
import type { DownloadFilter } from "../db/downloads";
import { getSkillWithAuthor } from "../db/queries";
import { messages } from "../i18n";
import { retentionCutoff, retentionDays } from "../retention";
import { DAY_MS } from "../time";
import { CHART_DAYS, DownloadsPage, downloadsView } from "../views/downloads";
import type { DownloadsSubject } from "../views/downloads";
import { projectGuard } from "./projects";

export const downloadsRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR = /^[1-9][0-9]{0,15}$/;

function idParam(c: Ctx, name: string): string | null {
  const value = c.req.query(name);
  return value !== undefined && ID.test(value) ? value : null;
}

function readFilter(c: Ctx, scope: Partial<DownloadFilter>): DownloadFilter {
  const source = c.req.query("source");
  return {
    project: "project" in scope ? null : idParam(c, "project"),
    skillId: "skillId" in scope ? null : idParam(c, "skill"),
    userId: idParam(c, "user"),
    source: DOWNLOAD_SOURCES.find((s) => s === source) ?? null,
  };
}

function readCursor(c: Ctx): number | null {
  const value = c.req.query("before");
  return value !== undefined && CURSOR.test(value) ? Number(value) : null;
}

async function downloadsPage(c: Ctx, subject: DownloadsSubject): Promise<Response> {
  const now = Date.now();
  const days = retentionDays(c.env);
  const kept = retentionCutoff(days, now);
  const today = Math.floor(now / DAY_MS);
  const windowDays = Math.min(CHART_DAYS, days);
  const view = downloadsView(subject);
  const filter = readFilter(c, view.scope);
  const within = { ...NO_FILTER, ...view.scope };
  const query = { ...filter, ...view.scope };
  const before = readCursor(c);
  const [stats, log, names] = await Promise.all([
    downloadStats(c.env.DB, query, view.breakdown, today - windowDays + 1),
    listDownloadLogs(c.env.DB, query, { since: kept, before, limit: PAGE_SIZE }),
    filterNames(c.env.DB, filter, within, kept),
  ]);
  return page(
    c,
    <DownloadsPage
      user={c.get("user")}
      view={view}
      filter={filter}
      names={names}
      stats={stats}
      rows={log.rows}
      more={log.more}
      paged={before !== null}
      retentionDays={days}
      windowDays={windowDays}
      today={today}
    />,
  );
}

downloadsRoutes.get("/p/:project/s/:slug/downloads", requireUser, async (c) => {
  const user = c.get("user");
  const skill = await getSkillWithAuthor(c.env.DB, c.req.param("project"), c.req.param("slug"));
  if (!skill || !canView(user, skill)) return c.notFound();
  if (!canManage(user, skill)) return c.text(messages(c).downloads.managersOnly, 403);
  return downloadsPage(c, { kind: "skill", skill });
});

downloadsRoutes.get("/p/:project/downloads", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  return downloadsPage(c, { kind: "project", project: guard.project });
});

downloadsRoutes.get("/admin/downloads", requireAdmin, (c) => downloadsPage(c, { kind: "all" }));
