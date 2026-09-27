import { Hono } from "hono";
import {
  canAccessProject, canManage, canView, currentUser, publishableProjects, requireManagedSkill, requireUser, skillScope,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import {
  DEFAULT_PROJECT, deleteSkill, getArtifactByVersion, getProject, getSkill, getSkillWithAuthor, getVersion, listSkills,
  listVersions, moveSkill, projectsWithSkillNamed, setVisibility, updateVersionHtml,
} from "../db/queries";
import type { Viewer } from "../db/queries";
import { skillPath } from "../paths";
import { RENDER_REVISION, renderSkillMd } from "../render/markdown";
import { IndexPage, SkillPage } from "../views/skills";
import { serveDownload } from "./download";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  const skills = await listSkills(c.env.DB, { scope: skillScope(user), q: q || undefined });
  return page(c, <IndexPage user={user} skills={skills} q={q} />);
});

skillsRoutes.get("/s/:slug", (c) => {
  const slug = encodeURIComponent(c.req.param("slug"));
  const query = new URL(c.req.url).search;
  return c.redirect(`${skillPath({ project: DEFAULT_PROJECT, slug })}${query}`, 301);
});

async function moveTargets(db: D1Database, user: Viewer, slug: string): Promise<Array<{ slug: string; name: string }>> {
  const [projects, taken] = await Promise.all([publishableProjects(db, user), projectsWithSkillNamed(db, slug)]);
  return projects.filter((p) => !taken.includes(p.slug));
}

skillsRoutes.get("/p/:project/s/:slug", async (c) => {
  const user = await currentUser(c);
  const project = c.req.param("project");
  const slug = c.req.param("slug");
  const skill = await getSkillWithAuthor(c.env.DB, project, slug);
  if (!skill) return c.notFound();
  if (!canView(user, skill)) return c.notFound();

  const manage = user !== null && canManage(user, skill);
  const requested = Number(c.req.query("v") ?? skill.latest_version);
  const [version, versions, targets] = await Promise.all([
    getVersion(c.env.DB, project, slug, Number.isInteger(requested) ? requested : skill.latest_version),
    listVersions(c.env.DB, project, slug),
    manage ? moveTargets(c.env.DB, user, slug) : [],
  ]);
  if (!version) return c.notFound();

  if (version.html_rev < RENDER_REVISION) {
    version.html = await renderSkillMd(version.skill_md);
    try {
      await updateVersionHtml(c.env.DB, project, slug, version.version, version.html, RENDER_REVISION);
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
  const artifact = await getArtifactByVersion(c.env.DB, project, slug, versionNumber);
  if (!artifact || !canView(user, artifact)) return c.notFound();

  const object = await c.env.BUCKET.get(artifact.r2_key);
  if (!object) return c.notFound();

  return serveDownload(c, object, artifact, artifact.visibility === "public");
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
  await setVisibility(c.env.DB, skill.project, skill.slug, skill.visibility === "public" ? "private" : "public");
  return c.redirect(skillPath(skill), 302);
});

skillsRoutes.post("/p/:project/s/:slug/move", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "move");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const body = await c.req.parseBody();
  const target = await getProject(c.env.DB, typeof body.project === "string" ? body.project : "");
  if (!target || !canAccessProject(c.get("user"), target.slug)) {
    return c.text("You cannot move a skill into that project", 403);
  }
  if (await getSkill(c.env.DB, target.slug, skill.slug)) {
    return c.text(`${target.name} already has a skill named ${skill.slug}`, 409);
  }
  await moveSkill(c.env.DB, skill.project, skill.slug, target.slug);
  return c.redirect(skillPath({ project: target.slug, slug: skill.slug }), 302);
});

skillsRoutes.post("/p/:project/s/:slug/delete", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "delete");
  if (!guard.ok) return guard.response;
  const keys = await deleteSkill(c.env.DB, guard.skill.project, guard.skill.slug);
  await Promise.all(keys.map((key) => c.env.BUCKET.delete(key)));
  return c.redirect("/", 302);
});
