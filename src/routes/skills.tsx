import { Hono } from "hono";
import {
  canManage, canPublishIn, canView, currentUser, publishableProjects, requireManagedSkill, requireUser, skillScope,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import {
  deleteSkill, getArtifactByVersion, getProject, getSkill, getSkillWithAuthor, getVersion, listSkills,
  listVersions, moveSkill, projectsWithSkillNamed, setVisibility, updateVersionHtml,
} from "../db/queries";
import type { Db } from "../db/database";
import type { Viewer } from "../db/queries";
import { messages } from "../i18n";
import { skillPath } from "../paths";
import { RENDER_REVISION, renderSkillMd } from "../render/markdown";
import { IndexPage, SkillPage } from "../views/skills";
import { openArchive, serveDownload, sessionDownloader } from "./download";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  const skills = listSkills(c.env.db, { scope: skillScope(user), q: q || undefined });
  return page(c, <IndexPage user={user} skills={skills} q={q} />);
});

function moveTargets(db: Db, user: Viewer, slug: string): Array<{ slug: string; name: string }> {
  const taken = projectsWithSkillNamed(db, slug);
  return publishableProjects(db, user).filter((p) => !taken.includes(p.slug));
}

skillsRoutes.get("/p/:project/s/:slug", async (c) => {
  const user = await currentUser(c);
  const project = c.req.param("project");
  const slug = c.req.param("slug");
  const skill = getSkillWithAuthor(c.env.db, project, slug);
  if (!skill) return c.notFound();
  if (!canView(user, skill)) return c.notFound();

  const manage = user !== null && canManage(user, skill);
  const requested = Number(c.req.query("v") ?? skill.latest_version);
  const version = getVersion(c.env.db, project, slug, Number.isInteger(requested) ? requested : skill.latest_version);
  if (!version) return c.notFound();
  const versions = listVersions(c.env.db, project, slug);
  const targets = manage ? moveTargets(c.env.db, user, slug) : [];

  if (version.html_rev < RENDER_REVISION) {
    version.html = await renderSkillMd(version.skill_md);
    try {
      updateVersionHtml(c.env.db, project, slug, version.version, version.html, RENDER_REVISION);
    } catch (err) {
      console.error("html heal write failed", err);
    }
  }

  return page(
    c,
    <SkillPage
      user={user}
      skill={skill}
      version={version}
      versions={versions}
      origin={new URL(c.req.url).origin}
      canManage={manage}
      moveTargets={targets}
    />,
  );
});

async function download(c: Ctx, project: string, slug: string, versionNumber: number | null) {
  const user = await currentUser(c);
  const artifact = getArtifactByVersion(c.env.db, project, slug, versionNumber);
  if (!artifact || !canView(user, artifact)) return c.notFound();

  const object = await openArchive(c, artifact.object_key);
  if (!object) return c.notFound();

  return serveDownload(c, object, artifact, artifact.visibility === "public", sessionDownloader(user));
}

skillsRoutes.get("/p/:project/s/:slug/download", (c) =>
  download(c, c.req.param("project"), c.req.param("slug"), null),
);

skillsRoutes.get("/p/:project/s/:slug/v/:version/download", (c) => {
  const n = Number(c.req.param("version"));
  if (!Number.isInteger(n) || n < 1) return c.notFound();
  return download(c, c.req.param("project"), c.req.param("slug"), n);
});

skillsRoutes.post("/p/:project/s/:slug/visibility", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "modify");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  setVisibility(c.env.db, skill.project, skill.slug, skill.visibility === "public" ? "private" : "public");
  return c.redirect(skillPath(skill), 302);
});

skillsRoutes.post("/p/:project/s/:slug/move", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "move");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const body = await c.req.parseBody();
  const target = getProject(c.env.db, typeof body.project === "string" ? body.project : "");
  if (!target || !canPublishIn(c.get("user"), target.slug)) {
    return c.text(messages(c).skills.moveForbidden, 403);
  }
  if (getSkill(c.env.db, target.slug, skill.slug)) {
    return c.text(messages(c).skills.nameTakenIn(target.name, skill.slug), 409);
  }
  moveSkill(c.env.db, skill.project, skill.slug, target.slug);
  return c.redirect(skillPath({ project: target.slug, slug: skill.slug }), 302);
});

skillsRoutes.post("/p/:project/s/:slug/delete", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "delete");
  if (!guard.ok) return guard.response;
  const keys = deleteSkill(c.env.db, guard.skill.project, guard.skill.slug);
  const removals = await Promise.allSettled(keys.map((key) => c.env.storage.delete(key)));
  for (const removal of removals) {
    if (removal.status === "rejected") console.error("skill archive delete failed", removal.reason);
  }
  return c.redirect("/", 302);
});
