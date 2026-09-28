import { Form } from "../csrf";
import { useT } from "../i18n";
import { skillPath } from "../paths";
import { Button, Layout, PageHead, Select } from "./layout";
import type { SkillRow, UserRow } from "../db/queries";

function FilePicker(props: { label: string; hint: unknown }) {
  return (
    <label class="cf-field">
      <span class="cf-label">{props.label}</span>
      <input type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="cf-file" />
      <span class="cf-hint">{props.hint}</span>
    </label>
  );
}

function VisibilityChoice(props: { value: "private" | "public"; title: string; detail: string; checked?: boolean }) {
  return (
    <label class="cf-choice">
      <input type="radio" name="visibility" value={props.value} checked={props.checked} class="cf-choice-input" />
      <span class="cf-choice-title">{props.title}</span>
      <span class="cf-choice-detail">{props.detail}</span>
    </label>
  );
}

export function NewSkillPage(props: {
  user: UserRow;
  projects: Array<{ slug: string; name: string }>;
  project?: string;
  error?: string;
  markdown?: string;
}) {
  const t = useT();
  return (
    <Layout title={t.publish.title} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.publish.title} error={props.error} />
        {props.projects.length === 0 ? (
          <div class="cf-frame">
            <div class="cf-empty">
              <p class="cf-empty-title">{t.projects.noneMember}</p>
              <p class="cf-empty-body">{t.publish.noProjectBody}</p>
            </div>
          </div>
        ) : (
          <Form action="/new" enctype="multipart/form-data" class="cf-frame cf-form">
            <div class="cf-form-section">
              <FilePicker label={t.skills.uploadArchive} hint={t.publish.archiveHint} />
            </div>
            <div class="cf-form-section">
              <label class="cf-field">
                <span class="cf-label">{t.publish.pasteSkillMd}</span>
                <textarea name="markdown" rows={16} class="cf-input cf-textarea" placeholder={t.publish.placeholder}>
                  {props.markdown ?? ""}
                </textarea>
              </label>
            </div>
            <div class="cf-form-section">
              <Select label={t.publish.project} name="project">
                {props.projects.length > 1 ? (
                  <option value="" disabled selected={!props.project}>{t.publish.chooseProject}</option>
                ) : null}
                {props.projects.map((p) => (
                  <option value={p.slug} selected={p.slug === props.project}>{p.name}</option>
                ))}
              </Select>
            </div>
            <fieldset class="cf-form-section cf-fieldset">
              <legend class="cf-label">{t.publish.visibility}</legend>
              <div class="cf-choices">
                <VisibilityChoice value="private" title={t.skills.private} detail={t.publish.privateDetail} checked />
                <VisibilityChoice value="public" title={t.skills.public} detail={t.publish.publicDetail} />
              </div>
            </fieldset>
            <div class="cf-form-foot">
              <Button>{t.publish.submit}</Button>
            </div>
          </Form>
        )}
      </div>
    </Layout>
  );
}

export function EditSkillPage(props: {
  user: UserRow;
  skill: Pick<SkillRow, "project" | "slug">;
  markdown: string;
  files: string[];
  error?: string;
}) {
  const t = useT();
  const title = t.publish.editTitle(props.skill.slug);
  return (
    <Layout title={title} user={props.user}>
      <div class="cf-narrow cf-narrow-wide">
        <PageHead title={title} error={props.error}>
          {t.publish.editLede(
            <a href={`${skillPath(props.skill)}/upload`} class="cf-link">{t.skills.uploadArchive}</a>,
          )}
        </PageHead>
        <Form action={`${skillPath(props.skill)}/edit`} enctype="multipart/form-data" class="cf-frame cf-form">
          <header class="cf-panel-head">
            <span class="cf-chip">SKILL.md</span>
          </header>
          <label class="cf-editor">
            <span class="sr-only">SKILL.md</span>
            <textarea name="markdown" rows={24} class="cf-editor-input">
              {props.markdown}
            </textarea>
          </label>
          {props.files.length > 0 ? (
            <div class="cf-form-section cf-carry">
              <p class="cf-hint">{t.publish.carryOver}</p>
              <ul class="cf-chips">
                {props.files.map((f) => (
                  <li class="cf-chip">{f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class="cf-form-foot">
            <Button>{t.publish.saveVersion}</Button>
            <a href={skillPath(props.skill)} class="cf-btn cf-btn-outline">{t.common.cancel}</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

export function UploadVersionPage(props: { user: UserRow; skill: Pick<SkillRow, "project" | "slug">; error?: string }) {
  const t = useT();
  return (
    <Layout title={t.publish.uploadTitle(props.skill.slug)} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={t.publish.uploadHeading(props.skill.slug)} error={props.error}>
          {t.publish.uploadLede(<a href={`${skillPath(props.skill)}/edit`} class="cf-link">{t.publish.edit}</a>)}
        </PageHead>
        <Form action={`${skillPath(props.skill)}/upload`} enctype="multipart/form-data" class="cf-frame cf-form">
          <div class="cf-form-section">
            <FilePicker label={t.publish.archive} hint={t.publish.uploadHint(props.skill.slug)} />
          </div>
          <div class="cf-form-foot">
            <Button>{t.publish.publishVersion}</Button>
            <a href={skillPath(props.skill)} class="cf-btn cf-btn-outline">{t.common.cancel}</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}
