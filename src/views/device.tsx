import { Form } from "../csrf";
import { useLocale, useT } from "../i18n";
import { formatStamp } from "../i18n/format";
import type { CliLoginRow } from "../db/logins";
import type { Viewer } from "../db/queries";
import { projectPath } from "../paths";
import { AlertIcon, Button, Field, Layout, PageHead, Panel } from "./layout";

export function DeviceCodePage(props: { user: Viewer; code: string; error?: string }) {
  const t = useT();
  return (
    <Layout title={t.device.title} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.device.title} error={props.error}>
          {t.device.codeLede}
        </PageHead>
        <Form action="/device" class="cf-frame cf-form">
          <div class="cf-form-section">
            <div class="cf-stack cf-stack-form">
              <Field label={t.device.code} name="code" value={props.code} autocomplete="off" hint={t.device.codeHint} />
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
        <p class="cf-notice">
          <AlertIcon />
          {t.device.warning}
        </p>
        <Form action="/device" class="cf-stack-lg">
          <input type="hidden" name="code" value={props.code} />
          <Panel title={t.device.request} flush>
            <dl class="cf-rows">
              <div class="cf-row">
                <dt class="cf-row-label">{t.device.computer}</dt>
                <dd class="cf-row-value">{login.device_name || t.device.unnamed}</dd>
              </div>
              <div class="cf-row">
                <dt class="cf-row-label">{t.device.requestedAt}</dt>
                <dd class="cf-row-value">{formatStamp(locale, login.created_at)}</dd>
              </div>
              <div class="cf-row">
                <dt class="cf-row-label">{t.device.from}</dt>
                <dd class="cf-row-value">{login.request_country ?? t.device.unknownPlace}</dd>
              </div>
              <div class="cf-row">
                <dt class="cf-row-label">{t.device.code}</dt>
                <dd class="cf-row-value">{props.code}</dd>
              </div>
            </dl>
          </Panel>
          <Panel title={t.device.projects}>
            {user.memberships.length === 0 ? (
              <p class="cf-hint">{t.device.noProjects}</p>
            ) : (
              <>
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
                      <span class="cf-choice-detail">{projectPath(m.project)}</span>
                    </label>
                  ))}
                </div>
                <p class="cf-hint">{t.device.projectsHint}</p>
              </>
            )}
            <div class="cf-actions">
              {user.memberships.length > 0 ? (
                <Button name="decision" value="approve">{t.device.approve}</Button>
              ) : null}
              <Button variant="outline" name="decision" value="deny">{t.device.deny}</Button>
            </div>
          </Panel>
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
          {approved ? t.device.approvedBody(props.projects!) : t.device.deniedBody}
        </PageHead>
      </div>
    </Layout>
  );
}
