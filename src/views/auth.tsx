import { Form } from "../csrf";
import { Alert, Button, CodeBlock, DATE, Field, Icon, Layout, PageHead, Panel, Select } from "./layout";
import type { UserRow } from "../db/queries";

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

function RoleLabel(props: { role: UserRow["role"] }) {
  return <span class={props.role === "admin" ? "cf-vis cf-vis-public" : "cf-vis cf-vis-private"}>{props.role}</span>;
}

export function MePage(props: { user: UserRow; origin: string; newToken?: string; error?: string }) {
  const installUrl = `${props.origin}/i/${props.user.install_key}`;
  return (
    <Layout title="Account" user={props.user}>
      <div class="cf-narrow">
        <PageHead
          title="Account"
          aside={
            <span class="cf-head-aside">
              <span class="cf-chip">{props.user.username}</span>
              <RoleLabel role={props.user.role} />
            </span>
          }
        />
        <Alert message={props.error} />

        <div class="cf-stack-lg">
          <Panel title="Install every skill">
            <CodeBlock>npx skills add {installUrl}</CodeBlock>
            <p class="cf-hint">
              This key can only install. It cannot sign in, publish or delete. Reset it below if you think it has leaked.
            </p>
            <Form action="/me/install-key" class="cf-actions">
              <Button variant="outline">Reset install key</Button>
            </Form>
          </Panel>

          <Panel title="API token (for publishing with curl)">
            {props.newToken ? (
              <>
                <CodeBlock prompt={false}>{props.newToken}</CodeBlock>
                <p class="cf-notice">
                  <Icon>
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 5v3.5M8 11h.01" />
                  </Icon>
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
      <PageHead title="Users" compact aside={<span class="cf-count">{props.users.length}</span>} />
      <Alert message={props.error} />
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
                  <td data-label="Actions">
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
                          <Button variant="outline" size="sm">Rotate install key</Button>
                        </Form>
                        {u.api_token_hash ? (
                          <Form action={`/admin/users/${u.id}/api-token/revoke`}>
                            <Button variant="outline" size="sm">Revoke API token</Button>
                          </Form>
                        ) : null}
                      </div>
                      <Form action={`/admin/users/${u.id}/password`} class="cf-inline-form">
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
                          <Form action={`/admin/users/${u.id}/delete`}>
                            <Button variant="danger" size="sm">Delete account</Button>
                          </Form>
                          <p class="cf-hint">
                            Deleting reassigns this user's skills and their published versions' author records to you.
                            To keep the author records, use "Demote to member" plus "Rotate install key" instead of
                            deleting.
                          </p>
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

      <div class="cf-narrow cf-after-table">
        <Panel title="Add a user">
          <Form action="/admin/users" class="cf-stack cf-stack-form">
            <Field label="Username" name="username" autocomplete="off" />
            <Field
              label="Initial password"
              name="password"
              type="password"
              autocomplete="new-password"
              hint="At least 12 characters"
            />
            <Select label="Role" name="role">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </Select>
            <div>
              <Button>Create</Button>
            </div>
          </Form>
        </Panel>
      </div>
    </Layout>
  );
}
