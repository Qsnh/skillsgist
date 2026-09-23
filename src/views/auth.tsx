import { Form } from "../csrf";
import { Alert, Button, CodeBlock, Field, Layout, PageHead } from "./layout";
import type { UserRow } from "../db/queries";

const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

export function SetupPage(props: { error?: string }) {
  return (
    <Layout title="Setup" user={null}>
      <PageHead title="Create the first admin" aside="This page closes once an account exists" />
      <Alert message={props.error} />
      <section class="band">
        <form method="post" action="/setup" class="form">
          <Field label="Username" name="username" hint="Lowercase letters, digits and hyphens, 2-32 characters" />
          <Field label="Password" name="password" type="password" hint="At least 12 characters" />
          <Button>Create</Button>
        </form>
      </section>
    </Layout>
  );
}

export function LoginPage(props: { error?: string; username?: string }) {
  return (
    <Layout title="Sign in" user={null}>
      <PageHead title="Sign in" />
      <Alert message={props.error} />
      <section class="band">
        <form method="post" action="/login" class="form">
          <Field label="Username" name="username" value={props.username} />
          <Field label="Password" name="password" type="password" />
          <Button>Sign in</Button>
        </form>
      </section>
    </Layout>
  );
}

export function MePage(props: { user: UserRow; origin: string; newToken?: string; error?: string }) {
  const installUrl = `${props.origin}/i/${props.user.install_key}`;
  return (
    <Layout title="Account" user={props.user}>
      <PageHead title="Account" aside={props.user.role} />
      <Alert message={props.error} />

      <section class="band band--bleed">
        <div class="band__head">
          <span class="legend">Install key · installs every skill you can see</span>
          <span class="legend">Selects as one line</span>
        </div>
        <CodeBlock>npx skills add {installUrl}</CodeBlock>
        <p class="band__note">
          This key can only install. It cannot sign in, publish or delete. Reset it below if you think
          it has leaked.
        </p>
      </section>

      <div class="cells">
        <Form action="/me/install-key">
          <button type="submit" class="field-cell"><span class="legend">Reset install key</span></button>
        </Form>
      </div>

      <section class="band band--bleed">
        <div class="band__head">
          <span class="legend">API token · for publishing with curl</span>
          <span class="legend">{props.user.api_token_hash ? "active" : "not generated"}</span>
        </div>
        {props.newToken ? (
          <>
            <CodeBlock>{props.newToken}</CodeBlock>
            <p class="band__note band__note--now">This token is shown once. Save it now.</p>
          </>
        ) : (
          <p class="band__note">
            Tokens travel in an Authorization header, never in a URL, and the token itself is never
            shown again after it is generated.
          </p>
        )}
      </section>

      <div class="cells">
        <Form action="/me/api-token">
          <button type="submit" class="field-cell"><span class="legend">Generate a new token</span></button>
        </Form>
        {props.user.api_token_hash ? (
          <Form action="/me/api-token/revoke">
            <button type="submit" class="field-cell"><span class="legend">Revoke</span></button>
          </Form>
        ) : null}
      </div>

      <section class="band">
        <div class="band__head">
          <span class="legend">Change password</span>
        </div>
        <Form action="/me/password" class="form">
          <Field label="Current password" name="current" type="password" />
          <Field label="New password" name="next" type="password" hint="At least 12 characters" />
          <Button>Save</Button>
        </Form>
      </section>
    </Layout>
  );
}

function Account(props: { user: UserRow; isSelf: boolean }) {
  const u = props.user;
  return (
    <section class="band band--bleed account">
      <div class="entry">
        <h2 class="entry__heading account__name">{u.username}</h2>
        <div class="entry__rail">
          <span class="legend account__role">{u.role}</span>
          <dl class="entry__fields">
            <dt class="legend">Last sign-in</dt>
            <dd>{day(u.last_login_at)}</dd>
            <dt class="legend">API token</dt>
            <dd>{u.api_token_hash ? "active" : "none"}</dd>
            {props.isSelf ? (
              <>
                <dt class="legend">Account</dt>
                <dd>you</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>

      <div class="cells">
        {props.isSelf ? null : (
          <Form action={`/admin/users/${u.id}/role`}>
            <input type="hidden" name="role" value={u.role === "admin" ? "member" : "admin"} />
            <button type="submit" class="field-cell">
              <span class="legend">{u.role === "admin" ? "Demote to member" : "Promote to admin"}</span>
            </button>
          </Form>
        )}
        <Form action={`/admin/users/${u.id}/install-key`}>
          <button type="submit" class="field-cell"><span class="legend">Rotate install key</span></button>
        </Form>
        {u.api_token_hash ? (
          <Form action={`/admin/users/${u.id}/api-token/revoke`}>
            <button type="submit" class="field-cell"><span class="legend">Revoke API token</span></button>
          </Form>
        ) : null}
        {props.isSelf ? null : (
          <Form action={`/admin/users/${u.id}/delete`}>
            <button type="submit" class="field-cell field-cell--danger">
              <span class="legend">Delete account</span>
            </button>
          </Form>
        )}
      </div>

      <Form action={`/admin/users/${u.id}/password`} class="channel">
        <input
          type="password"
          name="password"
          placeholder="New password"
          aria-label={`New password for ${u.username}`}
          class="channel__input"
          minlength={12}
          required
        />
        <button type="submit" class="channel__submit channel__submit--quiet">
          <span class="legend">Reset password</span>
        </button>
      </Form>
    </section>
  );
}

export function UsersPage(props: { user: UserRow; users: UserRow[]; error?: string }) {
  const count = props.users.length;
  return (
    <Layout title="Users" user={props.user}>
      <PageHead title="Accounts" aside={`${count} ${count === 1 ? "account" : "accounts"}`} />
      <Alert message={props.error} />
      {props.users.map((u) => (
        <Account user={u} isSelf={u.id === props.user.id} />
      ))}
      {props.users.length > 1 ? (
        <div class="band">
          <div class="band__head">
            <span class="legend">Before you delete an account</span>
          </div>
          <p class="band__note">
            Deleting reassigns that account's skills and the author records on its published versions
            to you, and the original authorship is lost. To withdraw access without that cost, use
            Demote to member plus Rotate install key instead.
          </p>
        </div>
      ) : null}
      <section class="band">
        <div class="band__head">
          <span class="legend">Add an account</span>
        </div>
        <Form action="/admin/users" class="form">
          <Field label="Username" name="username" />
          <Field label="Initial password" name="password" type="password" hint="At least 12 characters" />
          <div class="label-field">
            <span class="legend" id="role-legend">Role</span>
            <div class="choices choices--boxed" role="radiogroup" aria-labelledby="role-legend">
              <label class="choice">
                <input type="radio" name="role" value="member" class="choice__input" checked />
                <span class="legend">member</span>
              </label>
              <label class="choice">
                <input type="radio" name="role" value="admin" class="choice__input" />
                <span class="legend">admin</span>
              </label>
            </div>
          </div>
          <Button>Create</Button>
        </Form>
      </section>
    </Layout>
  );
}
