import { Form } from "../csrf";
import { Button, Layout, PageHead } from "./layout";
import type { UserRow } from "../db/queries";

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

export function NewSkillPage(props: { user: UserRow; error?: string; markdown?: string }) {
  return (
    <Layout title="Publish a skill" user={props.user}>
      <div class="cf-narrow">
        <PageHead title="Publish a skill" error={props.error} />
        <Form action="/new" enctype="multipart/form-data" class="cf-frame cf-form">
          <div class="cf-form-section">
            <FilePicker
              label="Upload an archive"
              hint=".zip and .tar.gz are supported. The archive must contain SKILL.md, optionally inside one wrapper directory. 2 MB maximum."
            />
          </div>
          <div class="cf-form-section">
            <label class="cf-field">
              <span class="cf-label">Or paste SKILL.md directly</span>
              <textarea
                name="markdown"
                rows={16}
                class="cf-input cf-textarea"
                placeholder={"---\nname: my-skill\ndescription: One sentence on what this skill does\n---\n\n# Body"}
              >
                {props.markdown ?? ""}
              </textarea>
            </label>
          </div>
          <fieldset class="cf-form-section cf-fieldset">
            <legend class="cf-label">Visibility</legend>
            <div class="cf-choices">
              <VisibilityChoice value="private" title="Private" detail="Visible to signed-in users only" checked />
              <VisibilityChoice value="public" title="Public" detail="Anyone can see and install it" />
            </div>
          </fieldset>
          <div class="cf-form-foot">
            <Button>Publish</Button>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

export function EditSkillPage(props: {
  user: UserRow;
  slug: string;
  markdown: string;
  files: string[];
  error?: string;
}) {
  return (
    <Layout title={`Edit ${props.slug}`} user={props.user}>
      <div class="cf-narrow cf-narrow-wide">
        <PageHead title={`Edit ${props.slug}`} error={props.error}>
          Saving publishes a new version; the old ones stay. To replace the whole archive (say, because you changed
          files other than SKILL.md), use{" "}
          <a href={`/s/${props.slug}/upload`} class="cf-link">Upload an archive</a>.
        </PageHead>
        <Form action={`/s/${props.slug}/edit`} enctype="multipart/form-data" class="cf-frame cf-form">
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
              <p class="cf-hint">These files carry over to the new version unchanged:</p>
              <ul class="cf-chips">
                {props.files.map((f) => (
                  <li class="cf-chip">{f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class="cf-form-foot">
            <Button>Save as a new version</Button>
            <a href={`/s/${props.slug}`} class="cf-btn cf-btn-outline">Cancel</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}

export function UploadVersionPage(props: { user: UserRow; slug: string; error?: string }) {
  return (
    <Layout title={`Upload a new version · ${props.slug}`} user={props.user}>
      <div class="cf-narrow">
        <PageHead title={`Upload a new version: ${props.slug}`} error={props.error}>
          Whole-archive replacement: the new version is exactly what this archive contains; the old ones stay. To change
          only SKILL.md, use <a href={`/s/${props.slug}/edit`} class="cf-link">Edit</a>.
        </PageHead>
        <Form action={`/s/${props.slug}/upload`} enctype="multipart/form-data" class="cf-frame cf-form">
          <div class="cf-form-section">
            <FilePicker
              label="Archive"
              hint={
                <>
                  .zip and .tar.gz are supported. The archive must contain SKILL.md, optionally inside one wrapper
                  directory, and the name field in that SKILL.md must still be {props.slug}. 2 MB maximum.
                </>
              }
            />
          </div>
          <div class="cf-form-foot">
            <Button>Publish as a new version</Button>
            <a href={`/s/${props.slug}`} class="cf-btn cf-btn-outline">Cancel</a>
          </div>
        </Form>
      </div>
    </Layout>
  );
}
