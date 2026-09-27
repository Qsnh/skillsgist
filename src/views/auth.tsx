import { Form } from "../csrf";
import { useLocale, useT } from "../i18n";
import { formatDate } from "../i18n/format";
import { userSettingsPath } from "../paths";
import { Alert, AlertIcon, Button, CodeBlock, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "./layout";
import type { UserRow, UserSummary, Viewer } from "../db/queries";

function AuthCard(props: { title: string; error?: string; children?: unknown }) {
  return (
    <div class="cf-auth">
      <div class="cf-frame cf-auth-card">
        <img src="/logo.png" width="48" height="48" alt="" class="cf-auth-mark" />
        <h1 class="cf-auth-title">{props.title}</h1>
        <Alert message={props.error} />
        {props.children}
      </div>
    </div>
  );
}

export function SetupPage(props: { error?: string }) {
  const t = useT();
  return (
    <Layout title={t.auth.setupTitle} user={null} hideSignIn>
      <AuthCard title={t.auth.setupHeading} error={props.error}>
        <form method="post" action="/setup" class="cf-stack">
          <Field label={t.common.username} name="username" autocomplete="username" hint={t.common.usernameHint} />
          <Field
            label={t.common.password}
            name="password"
            type="password"
            autocomplete="new-password"
            hint={t.common.passwordHint}
          />
          <Button wide>{t.common.create}</Button>
        </form>
      </AuthCard>
    </Layout>
  );
}

export function LoginPage(props: { error?: string }) {
  const t = useT();
  return (
    <Layout title={t.layout.signIn} user={null} hideSignIn>
      <AuthCard title={t.layout.signIn} error={props.error}>
        <form method="post" action="/login" class="cf-stack">
          <Field label={t.common.username} name="username" autocomplete="username" />
          <Field label={t.common.password} name="password" type="password" autocomplete="current-password" />
          <Button wide>{t.layout.signIn}</Button>
        </form>
      </AuthCard>
    </Layout>
  );
}

export function RoleLabel(props: { role: UserRow["role"] }) {
  const t = useT();
  return (
    <span class={props.role === "admin" ? "cf-vis cf-vis-public" : "cf-vis cf-vis-private"}>
      {t.common.roles[props.role]}
    </span>
  );
}

function ShownOnceToken(props: { token: string }) {
  const t = useT();
  return (
    <>
      <CodeBlock prompt={false}>{props.token}</CodeBlock>
      <p class="cf-notice">
        <AlertIcon />
        {t.auth.tokenShownOnce}
      </p>
    </>
  );
}

function TokenStatus(props: { active: boolean }) {
  const t = useT();
  return (
    <p class="cf-status">
      {t.auth.tokenStatus}{" "}
      <span class={props.active ? "cf-status-value cf-status-on" : "cf-status-value"}>
        {props.active ? t.auth.tokenActive : t.auth.tokenNotGenerated}
      </span>
    </p>
  );
}

export function MePage(props: { user: Viewer; newToken?: string; error?: string }) {
  const t = useT();
  return (
    <Layout title={t.layout.account} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.layout.account} error={props.error} />

        <div class="cf-stack-lg">
          <Panel title={t.auth.apiTokenPanel}>
            {props.newToken ? (
              <ShownOnceToken token={props.newToken} />
            ) : (
              <TokenStatus active={props.user.api_token_hash !== null} />
            )}
            <div class="cf-actions">
              <Form action="/me/api-token">
                <Button variant="outline">{t.auth.generateToken}</Button>
              </Form>
              {props.user.api_token_hash ? (
                <ConfirmDelete
                  action="/me/api-token/revoke"
                  label={t.auth.revoke}
                  confirm={t.auth.revokeToken}
                  name="revoke-api-token"
                >
                  {t.auth.revokeOwnWarning}
                </ConfirmDelete>
              ) : null}
            </div>
          </Panel>

          <Panel title={t.auth.changePassword}>
            <Form action="/me/password" class="cf-stack cf-stack-form">
              <Field label={t.auth.currentPassword} name="current" type="password" autocomplete="current-password" />
              <Field
                label={t.common.newPassword}
                name="next"
                type="password"
                autocomplete="new-password"
                hint={t.common.passwordHint}
              />
              <div>
                <Button>{t.common.save}</Button>
              </div>
            </Form>
          </Panel>
        </div>
      </div>
    </Layout>
  );
}

export function UsersPage(props: { user: UserRow; users: UserSummary[] }) {
  const locale = useLocale();
  const t = useT();
  return (
    <Layout title={t.layout.users} user={props.user}>
      <PageHead
        title={t.layout.users}
        compact
        aside={
          <>
            <span class="cf-count">{props.users.length}</span>
            <a href="/admin/users/new" class="cf-btn cf-btn-outline cf-head-action">{t.users.add}</a>
          </>
        }
      />
      <div class="cf-frame cf-table-frame">
        <table class="cf-table">
          <thead>
            <tr>
              <th scope="col">{t.common.username}</th>
              <th scope="col">{t.common.role}</th>
              <th scope="col">{t.users.columns.projects}</th>
              <th scope="col">{t.users.columns.skills}</th>
              <th scope="col">{t.users.columns.joined}</th>
              <th scope="col">{t.users.columns.lastSignIn}</th>
            </tr>
          </thead>
          <tbody>
            {props.users.map((u) => (
              <tr>
                <td data-label={t.common.username}>
                  <span class="cf-user">
                    <a href={userSettingsPath(u.id)} class="cf-link cf-user-name">{u.username}</a>
                    {u.id === props.user.id ? <span class="cf-tag">{t.common.you}</span> : null}
                  </span>
                </td>
                <td data-label={t.common.role}>
                  <RoleLabel role={u.role} />
                </td>
                <td data-label={t.users.columns.projects} class="cf-table-date">{u.projects}</td>
                <td data-label={t.users.columns.skills} class="cf-table-date">{u.skills}</td>
                <td data-label={t.users.columns.joined} class="cf-table-date">{formatDate(locale, u.created_at)}</td>
                <td data-label={t.users.columns.lastSignIn} class="cf-table-date">
                  {u.last_login_at ? formatDate(locale, u.last_login_at) : "—"}
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
  const locale = useLocale();
  const t = useT();
  const { target } = props;
  const isSelf = target.id === props.user.id;
  const path = userSettingsPath(target.id);
  const title = t.users.settingsTitle(target.username);
  return (
    <Layout title={title} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={title} error={props.error}>
          {t.users.history(
            formatDate(locale, target.created_at),
            target.last_login_at ? formatDate(locale, target.last_login_at) : null,
          )}
        </PageHead>
        <div class="cf-stack-lg">
          <Panel title={t.common.role}>
            <p class="cf-status">
              {t.users.roleStatus}{" "}
              <RoleLabel role={target.role} />
            </p>
            {isSelf ? (
              <p class="cf-hint">{t.users.ownRole}</p>
            ) : (
              <Form action={`${path}/role`} class="cf-actions">
                <input type="hidden" name="role" value={target.role === "admin" ? "member" : "admin"} />
                <Button variant="outline">{target.role === "admin" ? t.users.demote : t.users.promote}</Button>
              </Form>
            )}
          </Panel>

          <Panel title={t.users.installKeys}>
            {target.projects === 0 ? (
              <p class="cf-hint">{t.users.noInstallKeys(target.username)}</p>
            ) : (
              <>
                <p class="cf-hint">{t.users.installKeysHint(target.username, target.projects)}</p>
                <Form action={`${path}/install-key`} class="cf-actions">
                  <Button variant="outline">{t.users.rotateKeys}</Button>
                </Form>
              </>
            )}
          </Panel>

          <Panel title={t.users.apiToken}>
            {props.newToken ? (
              <ShownOnceToken token={props.newToken} />
            ) : (
              <>
                <TokenStatus active={target.api_token_hash !== null} />
                <p class="cf-hint">
                  {target.api_token_hash
                    ? isSelf
                      ? t.users.tokenReplacesOwn
                      : t.users.tokenReplacesUser(target.username)
                    : null}
                  {t.users.tokenShownOnPage}
                </p>
              </>
            )}
            <div class="cf-actions">
              <Form action={`${path}/api-token`}>
                <Button variant="outline">{t.auth.generateToken}</Button>
              </Form>
              {target.api_token_hash ? (
                <ConfirmDelete
                  action={`${path}/api-token/revoke`}
                  label={t.auth.revokeToken}
                  confirm={isSelf ? t.users.revokeOwnToken : t.users.revokeUserToken(target.username)}
                  name="revoke-api-token"
                >
                  {isSelf ? t.users.revokeOwnTokenWarning : t.users.revokeUserTokenWarning(target.username)}
                </ConfirmDelete>
              ) : null}
            </div>
          </Panel>

          <Panel title={t.users.resetPassword}>
            <Form action={`${path}/password`} class="cf-stack cf-stack-form">
              <Field
                label={t.common.newPassword}
                name="password"
                type="password"
                autocomplete="new-password"
                hint={t.common.passwordHint}
              />
              <div>
                <Button>{t.users.resetPassword}</Button>
              </div>
            </Form>
          </Panel>

          {isSelf ? null : (
            <Panel title={t.users.deletePanel}>
              <div class="cf-actions">
                <ConfirmDelete
                  action={`${path}/delete`}
                  label={t.users.deleteAccount}
                  confirm={t.users.deleteUser(target.username)}
                  name="delete-user"
                >
                  {t.users.deleteWarning}
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
  const t = useT();
  return (
    <Layout title={t.users.add} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.users.add} error={props.error} />
        <Form action="/admin/users/new" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field
                label={t.common.username}
                name="username"
                value={props.username}
                autocomplete="off"
                hint={t.common.usernameHint}
              />
              <Field
                label={t.users.initialPassword}
                name="password"
                type="password"
                autocomplete="new-password"
                hint={t.common.passwordHint}
              />
              <Select label={t.common.role} name="role">
                <option value="member">{t.common.roles.member}</option>
                <option value="admin" selected={props.role === "admin"}>{t.common.roles.admin}</option>
              </Select>
              <p class="cf-hint">{t.users.newAccountHint}</p>
            </div>
          </div>
          <div class="cf-form-foot">
            <Button>{t.common.create}</Button>
            <a href="/admin/users" class="cf-btn cf-btn-outline">{t.common.cancel}</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}
