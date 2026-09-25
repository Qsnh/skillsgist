import { membershipIn } from "../auth";
import { Form } from "../csrf";
import type { Member, ProjectRow, ProjectSummary, SkillRow, UserRow, Viewer } from "../db/queries";
import { skillPath } from "../paths";
import { RoleLabel } from "./auth";
import { Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";

type ProjectSkill = Pick<SkillRow, "slug" | "visibility">;

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

function SkillRows(props: { skills: ProjectSkill[]; project: ProjectRow; empty: string }) {
  if (props.skills.length === 0) {
    return (
      <div class="cf-panel-body">
        <p class="cf-hint">{props.empty}</p>
      </div>
    );
  }
  return (
    <ul class="cf-rows">
      {props.skills.map((s) => (
        <li class="cf-row">
          <a href={skillPath({ project: props.project.slug, slug: s.slug })} class="cf-row-main cf-row-version">
            {s.slug}
          </a>
          <span class="cf-row-meta">{s.visibility}</span>
        </li>
      ))}
    </ul>
  );
}

export function PublicProjectPage(props: {
  user: Viewer | null;
  project: ProjectRow;
  origin: string;
  skills: ProjectSkill[];
}) {
  return (
    <Layout title={props.project.name} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={props.project.name} />
        <div class="cf-stack-lg">
          <Panel title="Install this project's public skills">
            <CodeBlock>npx skills add {`${props.origin}/p/${props.project.slug}`}</CodeBlock>
            <p class="cf-hint">Anyone can use this address. It installs only the public skills listed below.</p>
          </Panel>
          <Panel title="Public skills" aside={<span class="cf-count">{props.skills.length}</span>} flush>
            <SkillRows skills={props.skills} project={props.project} empty="" />
          </Panel>
        </div>
      </div>
    </Layout>
  );
}

export function ProjectPage(props: {
  user: Viewer;
  project: ProjectRow;
  origin: string;
  skills: ProjectSkill[];
  members: Member[];
  candidates: Array<Pick<UserRow, "id" | "username">>;
  canManage: boolean;
  error?: string;
}) {
  const { project } = props;
  const membership = membershipIn(props.user, project.slug);
  return (
    <Layout title={project.name} user={props.user}>
      <div class="cf-narrow">
        <PageHead
          title={project.name}
          error={props.error}
          aside={membership ? <RoleLabel role={membership.role} /> : null}
        />
        <div class="cf-stack-lg">
          <Panel title="Install this project's skills">
            {membership ? (
              <>
                <CodeBlock>npx skills add {`${props.origin}/i/${membership.install_key}`}</CodeBlock>
                <p class="cf-hint">
                  This key installs only {project.name}'s skills and can do nothing else. Reset it from{" "}
                  <a href="/me" class="cf-link">your account</a> if it leaks.
                </p>
              </>
            ) : (
              <p class="cf-hint">
                You are not a member of {project.name}, so you have no install key for it. Add yourself below to get
                one.
              </p>
            )}
          </Panel>

          <Panel title="Skills" aside={<span class="cf-count">{props.skills.length}</span>} flush>
            <SkillRows skills={props.skills} project={project} empty={`No skills in ${project.name} yet.`} />
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
              {props.skills.length === 0 ? (
                <ConfirmDelete
                  action={`/p/${project.slug}/delete`}
                  label="Delete project"
                  confirm={`Delete ${project.name}`}
                  name="delete-project"
                >
                  Deleting removes {project.name} and every membership in it. Its members' install keys for it stop
                  working at once.
                </ConfirmDelete>
              ) : (
                <p class="cf-hint">A project that still has skills cannot be deleted. Move or delete its skills first.</p>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
