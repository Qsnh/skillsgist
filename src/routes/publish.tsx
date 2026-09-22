import { Hono } from "hono";
import { canManage, currentUser, userFromApiToken } from "../auth";
import { getSkill, getVersion } from "../db/queries";
import { ForbiddenError, publishBytes } from "../publish";
import { UploadError } from "../skills/normalize";
import type { Env } from "../types";
import { EditSkillPage, NewSkillPage } from "../views/publish";

export const publishRoutes = new Hono<{ Bindings: Env }>();

function visibilityOf(value: unknown): "public" | "private" {
  return value === "public" ? "public" : "private";
}

async function bytesFromForm(body: Record<string, unknown>): Promise<Uint8Array> {
  const file = body.file;
  if (file instanceof File && file.size > 0) {
    return new Uint8Array(await file.arrayBuffer());
  }
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  if (markdown) return new TextEncoder().encode(`${markdown}\n`);
  throw new UploadError("请上传压缩包，或在文本框里粘贴 SKILL.md 内容");
}

publishRoutes.get("/new", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  return c.html(<NewSkillPage user={user} />);
});

publishRoutes.post("/new", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  try {
    const bytes = await bytesFromForm(body);
    const result = await publishBytes(c.env, user, bytes, { visibility: visibilityOf(body.visibility) });
    return c.redirect(`/s/${result.slug}`, 302);
  } catch (err) {
    if (err instanceof UploadError) {
      return c.html(<NewSkillPage user={user} error={err.message} markdown={markdown} />, 400);
    }
    if (err instanceof ForbiddenError) {
      return c.html(<NewSkillPage user={user} error={err.message} markdown={markdown} />, 403);
    }
    throw err;
  }
});

publishRoutes.get("/s/:slug/edit", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权编辑这个 skill", 403);
  const latest = await getVersion(c.env.DB, slug, skill.latest_version);
  if (!latest) return c.notFound();
  return c.html(<EditSkillPage user={user} slug={slug} markdown={latest.skill_md} />);
});

publishRoutes.post("/s/:slug/edit", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login", 302);
  const slug = c.req.param("slug");
  const skill = await getSkill(c.env.DB, slug);
  if (!skill) return c.notFound();
  if (!canManage(user, skill)) return c.text("无权编辑这个 skill", 403);
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  try {
    const bytes = new TextEncoder().encode(`${markdown.trim()}\n`);
    await publishBytes(c.env, user, bytes, { expectedSlug: slug });
    return c.redirect(`/s/${slug}`, 302);
  } catch (err) {
    if (err instanceof UploadError) {
      return c.html(<EditSkillPage user={user} slug={slug} markdown={markdown} error={err.message} />, 400);
    }
    throw err;
  }
});

publishRoutes.put("/api/skills/:slug", async (c) => {
  const user = await userFromApiToken(c);
  if (!user) return c.notFound();
  const slug = c.req.param("slug");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await publishBytes(c.env, user, bytes, {
      expectedSlug: slug,
      visibility: visibilityOf(c.req.query("visibility")),
    });
    return c.json(result, result.unchanged ? 200 : 201);
  } catch (err) {
    if (err instanceof UploadError) return c.json({ error: "invalid_upload", message: err.message }, 400);
    if (err instanceof ForbiddenError) return c.json({ error: "forbidden", message: err.message }, 403);
    throw err;
  }
});
