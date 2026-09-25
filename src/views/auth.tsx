import { Form } from "../csrf";
import { Alert, AlertIcon, Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";
import type { UserRow, Viewer } from "../db/queries";

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

export function MePage(props: { user: Viewer; origin: string; newToken?: string; error?: string }) {
  return (
    <Layout title="Account" user={props.user}>
      <div class="cf-narrow">
        <PageHead title="Account" error={props.error} />

        <div class="cf-stack-lg">
          <Panel title="Install keys">
            {props.user.memberships.length === 0 ? (
              <p class="cf-hint">You are not in a project yet, so you have no install keys. Ask an admin to add you to one.</p>
            ) : (
              <>
                {props.user.memberships.map((m) => (
                  <div class="cf-key">
                    <p class="cf-key-project">{m.project_name}</p>
                    <CodeBlock>npx skills add {`${props.origin}/i/${m.install_key}`}</CodeBlock>
                    <Form action={`/me/install-key/${m.project}`} class="cf-actions">
                      <Button variant="outline">Reset install key<span class="sr-only"> for {m.project_name}</span></Button>
                    </Form>
                  </div>
                ))}
                <p class="cf-hint">
                  Each key installs one project's skills and can do nothing else: it cannot sign in, publish or delete.
                  Reset a key if you think it has leaked.
                </p>
              </>
            )}
          </Panel>

          <Panel title="API token (for publishing with curl)">
            {props.newToken ? (
              <>
                <CodeBlock prompt={false}>{props.newToken}</CodeBlock>
                <p class="cf-notice">
                  <AlertIcon />
                  This token is shown once. Save it now.
                </p>
              </>
            ) : (
              <p class="cf-status">
                Status:{" "}
                <span class={props.user.api_token_hash ? "cf-status-value cf-status-on" : "cf-status-value"}>
                  {props.user.api_token_hash ? "active" : "not generated"}
                </span>
              </p>
            )}
            <div class="cf-actions">
              <Form action="/me/api-token">
                <Button variant="outline">Generate a new token</Button>
              </Form>
              {props.user.api_token_hash ? (
                <Form action="/me/api-token/revoke">
                  <Button variant="danger">Revoke</Button>
                </Form>
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

export function UsersPage(props: { user: UserRow; users: UserRow[]; error?: string }) {
  return (
    <Layout title="Users" user={props.user}>
      <PageHead
        title="Users"
        compact
        error={props.error}
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
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.users.map((u) => {
              const isSelf = u.id === props.user.id;
              return (
                <tr>
                  <td data-label="Username">
                    <span class="cf-user">
                      <span class="cf-user-name">{u.username}</span>
                      {isSelf ? <span class="cf-tag">You</span> : null}
                    </span>
                  </td>
                  <td data-label="Role">
                    <RoleLabel role={u.role} />
                  </td>
                  <td data-label="Last sign-in" class="cf-table-date">
                    {u.last_login_at ? DATE.format(new Date(u.last_login_at)) : "—"}
                  </td>
                  <td data-label="Actions" class="cf-table-actions">
                    <div class="cf-user-actions">
                      <div class="cf-actions">
                        {isSelf ? null : (
                          <Form action={`/admin/users/${u.id}/role`}>
                            <input type="hidden" name="role" value={u.role === "admin" ? "member" : "admin"} />
                            <Button variant="outline" size="sm">
                              {u.role === "admin" ? "Demote to member" : "Promote to admin"}
                            </Button>
                          </Form>
                        )}
                        <Form action={`/admin/users/${u.id}/install-key`}>
                          <Button variant="outline" size="sm">Rotate install keys</Button>
                        </Form>
                        {u.api_token_hash ? (
                          <Form action={`/admin/users/${u.id}/api-token/revoke`}>
                            <Button variant="outline" size="sm">Revoke API token</Button>
                          </Form>
                        ) : null}
                      </div>
                      <Form action={`/admin/users/${u.id}/password`} class="cf-actions">
                        <label class="sr-only" for={`pw-${u.id}`}>New password for {u.username}</label>
                        <input
                          id={`pw-${u.id}`}
                          type="password"
                          name="password"
                          placeholder="New password (at least 12 characters)"
                          autocomplete="new-password"
                          class="cf-input cf-input-sm"
                          required
                        />
                        <Button variant="outline" size="sm">Reset password</Button>
                      </Form>
                      {isSelf ? null : (
                        <div class="cf-danger-zone">
                          <ConfirmDelete
                            action={`/admin/users/${u.id}/delete`}
                            label="Delete account"
                            confirm={`Delete ${u.username}`}
                            size="sm"
                            name="delete-user"
                          >
                            Deleting reassigns this user's skills and their published versions' author records to you.
                            To keep the author records, use "Demote to member" plus "Rotate install keys" instead of
                            deleting.
                          </ConfirmDelete>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
