import { Hono } from "hono";
import { canManage, canView, requireAdmin, requireUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import { DOWNLOAD_SOURCES, downloadStats, listDownloadLogs } from "../db/downloads";
import type { DownloadFilter, DownloadScope } from "../db/downloads";
import { getSkillWithAuthor } from "../db/queries";
import { messages } from "../i18n";
import { DAY_MS, retentionCutoff, retentionDays } from "../retention";
import { CHART_DAYS, DownloadsPage } from "../views/downloads";
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

function readFilter(c: Ctx, subject: DownloadsSubject): DownloadFilter {
  const source = c.req.query("source");
  return {
    project: subject.kind === "all" ? idParam(c, "project") : null,
    skillId: subject.kind === "skill" ? null : idParam(c, "skill"),
    userId: idParam(c, "user"),
    source: DOWNLOAD_SOURCES.find((s) => s === source) ?? null,
  };
}

function readCursor(c: Ctx): number | null {
  const value = c.req.query("before");
  return value !== undefined && CURSOR.test(value) ? Number(value) : null;
}

function scopeOf(subject: DownloadsSubject): DownloadScope {
  switch (subject.kind) {
    case "skill":
      return { kind: "skill", skillId: subject.skill.id };
    case "project":
      return { kind: "project", project: subject.project.slug };
    case "all":
      return { kind: "all" };
  }
}

async function downloadsPage(c: Ctx, subject: DownloadsSubject): Promise<Response> {
  const now = Date.now();
  const days = retentionDays(c.env);
  const kept = retentionCutoff(days, now);
  const today = Math.floor(now / DAY_MS);
  const scope = scopeOf(subject);
  const filter = readFilter(c, subject);
  const before = readCursor(c);
  const [stats, log] = await Promise.all([
    downloadStats(c.env.DB, scope, filter, Math.max(kept, (today - CHART_DAYS + 1) * DAY_MS)),
    listDownloadLogs(c.env.DB, scope, filter, { since: kept, before, limit: PAGE_SIZE }),
  ]);
  return page(
    c,
    <DownloadsPage
      user={c.get("user")}
      subject={subject}
      filter={filter}
      stats={stats}
      rows={log.rows}
      more={log.more}
      paged={before !== null}
      retentionDays={days}
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
