import { Hono } from "hono";
import {
  canAccessProject, canManageProject, currentUser, membershipIn, requireAdmin, requireUser, roleOf, skillScope,
} from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { newInstallKey } from "../credentials";
import { page } from "../csrf";
import {
  addMembership, createProject, deleteMembership, deleteProject, getMember, getProject, getUserById, listMembers,
  listNonMembers, listProjectSummaries, listSkills, projectHasSkills, projectNameTaken, renameProject,
  updateInstallKey, updateMembershipPublish, updateMembershipRole,
} from "../db/queries";
import type { ProjectRow, Viewer } from "../db/queries";
import { flash } from "../flash";
import { messages } from "../i18n";
import { PROJECT_SLUG, projectPath, projectSettingsPath } from "../paths";
import { NewProjectPage, ProjectPage, ProjectSettingsPage, ProjectsPage } from "../views/projects";

function projectName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

const originOf = (c: Ctx) => new URL(c.req.url).origin;

export const projectsRoutes = new Hono<AppEnv>();

projectsRoutes.get("/projects", requireUser, async (c) => {
  const user = c.get("user");
  const projects = listProjectSummaries(c.env.db, user.id, user.role === "admin");
  return page(c, <ProjectsPage user={user} projects={projects} />);
});

projectsRoutes.get("/projects/new", requireAdmin, (c) => page(c, <NewProjectPage user={c.get("user")} />));

projectsRoutes.post("/projects/new", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const rawName = String(body.name ?? "");
  const slug = String(body.slug ?? "");
  const t = messages(c);
  const fail = (error: string) =>
    page(c, <NewProjectPage user={c.get("user")} name={rawName} slug={slug} error={error} />, 400);
  const name = projectName(rawName);
  if (!name) return fail(t.projects.nameInvalid);
  if (!PROJECT_SLUG.test(slug)) return fail(t.projects.addressInvalid);
  if (getProject(c.env.db, slug)) return fail(t.projects.addressTaken);
  if (projectNameTaken(c.env.db, name, null)) return fail(t.projects.nameTaken);
  createProject(c.env.db, { slug, name });
  return c.redirect(projectPath(slug), 302);
});

async function settingsPage(c: Ctx, user: Viewer, project: ProjectRow, error?: string): Promise<Response> {
  const manage = canManageProject(user, project.slug);
  const hasSkills = projectHasSkills(c.env.db, project.slug, false);
  const members = listMembers(c.env.db, project.slug);
  const candidates = manage ? listNonMembers(c.env.db, project.slug) : [];
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
    projectSettingsPath(project.slug),
  );
}

export async function projectGuard(
  c: Ctx,
  slug: string,
  manage: boolean,
): Promise<{ ok: true; project: ProjectRow } | { ok: false; response: Response }> {
  const user = c.get("user");
  const project = getProject(c.env.db, slug);
  if (!project || !canAccessProject(user, slug)) return { ok: false, response: await c.notFound() };
  if (manage && !canManageProject(user, slug)) {
    return { ok: false, response: c.text(messages(c).projects.adminsOnly, 403) };
  }
  return { ok: true, project };
}

projectsRoutes.get("/p/:project", async (c) => {
  const slug = c.req.param("project");
  const user = await currentUser(c);
  const project = getProject(c.env.db, slug);
  const hasPublicSkills = projectHasSkills(c.env.db, slug, true);
  if (!project) return c.notFound();
  if (!hasPublicSkills && !(user && canAccessProject(user, slug))) return c.notFound();
  const q = c.req.query("q") ?? "";
  const skills = listSkills(c.env.db, { scope: skillScope(user), project: slug, q: q || undefined });
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
  updateInstallKey(c.env.db, project, user.id, newInstallKey());
  return c.redirect(projectSettingsPath(project), 302);
});

projectsRoutes.post("/p/:project/rename", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const body = await c.req.parseBody();
  const name = projectName(body.name);
  const t = messages(c);
  if (!name) return settingsPage(c, c.get("user"), project, t.projects.nameInvalid);
  if (projectNameTaken(c.env.db, name, project.slug)) {
    return settingsPage(c, c.get("user"), project, t.projects.nameTaken);
  }
  renameProject(c.env.db, project.slug, name);
  await flash(c, t.projects.renamed(name));
  return c.redirect(projectSettingsPath(project.slug), 302);
});

projectsRoutes.post("/p/:project/members", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const body = await c.req.parseBody();
  const target = getUserById(c.env.db, String(body.user ?? ""));
  const t = messages(c);
  if (!target) return settingsPage(c, c.get("user"), project, t.projects.chooseAccount);
  if (getMember(c.env.db, project.slug, target.id)) {
    return settingsPage(c, c.get("user"), project, t.projects.alreadyMember(target.username));
  }
  addMembership(c.env.db, {
    project: project.slug, userId: target.id, role: roleOf(body.role), installKey: newInstallKey(),
  });
  await flash(c, t.projects.added(target.username, project.name));
  return c.redirect(projectSettingsPath(project.slug), 302);
});

projectsRoutes.post("/p/:project/members/:userId/role", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const member = getMember(c.env.db, guard.project.slug, c.req.param("userId"));
  if (!member) return c.notFound();
  const body = await c.req.parseBody();
  updateMembershipRole(c.env.db, guard.project.slug, member.user_id, roleOf(body.role));
  return c.redirect(projectSettingsPath(guard.project.slug), 302);
});

projectsRoutes.post("/p/:project/members/:userId/publish", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const member = getMember(c.env.db, guard.project.slug, c.req.param("userId"));
  if (!member) return c.notFound();
  const body = await c.req.parseBody();
  updateMembershipPublish(c.env.db, guard.project.slug, member.user_id, body.publish === "1");
  return c.redirect(projectSettingsPath(guard.project.slug), 302);
});

projectsRoutes.post("/p/:project/members/:userId/remove", requireUser, async (c) => {
  const guard = await projectGuard(c, c.req.param("project"), true);
  if (!guard.ok) return guard.response;
  const { project } = guard;
  const member = getMember(c.env.db, project.slug, c.req.param("userId"));
  if (!member) return c.notFound();
  deleteMembership(c.env.db, project.slug, member.user_id);
  await flash(c, messages(c).projects.removed(member.username, project.name));
  const user = c.get("user");
  const stillSees = user.role === "admin" || member.user_id !== user.id;
  return c.redirect(stillSees ? projectSettingsPath(project.slug) : "/projects", 302);
});

projectsRoutes.post("/p/:project/delete", requireAdmin, async (c) => {
  const project = getProject(c.env.db, c.req.param("project"));
  if (!project) return c.notFound();
  if (!deleteProject(c.env.db, project.slug)) {
    return settingsPage(c, c.get("user"), project, messages(c).projects.stillHasSkills(project.name));
  }
  await flash(c, messages(c).projects.deletedProject(project.name));
  return c.redirect("/projects", 302);
});
