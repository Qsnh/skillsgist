import { Hono } from "hono";
import { canManage, currentUser } from "../auth";
import type { Ctx } from "../auth";
import { page } from "../csrf";
import {
  deleteSkill, getSkill, getUserById, getVersion, listSkills, listVersions, setVisibility,
} from "../db/queries";
import type { Env } from "../types";
import { IndexPage, SkillPage } from "../views/skills";

export const skillsRoutes = new Hono<{ Bindings: Env }>();

skillsRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  const skills = await listSkills(c.env.DB, { includePrivate: user !== null, q: q || undefined });
  return page(c, <IndexPage user={user} skills={skills} q={q} origin={new URL(c.req.url).origin} />);
});

skillsRoutes.get("/s/:slug", async (c) => {
  const user = await currentUser(c);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (skill.visibility === "private" && !user) return c.notFound();

  const requested = Number(c.req.query("v") ?? skill.latest_version);
  const version = await getVersion(c.env.DB, slug, Number.isInteger(requested) ? requested : skill.latest_version);
  if (!version) return c.notFound();

  const author = await getUserById(c.env.DB, skill.owner_id);

  return page(
    c,
    <SkillPage
      user={user}
      skill={{ ...skill, author: author?.username ?? "unknown" }}
      version={version}
      versions={await listVersions(c.env.DB, slug)}
      origin={new URL(c.req.url).origin}
      canManage={user ? canManage(user, skill) : false}
    />,
  );
});

async function download(c: Ctx, versionNumber?: number) {
  const user = await currentUser(c);
  // `c` is typed as the generic `Ctx` (no path pattern attached), so Hono's
  // param() overloads fall back to `string | undefined` here even though
  // both call sites below only ever reach this function via a route
  // registered with `:slug` in its pattern, where it's always present.
  const slug = c.req.param("slug") as string;
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (skill.visibility === "private" && !user) return c.notFound();

  const version = await getVersion(c.env.DB, slug, versionNumber ?? skill.latest_version);
  if (!version) return c.notFound();

  const object = await c.env.BUCKET.get(version.r2_key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Cache-Control": skill.visibility === "public" ? "public, max-age=300" : "private, no-store",
    },
  });
}

skillsRoutes.get("/s/:slug/download", (c) => download(c));

skillsRoutes.get("/s/:slug/v/:version/download", (c) => {
  const n = Number(c.req.param("version"));
  if (!Number.isInteger(n) || n < 1) return c.notFound();
  return download(c, n);
});

skillsRoutes.post("/s/:slug/visibility", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权修改这个 skill", 403);
  await setVisibility(c.env.DB, slug, skill.visibility === "public" ? "private" : "public");
  return c.redirect(`/s/${slug}`, 302);
});

skillsRoutes.post("/s/:slug/delete", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权删除这个 skill", 403);
  const keys = await deleteSkill(c.env.DB, slug);
  await Promise.all(keys.map((key) => c.env.BUCKET.delete(key)));
  return c.redirect("/", 302);
});
