import { Form } from "../csrf";
import { useLocale, useT } from "../i18n";
import type { Messages } from "../i18n/en";
import { formatRegion, formatStamp } from "../i18n/format";
import type { Locale } from "../i18n/locales";
import type { CliLoginRow } from "../db/logins";
import type { Viewer } from "../db/queries";
import { AlertIcon, Button, Field, Layout, PageHead } from "./layout";

export const LoginCommand = () => <code>skillsgist login</code>;

export function DeviceCodePage(props: { user: Viewer; code: string; error?: unknown }) {
  const t = useT();
  return (
    <Layout title={t.device.title} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.device.title} error={props.error}>
          {t.device.codeLede(<LoginCommand />)}
        </PageHead>
        <Form action="/device" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field label={t.device.code} name="code" value={props.code} autocomplete="off" hint={t.device.codeHint(<code>BCDF-GHJK</code>)} code />
            </div>
          </div>
          <div class="cf-form-foot">
            <Button>{t.device.continue}</Button>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

function requestPlace(t: Messages, locale: Locale, country: string | null): string {
  if (country === "T1") return t.device.tor;
  if (!country || country === "XX") return t.device.unknownPlace;
  return formatRegion(locale, country) ?? country;
}

export function DeviceConfirmPage(props: {
  user: Viewer;
  login: CliLoginRow;
  code: string;
  checked: string[];
  error?: string;
}) {
  const locale = useLocale();
  const t = useT();
  const { login, user } = props;
  return (
    <Layout title={t.device.confirmTitle} user={user}>
      <div class="cf-narrow">
        <PageHead title={t.device.confirmTitle} error={props.error} />
        {user.memberships.length > 0 ? (
          <p class="cf-notice">
            <AlertIcon />
            <span>{t.device.warning(<LoginCommand />)}</span>
          </p>
        ) : null}
        <Form action="/device" class="cf-frame cf-form">
          <input type="hidden" name="code" value={props.code} />
          <div class="cf-form-section cf-device-check">
            <dl class="cf-device-code">
              <dt class="cf-label">{t.device.code}</dt>
              <dd class="cf-device-code-value">{props.code}</dd>
            </dl>
            <p class="cf-hint">{t.device.codeCheck}</p>
          </div>
          <dl class="cf-rows cf-form-rows">
            <div class="cf-row">
              <dt class="cf-row-label">{t.device.computer}</dt>
              <dd class="cf-row-value">{login.device_name || t.auth.unnamedComputer}</dd>
            </div>
            <div class="cf-row">
              <dt class="cf-row-label">{t.device.requestedAt}</dt>
              <dd class="cf-row-value">
                <time datetime={new Date(login.created_at).toISOString()}>{formatStamp(locale, login.created_at)}</time>
              </dd>
            </div>
            <div class="cf-row">
              <dt class="cf-row-label">{t.device.from}</dt>
              <dd class="cf-row-value">{requestPlace(t, locale, login.request_country)}</dd>
            </div>
          </dl>
          {user.memberships.length === 0 ? (
            <div class="cf-form-section cf-field">
              <p class="cf-label">{t.device.projects}</p>
              <p class="cf-hint">{t.device.noProjects}</p>
            </div>
          ) : (
            <fieldset class="cf-form-section cf-fieldset">
              <legend class="cf-label">{t.device.projects}</legend>
              <div class="cf-choices">
                {user.memberships.map((m) => (
                  <label class="cf-choice">
                    <input
                      type="checkbox"
                      name="project"
                      value={m.project}
                      checked={props.checked.includes(m.project)}
                      class="cf-choice-input"
                    />
                    <span class="cf-choice-title">{m.project_name}</span>
                  </label>
                ))}
              </div>
              <p class="cf-hint">{t.device.projectsHint}</p>
            </fieldset>
          )}
          <div class="cf-form-foot">
            {user.memberships.length > 0 ? (
              <Button name="decision" value="approve">{t.device.approve}</Button>
            ) : null}
            <Button variant="outline" name="decision" value="deny">{t.device.deny}</Button>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

export function DeviceDonePage(props: { user: Viewer; projects: string | null }) {
  const t = useT();
  const approved = props.projects !== null;
  return (
    <Layout title={approved ? t.device.approvedTitle : t.device.deniedTitle} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={approved ? t.device.approvedTitle : t.device.deniedTitle}>
          {approved
            ? t.device.approvedBody(props.projects!, <a href="/me" class="cf-link">{t.device.accountPage}</a>)
            : t.device.deniedBody(<LoginCommand />)}
        </PageHead>
      </div>
    </Layout>
  );
}
