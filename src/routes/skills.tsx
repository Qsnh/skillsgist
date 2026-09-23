import { Hono } from "hono";
import { zipAttachment } from "../artifact";
import { canManage, canView, currentUser, requireManagedSkill, requireUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import {
  deleteSkill, getArtifactByVersion, getSkillWithAuthor, getVersion, listSkills, setVisibility,
} from "../db/queries";
import { IndexPage, SkillPage } from "../views/skills";

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  const skills = await listSkills(c.env.DB, { includePrivate: user !== null, q: q || undefined });
  return page(c, <IndexPage user={user} skills={skills} q={q} origin={new URL(c.req.url).origin} />);
});

skillsRoutes.get("/s/:slug", async (c) => {
  const user = await currentUser(c);
  const slug = c.req.param("slug");
  const skill = await getSkillWithAuthor(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canView(user, skill)) return c.notFound();

  const requested = Number(c.req.query("v") ?? skill.latest_version);
  const version = await getVersion(
    c.env.DB,
    slug,
    Number.isInteger(requested) ? requested : skill.latest_version,
  );
  if (!version) return c.notFound();

  return page(
    c,
    <SkillPage
      user={user}
      skill={skill}
      version={version}
      origin={new URL(c.req.url).origin}
      canManage={user ? canManage(user, skill) : false}
    />,
  );
});

async function download(c: Ctx, slug: string, versionNumber: number | null) {
  const user = await currentUser(c);
  const artifact = await getArtifactByVersion(c.env.DB, slug, versionNumber);
  if (!artifact || !canView(user, artifact)) return c.notFound();

  const object = await c.env.BUCKET.get(artifact.r2_key);
  if (!object) return c.notFound();

  return zipAttachment(object, slug, artifact.visibility === "public");
}

skillsRoutes.get("/s/:slug/download", (c) => download(c, c.req.param("slug"), null));

skillsRoutes.get("/s/:slug/v/:version/download", (c) => {
  const n = Number(c.req.param("version"));
  if (!Number.isInteger(n) || n < 1) return c.notFound();
  return download(c, c.req.param("slug"), n);
});

skillsRoutes.post("/s/:slug/visibility", requireUser, async (c) => {
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "modify");
  if (!guard.ok) return guard.response;
  await setVisibility(c.env.DB, slug, guard.skill.visibility === "public" ? "private" : "public");
  return c.redirect(`/s/${slug}`, 302);
});

skillsRoutes.post("/s/:slug/delete", requireUser, async (c) => {
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "delete");
  if (!guard.ok) return guard.response;
  const keys = await deleteSkill(c.env.DB, slug);
  await Promise.all(keys.map((key) => c.env.BUCKET.delete(key)));
  return c.redirect("/", 302);
});
