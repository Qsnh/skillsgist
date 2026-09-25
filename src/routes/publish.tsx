import { Hono } from "hono";
import { publishableProjects, requireManagedSkill, requireUser, userFromApiToken } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { API_PREFIX, page } from "../csrf";
import { DEFAULT_PROJECT, getVersion } from "../db/queries";
import type { VersionRow, Viewer } from "../db/queries";
import { skillPath } from "../paths";
import { ForbiddenError, publishBytes, repackWithSkillMd, unchangedError } from "../publish";
import { UploadError } from "../skills/normalize";
import { EditSkillPage, NewSkillPage, UploadVersionPage } from "../views/publish";

export const publishRoutes = new Hono<AppEnv>();

function visibilityOf(value: unknown): "public" | "private" | undefined {
  if (value === undefined) return undefined;
  return value === "public" ? "public" : "private";
}

function withLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function publishFailure(err: unknown): (UploadError | ForbiddenError) | null {
  return err instanceof UploadError || err instanceof ForbiddenError ? err : null;
}

/** The paths a text-only edit carries over untouched — everything but SKILL.md. */
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
  const markdown = typeof body.markdown === "string" ? withLf(body.markdown).trim() : "";
  if (markdown) return new TextEncoder().encode(`${markdown}\n`);
  throw new UploadError("Upload an archive, or paste SKILL.md into the text box");
}

function chosenProject(user: Viewer, value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (user.memberships.length === 1) return user.memberships[0].project;
  throw new UploadError(
    user.memberships.length === 0
      ? "You are not in a project yet, so there is nowhere to publish. Ask an admin to add you to one."
      : "Choose which project this skill goes into",
  );
}

const projectsFor = (c: Ctx) => publishableProjects(c.env.DB, c.get("user"));

publishRoutes.get("/new", requireUser, async (c) =>
  page(c, <NewSkillPage user={c.get("user")} projects={await projectsFor(c)} />),
);

publishRoutes.post("/new", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  const selected = typeof body.project === "string" ? body.project : undefined;
  try {
    const bytes = await bytesFromForm(body);
    const result = await publishBytes(c.env, user, bytes, {
      project: chosenProject(user, body.project),
      visibility: visibilityOf(body.visibility),
      rejectUnchanged: true,
    });
    return c.redirect(skillPath(result), 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(
      c,
      <NewSkillPage
        user={user}
        projects={await projectsFor(c)}
        project={selected}
        error={failure.message}
        markdown={markdown}
      />,
      failure.status,
    );
  }
});

publishRoutes.get("/p/:project/s/:slug/edit", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "edit");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const latest = await getVersion(c.env.DB, skill.project, skill.slug, skill.latest_version);
  if (!latest) return c.notFound();
  return page(
    c,
    <EditSkillPage user={c.get("user")} skill={skill} markdown={latest.skill_md} files={siblingPaths(latest)} />,
  );
});

publishRoutes.post("/p/:project/s/:slug/edit", requireUser, async (c) => {
  const user = c.get("user");
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "edit");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const latest = await getVersion(c.env.DB, skill.project, skill.slug, skill.latest_version);
  if (!latest) return c.notFound();
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  try {
    const text = withLf(markdown).trim();
    if (!text) throw new UploadError("SKILL.md cannot be empty");
    if (text === withLf(latest.skill_md).trim()) throw unchangedError(latest);
    // This page can only change SKILL.md; the other files come from the previous version's archive.
    const bytes = await repackWithSkillMd(c.env, latest, `${text}\n`);
    await publishBytes(c.env, user, bytes, { project: skill.project, expectedSlug: skill.slug, rejectUnchanged: true });
    return c.redirect(skillPath(skill), 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(
      c,
      <EditSkillPage
        user={user}
        skill={skill}
        markdown={markdown}
        files={siblingPaths(latest)}
        error={failure.message}
      />,
      failure.status,
    );
  }
});

publishRoutes.get("/p/:project/s/:slug/upload", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "update");
  if (!guard.ok) return guard.response;
  return page(c, <UploadVersionPage user={c.get("user")} skill={guard.skill} />);
});

publishRoutes.post("/p/:project/s/:slug/upload", requireUser, async (c) => {
  const user = c.get("user");
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "update");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const body = await c.req.parseBody();
  try {
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) {
      throw new UploadError("Choose an archive");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await publishBytes(c.env, user, bytes, { project: skill.project, expectedSlug: skill.slug, rejectUnchanged: true });
    return c.redirect(skillPath(skill), 302);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(c, <UploadVersionPage user={user} skill={skill} error={failure.message} />, failure.status);
  }
});

async function publishFromApi(c: Ctx, project: string, slug: string): Promise<Response> {
  const user = await userFromApiToken(c);
  if (!user) return c.notFound();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await publishBytes(c.env, user, bytes, {
      project,
      expectedSlug: slug,
      visibility: visibilityOf(c.req.query("visibility")),
    });
    return c.json(result, result.unchanged ? 200 : 201);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return c.json({ error: failure.code, message: failure.message }, failure.status);
  }
}

publishRoutes.put(`${API_PREFIX}projects/:project/skills/:slug`, (c) =>
  publishFromApi(c, c.req.param("project"), c.req.param("slug")),
);

publishRoutes.put(`${API_PREFIX}skills/:slug`, (c) => publishFromApi(c, DEFAULT_PROJECT, c.req.param("slug")));
