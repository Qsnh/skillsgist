import { canPublishIn, membershipIn } from "../auth";
import { Form } from "../csrf";
import { useT } from "../i18n";
import type { ListedSkill, Member, ProjectRow, ProjectSummary, UserRow, Viewer } from "../db/queries";
import { installBase, installKeyPath, projectPath, projectSettingsPath } from "../paths";
import { RoleLabel } from "./auth";
import { Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";
import { NoMatches, NoSkillsYet, SearchForm, SkillRegistry } from "./skills";

export function ProjectsPage(props: { user: Viewer; projects: ProjectSummary[] }) {
  const t = useT();
  const admin = props.user.role === "admin";
  return (
    <Layout title={t.layout.projects} user={props.user}>
      <PageHead
        title={t.layout.projects}
        compact
        aside={
          <>
            <span class="cf-count">{props.projects.length}</span>
            {admin ? (
              <a href="/projects/new" class="cf-btn cf-btn-outline cf-head-action">{t.projects.newProject}</a>
            ) : null}
          </>
        }
      />
      {props.projects.length === 0 ? (
        <div class="cf-frame">
          <div class="cf-empty">
            <p class="cf-empty-title">{admin ? t.projects.noneAdmin : t.projects.noneMember}</p>
            <p class="cf-empty-body">{admin ? t.projects.noneAdminBody : t.projects.noneMemberBody}</p>
          </div>
        </div>
      ) : (
        <div class="cf-frame cf-table-frame">
          <table class="cf-table">
            <thead>
              <tr>
                <th scope="col">{t.projects.columns.name}</th>
                <th scope="col">{t.projects.columns.yourRole}</th>
                <th scope="col">{t.projects.columns.skills}</th>
                <th scope="col">{t.projects.columns.members}</th>
              </tr>
            </thead>
            <tbody>
              {props.projects.map((p) => (
                <tr>
                  <td data-label={t.projects.columns.name}>
                    <a href={projectSettingsPath(p.slug)} class="cf-link cf-user-name">{p.name}</a>
                  </td>
                  <td data-label={t.projects.columns.yourRole}>{p.role ? <RoleLabel role={p.role} /> : "—"}</td>
                  <td data-label={t.projects.columns.skills} class="cf-table-date">{p.skills}</td>
                  <td data-label={t.projects.columns.members} class="cf-table-date">{p.members}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}

export function NewProjectPage(props: { user: UserRow; name?: string; slug?: string; error?: string }) {
  const t = useT();
  return (
    <Layout title={t.projects.newProject} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.projects.newProject} error={props.error} />
        <Form action="/projects/new" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field label={t.projects.name} name="name" value={props.name} autocomplete="off" hint={t.projects.nameHint} />
              <Field
                label={t.projects.address}
                name="slug"
                value={props.slug}
                autocomplete="off"
                hint={t.projects.addressHint}
              />
            </div>
          </div>
          <div class="cf-form-foot">
            <Button>{t.common.create}</Button>
            <a href="/projects" class="cf-btn cf-btn-outline">{t.common.cancel}</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

function ProjectLede(props: { user: Viewer | null; project: ProjectRow; hasPublicSkills: boolean }) {
  const t = useT();
  const { user, project } = props;
  const settings = <a href={projectSettingsPath(project.slug)}>{t.projects.settings}</a>;
  if (user && membershipIn(user, project.slug)) {
    return <p class="cf-hero-lede">{t.projects.ledeMember(project.name, settings)}</p>;
  }
  if (user?.role === "admin") {
    return <p class="cf-hero-lede">{t.projects.ledeAdmin(project.name, props.hasPublicSkills, settings)}</p>;
  }
  return (
    <p class="cf-hero-lede">
      {t.projects.ledePublic(project.name)}
      {user ? null : t.projects.ledeSignIn(<a href="/login">{t.layout.signIn}</a>)}
    </p>
  );
}

function EmptyProject(props: { project: ProjectRow; q: string; canPublish: boolean }) {
  const { project } = props;
  if (props.q) return <NoMatches q={props.q} within={project.name} clearHref={projectPath(project.slug)} />;
  return <NoSkillsYet within={project.name} publishHref={props.canPublish ? `/new?project=${project.slug}` : undefined} />;
}

export function ProjectPage(props: {
  user: Viewer | null;
  project: ProjectRow;
  origin: string;
  skills: ListedSkill[];
  q: string;
  hasPublicSkills: boolean;
}) {
  const { user, project } = props;
  const path = projectPath(project.slug);
  const membership = user ? membershipIn(user, project.slug) : undefined;
  const base = installBase(props.origin, project.slug, membership?.install_key, props.hasPublicSkills);
  return (
    <Layout title={project.name} user={user} bare>
      <section class="cf-hero" aria-labelledby="hero-title">
        <div class="cf-hero-inner cf-hero-center">
          <h1 id="hero-title" class="cf-hero-title cf-project-title">{project.name}</h1>
          <ProjectLede user={user} project={project} hasPublicSkills={props.hasPublicSkills} />
          {base ? <CodeBlock raised>npx skills add {base}</CodeBlock> : null}
          <SearchForm action={path} q={props.q} />
        </div>
      </section>

      <SkillRegistry
        skills={props.skills}
        q={props.q}
        clearHref={path}
        showDownloads={user !== null}
        empty={<EmptyProject project={project} q={props.q} canPublish={user !== null && canPublishIn(user, project.slug)} />}
      />
    </Layout>
  );
}

export function ProjectSettingsPage(props: {
  user: Viewer;
  project: ProjectRow;
  origin: string;
  hasSkills: boolean;
  members: Member[];
  candidates: Array<Pick<UserRow, "id" | "username">>;
  canManage: boolean;
  error?: string;
}) {
  const t = useT();
  const { project } = props;
  const path = projectPath(project.slug);
  const membership = membershipIn(props.user, project.slug);
  const title = t.projects.settingsTitle(project.name);
  return (
    <Layout title={title} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={title} error={props.error}>
          {t.projects.settingsLede(<a href={path} class="cf-link">{t.projects.itsPage}</a>)}
        </PageHead>
        <div class="cf-stack-lg">
          <Panel title={t.projects.installPanel}>
            {membership ? (
              <>
                <CodeBlock>npx skills add {`${props.origin}${installKeyPath(membership.install_key)}`}</CodeBlock>
                <p class="cf-hint">{t.projects.installHint(project.name)}</p>
                <Form action={`${path}/install-key`} class="cf-actions">
                  <Button variant="outline">{t.projects.resetKey}</Button>
                </Form>
              </>
            ) : (
              <p class="cf-hint">{t.projects.notMemberHint(project.name)}</p>
            )}
          </Panel>

          <Panel title={t.projects.members} aside={<span class="cf-count">{props.members.length}</span>} flush>
            {props.members.length === 0 ? (
              <div class="cf-panel-body">
                <p class="cf-hint">{t.projects.noMembers}</p>
              </div>
            ) : (
              <ul class="cf-rows">
                {props.members.map((m) => (
                  <li class="cf-row cf-member">
                    <span class="cf-row-main cf-user">
                      <span class="cf-user-name">{m.username}</span>
                      {m.user_id === props.user.id ? <span class="cf-tag">{t.common.you}</span> : null}
                      {m.role === "member" && m.account_role === "member" && m.can_publish === 0 ? (
                        <span class="cf-tag">{t.projects.cannotPublish}</span>
                      ) : null}
                    </span>
                    <RoleLabel role={m.role} />
                    {props.canManage ? (
                      <div class="cf-actions">
                        {m.role === "member" ? (
                          <Form action={`${path}/members/${m.user_id}/publish`}>
                            <input type="hidden" name="publish" value={m.can_publish === 1 ? "0" : "1"} />
                            <Button variant="outline" size="sm">
                              {m.can_publish === 1 ? t.projects.blockPublishing : t.projects.allowPublishing}
                            </Button>
                          </Form>
                        ) : null}
                        <Form action={`${path}/members/${m.user_id}/role`}>
                          <input type="hidden" name="role" value={m.role === "admin" ? "member" : "admin"} />
                          <Button variant="outline" size="sm">
                            {m.role === "admin" ? t.projects.makeMember : t.projects.makeAdmin}
                          </Button>
                        </Form>
                        <ConfirmDelete
                          action={`${path}/members/${m.user_id}/remove`}
                          label={t.projects.remove}
                          confirm={t.projects.removeUser(m.username)}
                          size="sm"
                          name="remove-member"
                        >
                          {t.projects.removeWarning(m.username, project.name)}
                        </ConfirmDelete>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {props.canManage && props.candidates.length > 0 ? (
            <Panel title={t.projects.addMember}>
              <Form action={`${path}/members`} class="cf-stack cf-stack-form">
                <Select label={t.projects.account} name="user">
                  {props.candidates.map((u) => (
                    <option value={u.id}>{u.username}</option>
                  ))}
                </Select>
                <Select label={t.projects.roleInProject} name="role">
                  <option value="member">{t.common.roles.member}</option>
                  <option value="admin">{t.common.roles.admin}</option>
                </Select>
                <p class="cf-hint">{t.projects.addMemberHint}</p>
                <div>
                  <Button>{t.projects.add}</Button>
                </div>
              </Form>
            </Panel>
          ) : null}

          {props.canManage ? (
            <Panel title={t.projects.renamePanel}>
              <Form action={`${path}/rename`} class="cf-stack cf-stack-form">
                <Field
                  label={t.projects.name}
                  name="name"
                  value={project.name}
                  autocomplete="off"
                  hint={t.projects.renameHint(path)}
                />
                <div>
                  <Button>{t.common.save}</Button>
                </div>
              </Form>
            </Panel>
          ) : null}

          {props.user.role === "admin" ? (
            <Panel title={t.projects.deletePanel}>
              {props.hasSkills ? (
                <p class="cf-hint">{t.projects.hasSkills}</p>
              ) : (
                <div class="cf-actions">
                  <ConfirmDelete
                    action={`${path}/delete`}
                    label={t.projects.deleteProject}
                    confirm={t.projects.deleteNamed(project.name)}
                    name="delete-project"
                  >
                    {t.projects.deleteWarning(project.name)}
                  </ConfirmDelete>
                </div>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
