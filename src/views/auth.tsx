import { Form } from "../csrf";
import { Alert, Button, CodeBlock, Field, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function SetupPage(props: { error?: string }) {
  return (
    <Layout title="Setup" user={null}>
      <h1 class="mb-4 text-xl font-semibold">Create the first admin</h1>
      <Alert message={props.error} />
      {/* Plain <form>, not <Form>: no session exists during bootstrap, so
          there is no session-bound token to render. Covered by the Origin /
          Sec-Fetch-Site layer only — see TOKENLESS_PATHS in src/csrf.tsx. */}
      <form method="post" action="/setup" class="max-w-sm space-y-4">
        <Field label="Username" name="username" hint="Lowercase letters, digits and hyphens, 2-32 characters" />
        <Field label="Password" name="password" type="password" hint="At least 12 characters" />
        <Button>Create</Button>
      </form>
    </Layout>
  );
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in" user={null}>
      <h1 class="mb-4 text-xl font-semibold">Sign in</h1>
      <Alert message={props.error} />
      {/* Plain <form>, not <Form>: same reason as SetupPage above — no session
          to bind a token to yet. See TOKENLESS_PATHS in src/csrf.tsx. */}
      <form method="post" action="/login" class="max-w-sm space-y-4">
        <Field label="Username" name="username" />
        <Field label="Password" name="password" type="password" />
        <Button>Sign in</Button>
      </form>
    </Layout>
  );
}

export function MePage(props: { user: UserRow; origin: string; newToken?: string; error?: string }) {
  const installUrl = `${props.origin}/i/${props.user.install_key}`;
  return (
    <Layout title="Account" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">Account</h1>
      <Alert message={props.error} />

      <section class="mb-8">
        <h2 class="mb-2 font-medium">Install every skill</h2>
        <CodeBlock>npx skills add {installUrl}</CodeBlock>
        <p class="mt-2 text-xs text-slate-500">
          This key can only install. It cannot sign in, publish or delete. Reset it below if you think it has leaked.
        </p>
        <Form action="/me/install-key" class="mt-2">
          <Button>Reset install key</Button>
        </Form>
      </section>

      <section class="mb-8">
        <h2 class="mb-2 font-medium">API token (for publishing with curl)</h2>
        {props.newToken ? (
          <CodeBlock>{props.newToken}</CodeBlock>
        ) : null}
        {props.newToken ? (
          <p class="mt-2 text-xs text-amber-700">This token is shown once. Save it now.</p>
        ) : (
          <p class="mt-2 text-xs text-slate-500">
            Status: {props.user.api_token_hash ? "active" : "not generated"}
          </p>
        )}
        <div class="mt-2 flex gap-2">
          <Form action="/me/api-token"><Button>Generate a new token</Button></Form>
          {props.user.api_token_hash ? (
            <Form action="/me/api-token/revoke"><Button>Revoke</Button></Form>
          ) : null}
        </div>
      </section>

      <section>
        <h2 class="mb-2 font-medium">Change password</h2>
        <Form action="/me/password" class="max-w-sm space-y-4">
          <Field label="Current password" name="current" type="password" />
          <Field label="New password" name="next" type="password" hint="At least 12 characters" />
          <Button>Save</Button>
        </Form>
      </section>
    </Layout>
  );
}

export function UsersPage(props: { user: UserRow; users: UserRow[]; error?: string }) {
  return (
    <Layout title="Users" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">Users</h1>
      <Alert message={props.error} />
      <table class="mb-8 w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-slate-500">
            <th class="py-2">Username</th><th>Role</th><th>Last sign-in</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((u) => {
            // The server refuses these outright (see adminTarget), but a
            // control that is always rejected is a bad guard on its own —
            // don't render it into a guaranteed 400.
            const isSelf = u.id === props.user.id;
            return (
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2">{u.username}</td>
                <td>{u.role}</td>
                <td>{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 10) : "—"}</td>
                <td class="space-y-2 py-2">
                  {isSelf ? null : (
                    <>
                      <Form action={`/admin/users/${u.id}/role`} class="inline-block">
                        <input type="hidden" name="role" value={u.role === "admin" ? "member" : "admin"} />
                        <Button>{u.role === "admin" ? "Demote to member" : "Promote to admin"}</Button>
                      </Form>{" "}
                    </>
                  )}
                  <Form action={`/admin/users/${u.id}/install-key`} class="inline-block">
                    <Button>Rotate install key</Button>
                  </Form>{" "}
                  {u.api_token_hash ? (
                    <Form action={`/admin/users/${u.id}/api-token/revoke`} class="inline-block">
                      <Button>Revoke API token</Button>
                    </Form>
                  ) : null}
                  <Form action={`/admin/users/${u.id}/password`} class="mt-1 flex items-center gap-2">
                    <input
                      type="password"
                      name="password"
                      placeholder="New password (at least 12 characters)"
                      class="rounded border border-slate-300 px-2 py-1 text-sm"
                      required
                    />
                    <Button>Reset password</Button>
                  </Form>
                  {isSelf ? null : (
                    <div class="mt-1">
                      <Form action={`/admin/users/${u.id}/delete`} class="inline-block">
                        <Button>Delete account</Button>
                      </Form>
                      <p class="mt-1 max-w-xs text-xs text-slate-500">
                        Deleting reassigns this user's skills and their published
                        versions' author records to you. To keep the author records,
                        use "Demote to member" plus "Rotate install key" instead of
                        deleting.
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 class="mb-2 font-medium">Add a user</h2>
      <Form action="/admin/users" class="max-w-sm space-y-4">
        <Field label="Username" name="username" />
        <Field label="Initial password" name="password" type="password" hint="At least 12 characters" />
        <label class="block">
          <span class="block text-sm font-medium text-slate-700">Role</span>
          <select name="role" class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <Button>Create</Button>
      </Form>
    </Layout>
  );
}
