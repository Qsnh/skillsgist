import { Hono } from "hono";
import { requireManagedSkill, requireUser, userFromApiToken } from "../auth";
import type { AppEnv } from "../auth";
import { API_PREFIX, page } from "../csrf";
import { getVersion } from "../db/queries";
import type { VersionRow } from "../db/queries";
import { ForbiddenError, publishBytes, repackWithSkillMd } from "../publish";
import { UploadError } from "../skills/normalize";
import { EditSkillPage, NewSkillPage, UploadVersionPage } from "../views/publish";

export const publishRoutes = new Hono<AppEnv>();

// `undefined` here must mean "the caller didn't supply a visibility at
// all" (e.g. `PUT /api/skills/:slug` with no `?visibility=` query param),
// distinct from "explicitly chose private" — `publishBytes` treats those
// two cases differently on a republish (see src/publish.ts). Only an
// absent value maps to `undefined`; any present-but-unrecognized value
// (including "") is still treated as an explicit choice and defaults to
// "private", same as before.
function visibilityOf(value: unknown): "public" | "private" | undefined {
  if (value === undefined) return undefined;
  return value === "public" ? "public" : "private";
}

/**
 * The two errors `publishBytes` raises for bad or unauthorized input. Both
 * carry their own HTTP status, so a handler maps them with one branch instead
 * of one `instanceof` per status — and a third such error class would need no
 * change at any call site.
 */
function publishFailure(err: unknown): (UploadError | ForbiddenError) | null {
  return err instanceof UploadError || err instanceof ForbiddenError ? err : null;
}

/** 一次「只改文本」的编辑会原样带走的路径——SKILL.md 之外的全部。 */
function siblingPaths(latest: VersionRow): string[] {
  return (JSON.parse(latest.files) as Array<{ path: string }>)
    .map((f) => f.path)
    .filter((path) => path !== "SKILL.md");
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

publishRoutes.get("/new", requireUser, async (c) => page(c, <NewSkillPage user={c.get("user")} />));

publishRoutes.post("/new", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  try {
    const bytes = await bytesFromForm(body);
    const result = await publishBytes(c.env, user, bytes, { visibility: visibilityOf(body.visibility) });
    return c.redirect(`/s/${result.slug}`, 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(c, <NewSkillPage user={user} error={failure.message} markdown={markdown} />, failure.status);
  }
});

publishRoutes.get("/s/:slug/edit", requireUser, async (c) => {
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "编辑");
  if (!guard.ok) return guard.response;
  const latest = await getVersion(c.env.DB, slug, guard.skill.latest_version);
  if (!latest) return c.notFound();
  return page(
    c,
    <EditSkillPage
      user={c.get("user")}
      slug={slug}
      markdown={latest.skill_md}
      files={siblingPaths(latest)}
    />,
  );
});

publishRoutes.post("/s/:slug/edit", requireUser, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "编辑");
  if (!guard.ok) return guard.response;
  const latest = await getVersion(c.env.DB, slug, guard.skill.latest_version);
  if (!latest) return c.notFound();
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  try {
    if (!markdown.trim()) throw new UploadError("SKILL.md 不能为空");
    // 这一页只改得动 SKILL.md，其余文件从上一版的包里带过来。
    const bytes = await repackWithSkillMd(c.env, latest, `${markdown.trim()}\n`);
    await publishBytes(c.env, user, bytes, { expectedSlug: slug });
    return c.redirect(`/s/${slug}`, 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(
      c,
      <EditSkillPage
        user={user}
        slug={slug}
        markdown={markdown}
        files={siblingPaths(latest)}
        error={failure.message}
      />,
      failure.status,
    );
  }
});

// 和编辑页并列的另一条路：整包替换。两个 handler 各自只读一个字段——编辑读
// markdown，这里读 file——所以「两个都填了听谁的」这条规则不存在。
publishRoutes.get("/s/:slug/upload", requireUser, async (c) => {
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "更新");
  if (!guard.ok) return guard.response;
  return page(c, <UploadVersionPage user={c.get("user")} slug={slug} />);
});

publishRoutes.post("/s/:slug/upload", requireUser, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const guard = await requireManagedSkill(c, slug, "更新");
  if (!guard.ok) return guard.response;
  const body = await c.req.parseBody();
  try {
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) {
      throw new UploadError("请选择一个压缩包");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await publishBytes(c.env, user, bytes, { expectedSlug: slug });
    return c.redirect(`/s/${slug}`, 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(c, <UploadVersionPage user={user} slug={slug} error={failure.message} />, failure.status);
  }
});

publishRoutes.put(`${API_PREFIX}skills/:slug`, async (c) => {
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
    const failure = publishFailure(err);
    if (!failure) throw err;
    return c.json({ error: failure.code, message: failure.message }, failure.status);
  }
});
