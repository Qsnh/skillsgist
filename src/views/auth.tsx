import { Form } from "../csrf";
import { userSettingsPath } from "../paths";
import { Alert, AlertIcon, Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";
import type { UserRow, UserSummary, Viewer } from "../db/queries";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function AuthCard(props: { title: string; error?: string; children?: unknown }) {
  return (
    <div class="cf-auth">
      <div class="cf-frame cf-auth-card">
        <h1 class="cf-auth-title">{props.title}</h1>
        <Alert message={props.error} />
        {props.children}
      </div>
    </div>
  );
}

export function SetupPage(props: { error?: string }) {
  return (
    <Layout title="Setup" user={null} hideSignIn>
      <AuthCard title="Create the first admin" error={props.error}>
        <form method="post" action="/setup" class="cf-stack">
          <Field
            label="Username"
            name="username"
            autocomplete="username"
            hint="Lowercase letters, digits and hyphens, 2-32 characters"
          />
          <Field label="Password" name="password" type="password" autocomplete="new-password" hint="At least 12 characters" />
          <Button wide>Create</Button>
        </form>
      </AuthCard>
    </Layout>
  );
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in" user={null} hideSignIn>
      <AuthCard title="Sign in" error={props.error}>
        <form method="post" action="/login" class="cf-stack">
          <Field label="Username" name="username" autocomplete="username" />
          <Field label="Password" name="password" type="password" autocomplete="current-password" />
          <Button wide>Sign in</Button>
        </form>
      </AuthCard>
    </Layout>
  );
}

export function RoleLabel(props: { role: UserRow["role"] }) {
  return <span class={props.role === "admin" ? "cf-vis cf-vis-public" : "cf-vis cf-vis-private"}>{props.role}</span>;
}

function ShownOnceToken(props: { token: string }) {
  return (
    <>
      <CodeBlock prompt={false}>{props.token}</CodeBlock>
      <p class="cf-notice">
        <AlertIcon />
        This token is shown once. Save it now.
      </p>
    </>
  );
}

function TokenStatus(props: { active: boolean }) {
  return (
    <p class="cf-status">
      Status:{" "}
      <span class={props.active ? "cf-status-value cf-status-on" : "cf-status-value"}>
        {props.active ? "active" : "not generated"}
      </span>
    </p>
  );
}

export function MePage(props: { user: Viewer; newToken?: string; error?: string }) {
  return (
    <Layout title="Account" user={props.user}>
      <div class="cf-narrow">
        <PageHead title="Account" error={props.error} />

        <div class="cf-stack-lg">
          <Panel title="API token (for publishing with curl)">
            {props.newToken ? (
              <ShownOnceToken token={props.newToken} />
            ) : (
              <TokenStatus active={props.user.api_token_hash !== null} />
            )}
            <div class="cf-actions">
              <Form action="/me/api-token">
                <Button variant="outline">Generate a new token</Button>
              </Form>
              {props.user.api_token_hash ? (
                <ConfirmDelete
                  action="/me/api-token/revoke"
                  label="Revoke"
                  confirm="Revoke API token"
                  name="revoke-api-token"
                >
                  Revoking stops your current token from working at once, so publishing with it fails until you
                  generate a new one.
                </ConfirmDelete>
              ) : null}
            </div>
          </Panel>

          <Panel title="Change password">
            <Form action="/me/password" class="cf-stack cf-stack-form">
              <Field label="Current password" name="current" type="password" autocomplete="current-password" />
              <Field
                label="New password"
                name="next"
                type="password"
                autocomplete="new-password"
                hint="At least 12 characters"
              />
              <div>
                <Button>Save</Button>
              </div>
            </Form>
          </Panel>
        </div>
      </div>
    </Layout>
  );
}

export function UsersPage(props: { user: UserRow; users: UserSummary[] }) {
  return (
    <Layout title="Users" user={props.user}>
      <PageHead
        title="Users"
        compact
        aside={
          <>
            <span class="cf-count">{props.users.length}</span>
            <a href="/admin/users/new" class="cf-btn cf-btn-outline cf-head-action">Add a user</a>
          </>
        }
      />
      <div class="cf-frame cf-table-frame">
        <table class="cf-table">
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Projects</th>
              <th scope="col">Skills</th>
              <th scope="col">Joined</th>
              <th scope="col">Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {props.users.map((u) => (
              <tr>
                <td data-label="Username">
                  <span class="cf-user">
                    <a href={userSettingsPath(u.id)} class="cf-link cf-user-name">{u.username}</a>
                    {u.id === props.user.id ? <span class="cf-tag">You</span> : null}
                  </span>
                </td>
                <td data-label="Role">
                  <RoleLabel role={u.role} />
                </td>
                <td data-label="Projects" class="cf-table-date">{u.projects}</td>
                <td data-label="Skills" class="cf-table-date">{u.skills}</td>
                <td data-label="Joined" class="cf-table-date">{DATE.format(new Date(u.created_at))}</td>
                <td data-label="Last sign-in" class="cf-table-date">
                  {u.last_login_at ? DATE.format(new Date(u.last_login_at)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function UserSettingsPage(props: { user: UserRow; target: UserSummary; error?: string; newToken?: string }) {
  const { target } = props;
  const isSelf = target.id === props.user.id;
  const path = userSettingsPath(target.id);
  const projects = `${target.projects} ${target.projects === 1 ? "project" : "projects"}`;
  return (
    <Layout title={`${target.username} settings`} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={`${target.username} settings`} error={props.error}>
          Joined {DATE.format(new Date(target.created_at))},{" "}
          {target.last_login_at ? `last signed in ${DATE.format(new Date(target.last_login_at))}` : "never signed in"}.
        </PageHead>
        <div class="cf-stack-lg">
          <Panel title="Role">
            <p class="cf-status">
              Role:{" "}
              <RoleLabel role={target.role} />
            </p>
            {isSelf ? (
              <p class="cf-hint">Only another admin can change your role.</p>
            ) : (
              <Form action={`${path}/role`} class="cf-actions">
                <input type="hidden" name="role" value={target.role === "admin" ? "member" : "admin"} />
                <Button variant="outline">{target.role === "admin" ? "Demote to member" : "Promote to admin"}</Button>
              </Form>
            )}
          </Panel>

          <Panel title="Install keys">
            {target.projects === 0 ? (
              <p class="cf-hint">{target.username} is in no project, so they have no install keys.</p>
            ) : (
              <>
                <p class="cf-hint">
                  {target.username} has one install key per project and is in {projects}. Rotating replaces all of them
                  at once, and the old install commands stop working.
                </p>
                <Form action={`${path}/install-key`} class="cf-actions">
                  <Button variant="outline">Rotate install keys</Button>
                </Form>
              </>
            )}
          </Panel>

          <Panel title="API token">
            {props.newToken ? (
              <ShownOnceToken token={props.newToken} />
            ) : (
              <>
                <TokenStatus active={target.api_token_hash !== null} />
                <p class="cf-hint">
                  {target.api_token_hash
                    ? `Generating a token replaces ${isSelf ? "your" : `${target.username}'s`} current one at once. `
                    : null}
                  The new token is shown only once, on this page.
                </p>
              </>
            )}
            <div class="cf-actions">
              <Form action={`${path}/api-token`}>
                <Button variant="outline">Generate a new token</Button>
              </Form>
              {target.api_token_hash ? (
                <ConfirmDelete
                  action={`${path}/api-token/revoke`}
                  label="Revoke API token"
                  confirm={isSelf ? "Revoke your token" : `Revoke ${target.username}'s token`}
                  name="revoke-api-token"
                >
                  {`Revoking stops ${isSelf ? "your" : `${target.username}'s`} current token from working at once, so publishing with it fails until a new one is generated.`}
                </ConfirmDelete>
              ) : null}
            </div>
          </Panel>

          <Panel title="Reset password">
            <Form action={`${path}/password`} class="cf-stack cf-stack-form">
              <Field
                label="New password"
                name="password"
                type="password"
                autocomplete="new-password"
                hint="At least 12 characters"
              />
              <div>
                <Button>Reset password</Button>
              </div>
            </Form>
          </Panel>

          {isSelf ? null : (
            <Panel title="Delete this account">
              <div class="cf-actions">
                <ConfirmDelete
                  action={`${path}/delete`}
                  label="Delete account"
                  confirm={`Delete ${target.username}`}
                  name="delete-user"
                >
                  Deleting reassigns this user's skills and their published versions' author records to you. To keep
                  the author records, remove this user from their projects and reset their password instead of
                  deleting.
                </ConfirmDelete>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </Layout>
  );
}

export function NewUserPage(props: {
  user: UserRow;
  error?: string;
  username?: string;
  role?: UserRow["role"];
}) {
  return (
    <Layout title="Add a user" user={props.user}>
      <div class="cf-narrow">
        <PageHead title="Add a user" error={props.error} />
        <Form action="/admin/users/new" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field
                label="Username"
                name="username"
                value={props.username}
                autocomplete="off"
                hint="Lowercase letters, digits and hyphens, 2-32 characters"
              />
              <Field
                label="Initial password"
                name="password"
                type="password"
                autocomplete="new-password"
                hint="At least 12 characters"
              />
              <Select label="Role" name="role">
                <option value="member">member</option>
                <option value="admin" selected={props.role === "admin"}>admin</option>
              </Select>
              <p class="cf-hint">
                New accounts start in no project. Add them to a project from its settings page to give them access to
                its private skills.
              </p>
            </div>
          </div>
          <div class="cf-form-foot">
            <Button>Create</Button>
            <a href="/admin/users" class="cf-btn cf-btn-outline">Cancel</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}
