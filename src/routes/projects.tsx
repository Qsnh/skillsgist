import { Hono } from "hono";
import {
  canAccessProject, canManageProject, currentUser, membershipIn, newInstallKey, requireAdmin, requireUser, roleOf,
  skillScope,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { page } from "../csrf";
import {
  addMembership, createProject, deleteMembership, deleteProject, getMember, getProject, getUserById, listMembers,
  listNonMembers, listProjectSummaries, listSkills, projectHasSkills, projectNameTaken, renameProject,
  updateInstallKey, updateMembershipRole,
} from "../db/queries";
import type { ProjectRow, Viewer } from "../db/queries";
import { flash } from "../flash";
import { projectPath, projectSettingsPath } from "../paths";
import { NewProjectPage, ProjectPage, ProjectSettingsPage, ProjectsPage } from "../views/projects";

const PROJECT_SLUG = /^[a-z0-9-]{2,32}$/;

const NAME_ERROR = "Project names must be 1-64 characters on one line";

function projectName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

const originOf = (c: Ctx) => new URL(c.req.url).origin;

export const projectsRoutes = new Hono<AppEnv>();

projectsRoutes.get("/projects", requireUser, async (c) => {
  const user = c.get("user");
  const projects = await listProjectSummaries(c.env.DB, user.id, user.role === "admin");
  return page(c, <ProjectsPage user={user} projects={projects} />);
});

projectsRoutes.get("/projects/new", requireAdmin, (c) => page(c, <NewProjectPage user={c.get("user")} />));

projectsRoutes.post("/projects/new", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const rawName = String(body.name ?? "");
  const slug = String(body.slug ?? "");
  const fail = (error: string) =>
    page(c, <NewProjectPage user={c.get("user")} name={rawName} slug={slug} error={error} />, 400);
  const name = projectName(rawName);
  if (!name) return fail(NAME_ERROR);
  if (!PROJECT_SLUG.test(slug)) return fail("Addresses must be 2-32 lowercase letters, digits or hyphens");
  if (await getProject(c.env.DB, slug)) return fail("That address is taken");
  if (await projectNameTaken(c.env.DB, name, null)) return fail("That name is taken");
  await createProject(c.env.DB, { slug, name });
  return c.redirect(projectPath(slug), 302);
});

async function settingsPage(c: Ctx, user: Viewer, project: ProjectRow, error?: string): Promise<Response> {
  const manage = canManageProject(user, project.slug);
  const [hasSkills, members, candidates] = await Promise.all([
    projectHasSkills(c.env.DB, project.slug, false),
    listMembers(c.env.DB, project.slug),
    manage ? listNonMembers(c.env.DB, project.slug) : Promise.resolve([]),
  ]);
  return page(
    c,
    <ProjectSettingsPage
      user={user}
      project={project}
      origin={originOf(c)}
      hasSkills={hasSkills}
      members={members}
      candidates={candidates}
      canManage={manage}
      error={error}
    />,
    error ? 400 : undefined,
  );
}

async function projectGuard(
  c: Ctx,
  slug: string,
  manage: boolean,
): Promise<{ ok: true; project: ProjectRow } | { ok: false; response: Response }> {
  const user = c.get("user");
  const project = await getProject(c.env.DB, slug);
  if (!project || !canAccessProject(user, slug)) return { ok: false, response: await c.notFound() };
  if (manage && !canManageProject(user, slug)) {
    return { ok: false, response: c.text("Only this project's admins can do that", 403) };
  }
  return { ok: true, project };
}

projectsRoutes.get("/p/:project", async (c) => {
  const slug = c.req.param("project");
  const [user, project, hasPublicSkills] = await Promise.all([
    currentUser(c),
    getProject(c.env.DB, slug),
    projectHasSkills(c.env.DB, slug, true),
  ]);
  if (!project) return c.notFound();
  if (!hasPublicSkills && !(user && canAccessProject(user, slug))) return c.notFound();
  const q = c.req.query("q") ?? "";
  const skills = await listSkills(c.env.DB, { scope: skillScope(user), project: slug, q: q || undefined });
  return page(
    c,
    <ProjectPage
      user={user}
      project={project}
      origin={originOf(c)}
      skills={skills}
      q={q}
      hasPublicSkills={hasPublicSkills}
    />,
  );
});

projectsRoutes.get("/p/:project/settings", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), false);
  if (!guard.ok) return guard.response;
  return settingsPage(c, c.get("user"), guard.project);
});

projectsRoutes.post("/p/:project/install-key", requireUser, async (c) => {
  const user = c.get("user");
  const project = c.req.param("project");
  if (!membershipIn(user, project)) return c.notFound();
  await updateInstallKey(c.env.DB, project, user.id, newInstallKey());
  return c.redirect(projectSettingsPath(project), 302);
});

projectsRoutes.post("/p/:project/rename", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const body = await c.req.parseBody();
  const name = projectName(body.name);
  if (!name) return settingsPage(c, c.get("user"), project, NAME_ERROR);
  if (await projectNameTaken(c.env.DB, name, project.slug)) {
    return settingsPage(c, c.get("user"), project, "That name is taken");
  }
  await renameProject(c.env.DB, project.slug, name);
  await flash(c, `Renamed the project to ${name}.`);
  return c.redirect(projectSettingsPath(project.slug), 302);
});

projectsRoutes.post("/p/:project/members", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const body = await c.req.parseBody();
  const target = await getUserById(c.env.DB, String(body.user ?? ""));
  if (!target) return settingsPage(c, c.get("user"), project, "Choose an account to add");
  if (await getMember(c.env.DB, project.slug, target.id)) {
    return settingsPage(c, c.get("user"), project, `${target.username} is already a member`);
  }
  await addMembership(c.env.DB, {
    project: project.slug, userId: target.id, role: roleOf(body.role), installKey: newInstallKey(),
  });
  await flash(c, `Added ${target.username} to ${project.name}.`);
  return c.redirect(projectSettingsPath(project.slug), 302);
});

projectsRoutes.post("/p/:project/members/:userId/role", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const member = await getMember(c.env.DB, guard.project.slug, c.req.param("userId"));
  if (!member) return c.notFound();
  const body = await c.req.parseBody();
  await updateMembershipRole(c.env.DB, guard.project.slug, member.user_id, roleOf(body.role));
  return c.redirect(projectSettingsPath(guard.project.slug), 302);
});

projectsRoutes.post("/p/:project/members/:userId/remove", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const member = await getMember(c.env.DB, project.slug, c.req.param("userId"));
  if (!member) return c.notFound();
  await deleteMembership(c.env.DB, project.slug, member.user_id);
  await flash(c, `Removed ${member.username} from ${project.name}. Their install key for it no longer works.`);
  const user = c.get("user");
  const stillSees = user.role === "admin" || member.user_id !== user.id;
  return c.redirect(stillSees ? projectSettingsPath(project.slug) : "/projects", 302);
});

projectsRoutes.post("/p/:project/delete", requireAdmin, async (c) => {
  const project = await getProject(c.env.DB, c.req.param("project"));
  if (!project) return c.notFound();
  if (!(await deleteProject(c.env.DB, project.slug))) {
    return settingsPage(c, c.get("user"), project, `${project.name} still has skills. Move or delete them first.`);
  }
  await flash(c, `Deleted project ${project.name}.`);
  return c.redirect("/projects", 302);
});
