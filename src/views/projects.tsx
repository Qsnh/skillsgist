import { membershipIn } from "../auth";
import { Form } from "../csrf";
import { DEFAULT_PROJECT } from "../db/queries";
import type { ListedSkill, Member, ProjectRow, ProjectSummary, UserRow, Viewer } from "../db/queries";
import { projectSettingsPath } from "../paths";
import { RoleLabel } from "./auth";
import { Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";
import { SearchForm, SkillRegistry } from "./skills";

export function ProjectsPage(props: { user: Viewer; projects: ProjectSummary[] }) {
  const admin = props.user.role === "admin";
  return (
    <Layout title="Projects" user={props.user}>
      <PageHead
        title="Projects"
        compact
        aside={
          <>
            <span class="cf-count">{props.projects.length}</span>
            {admin ? <a href="/projects/new" class="cf-btn cf-btn-outline cf-head-action">New project</a> : null}
          </>
        }
      />
      {props.projects.length === 0 ? (
        <div class="cf-frame">
          <div class="cf-empty">
            <p class="cf-empty-title">{admin ? "No projects yet." : "You are not in a project yet."}</p>
            <p class="cf-empty-body">
              {admin
                ? "Every skill belongs to a project. Create one, then add people to it."
                : "Ask an admin to add you to one. Until then you can see and install public skills only."}
            </p>
          </div>
        </div>
      ) : (
        <div class="cf-frame cf-table-frame">
          <table class="cf-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Address</th>
                <th scope="col">Your role</th>
                <th scope="col">Skills</th>
                <th scope="col">Members</th>
              </tr>
            </thead>
            <tbody>
              {props.projects.map((p) => (
                <tr>
                  <td data-label="Name">
                    <a href={`/p/${p.slug}`} class="cf-link cf-user-name">{p.name}</a>
                  </td>
                  <td data-label="Address" class="cf-table-date">/p/{p.slug}</td>
                  <td data-label="Your role">{p.role ? <RoleLabel role={p.role} /> : "—"}</td>
                  <td data-label="Skills" class="cf-table-date">{p.skills}</td>
                  <td data-label="Members" class="cf-table-date">{p.members}</td>
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
  return (
    <Layout title="New project" user={props.user}>
      <div class="cf-narrow">
        <PageHead title="New project" error={props.error} />
        <Form action="/projects/new" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field
                label="Name"
                name="name"
                value={props.name}
                autocomplete="off"
                hint="Shown on every page. Up to 64 characters, and you can change it later."
              />
              <Field
                label="Address"
                name="slug"
                value={props.slug}
                autocomplete="off"
                hint="Used in page, install and API addresses. Lowercase letters, digits and hyphens, 2-32 characters. It cannot be changed later."
              />
            </div>
          </div>
          <div class="cf-form-foot">
            <Button>Create</Button>
            <a href="/projects" class="cf-btn cf-btn-outline">Cancel</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

function ProjectLede(props: { user: Viewer | null; project: ProjectRow; hasPublicSkills: boolean }) {
  const { user, project } = props;
  const settings = <a href={projectSettingsPath(project.slug)}>Settings</a>;
  if (user && membershipIn(user, project.slug)) {
    return (
      <p class="cf-hero-lede">
        This command carries your install key for {project.name}, so it installs every skill in it, private ones
        included. Reset the key and see who is in the project under {settings}.
      </p>
    );
  }
  if (user?.role === "admin") {
    return (
      <p class="cf-hero-lede">
        You are not a member of {project.name}, so you have no install key for it.
        {props.hasPublicSkills ? " The address below installs its public skills." : null} Add yourself under{" "}
        {settings}.
      </p>
    );
  }
  return (
    <p class="cf-hero-lede">
      Anyone can install the public skills of {project.name} with the address below.
      {user ? null : (
        <>
          {" "}
          <a href="/login">Sign in</a> to see its private ones if you are a member.
        </>
      )}
    </p>
  );
}

function EmptyProject(props: { project: ProjectRow; q: string }) {
  const path = `/p/${props.project.slug}`;
  if (props.q) {
    return (
      <div class="cf-empty">
        <p class="cf-empty-title">
          No skills in {props.project.name} match &ldquo;{props.q}&rdquo;.
        </p>
        <p class="cf-empty-body">Search looks at skill names, descriptions and the text of each SKILL.md.</p>
        <a href={path} class="cf-btn cf-btn-outline">Clear search</a>
      </div>
    );
  }
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">No skills in {props.project.name} yet.</p>
      <p class="cf-empty-body">
        Upload a .zip, a .tar.gz or a single SKILL.md from the browser, or send an archive to the API with a token
        from your account.
      </p>
      <a href={`/new?project=${props.project.slug}`} class="cf-btn cf-btn-primary">Publish the first skill</a>
    </div>
  );
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
  const path = `/p/${project.slug}`;
  const membership = user ? membershipIn(user, project.slug) : undefined;
  const base = membership
    ? `${props.origin}/i/${membership.install_key}`
    : props.hasPublicSkills
      ? `${props.origin}${path}`
      : null;
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
        showProject={false}
        empty={<EmptyProject project={project} q={props.q} />}
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
  const { project } = props;
  const membership = membershipIn(props.user, project.slug);
  return (
    <Layout title={`${project.name} settings`} user={props.user}>
      <div class="cf-narrow">
        <PageHead
          title={`${project.name} settings`}
          error={props.error}
          aside={membership ? <RoleLabel role={membership.role} /> : null}
        >
          The skills in this project are listed on <a href={`/p/${project.slug}`} class="cf-link">its page</a>.
        </PageHead>
        <div class="cf-stack-lg">
          <Panel title="Install this project's skills">
            {membership ? (
              <>
                <CodeBlock>npx skills add {`${props.origin}/i/${membership.install_key}`}</CodeBlock>
                <p class="cf-hint">
                  This key installs only {project.name}'s skills and can do nothing else: it cannot sign in, publish or
                  delete. Reset it if you think it has leaked; the old command stops working at once.
                </p>
                <Form action={`/p/${project.slug}/install-key`} class="cf-actions">
                  <Button variant="outline">Reset install key</Button>
                </Form>
              </>
            ) : (
              <p class="cf-hint">
                You are not a member of {project.name}, so you have no install key for it. Add yourself below to get
                one.
              </p>
            )}
          </Panel>

          <Panel title="Members" aside={<span class="cf-count">{props.members.length}</span>} flush>
            {props.members.length === 0 ? (
              <div class="cf-panel-body">
                <p class="cf-hint">No members yet.</p>
              </div>
            ) : (
              <ul class="cf-rows">
                {props.members.map((m) => (
                  <li class="cf-row cf-member">
                    <span class="cf-row-main cf-user">
                      <span class="cf-user-name">{m.username}</span>
                      {m.user_id === props.user.id ? <span class="cf-tag">You</span> : null}
                    </span>
                    <RoleLabel role={m.role} />
                    {props.canManage ? (
                      <div class="cf-actions">
                        <Form action={`/p/${project.slug}/members/${m.user_id}/role`}>
                          <input type="hidden" name="role" value={m.role === "admin" ? "member" : "admin"} />
                          <Button variant="outline" size="sm">{m.role === "admin" ? "Make member" : "Make admin"}</Button>
                        </Form>
                        <ConfirmDelete
                          action={`/p/${project.slug}/members/${m.user_id}/remove`}
                          label="Remove"
                          confirm={`Remove ${m.username}`}
                          size="sm"
                          name="remove-member"
                        >
                          {m.username} loses access to {project.name}'s private skills, and their install key for it
                          stops working at once.
                        </ConfirmDelete>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {props.canManage && props.candidates.length > 0 ? (
            <Panel title="Add a member">
              <Form action={`/p/${project.slug}/members`} class="cf-stack cf-stack-form">
                <Select label="Account" name="user">
                  {props.candidates.map((u) => (
                    <option value={u.id}>{u.username}</option>
                  ))}
                </Select>
                <Select label="Role in this project" name="role">
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </Select>
                <div>
                  <Button>Add</Button>
                </div>
              </Form>
            </Panel>
          ) : null}

          {props.canManage ? (
            <Panel title="Rename this project">
              <Form action={`/p/${project.slug}/rename`} class="cf-stack cf-stack-form">
                <Field
                  label="Name"
                  name="name"
                  value={project.name}
                  autocomplete="off"
                  hint={`Up to 64 characters. The address, /p/${project.slug}, stays the same.`}
                />
                <div>
                  <Button>Save</Button>
                </div>
              </Form>
            </Panel>
          ) : null}

          {props.user.role === "admin" ? (
            <Panel title="Delete this project">
              {props.hasSkills ? (
                <p class="cf-hint">A project that still has skills cannot be deleted. Move or delete its skills first.</p>
              ) : (
                <ConfirmDelete
                  action={`/p/${project.slug}/delete`}
                  label="Delete project"
                  confirm={`Delete ${project.name}`}
                  name="delete-project"
                >
                  Deleting removes {project.name} and every membership in it. Its members' install keys for it stop
                  working at once.
                  {project.slug === DEFAULT_PROJECT
                    ? " The old PUT /api/skills/<name> address and /s/<name> links publish into and point at this project, and stop working once it is deleted."
                    : null}
                </ConfirmDelete>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
