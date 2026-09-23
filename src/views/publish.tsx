import { Form } from "../csrf";
import { Alert, Button, ClassMark, Layout, PageHead } from "./layout";
import type { UserRow } from "../db/queries";

function ClassChoice(props: { value: "private" | "public"; note: string; checked?: boolean }) {
  return (
    <label class="choice">
      <input
        type="radio"
        name="visibility"
        value={props.value}
        class="choice__input"
        checked={props.checked}
      />
      <ClassMark visibility={props.value} />
      <span class="choice__note">{props.note}</span>
    </label>
  );
}

export function NewSkillPage(props: { user: UserRow; error?: string; markdown?: string }) {
  return (
    <Layout title="Publish a skill" user={props.user}>
      <PageHead title="Publish a skill" aside="2 MB uploaded · 8 MB unpacked · 200 files" />
      <Alert message={props.error} />
      <Form action="/new" enctype="multipart/form-data">
        <section class="band band--bleed">
          <div class="band__head">
            <label for="file" class="legend">Archive · .zip, .tar.gz or a bare SKILL.md</label>
          </div>
          <div class="channel">
            <input id="file" type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="channel__file" />
          </div>
          <p class="band__note">
            The archive must contain SKILL.md, optionally inside one wrapper directory.
          </p>
        </section>

        <section class="band band--bleed">
          <div class="band__head">
            <label for="markdown" class="legend">Or · SKILL.md text</label>
          </div>
          <div class="channel channel--area">
            <textarea
              id="markdown"
              name="markdown"
              rows={16}
              class="channel__area"
              placeholder={"---\nname: my-skill\ndescription: One sentence on what this skill does\n---\n\n# Body"}
            >
              {props.markdown ?? ""}
            </textarea>
          </div>
        </section>

        <section class="band band--bleed">
          <div class="band__head">
            <span class="legend" id="visibility-legend">Visibility</span>
          </div>
          <div class="choices" role="radiogroup" aria-labelledby="visibility-legend">
            <ClassChoice value="private" note="Visible to signed-in users only" checked />
            <ClassChoice value="public" note="Anyone can see and install it" />
          </div>
        </section>

        <div class="band">
          <Button>Publish</Button>
        </div>
      </Form>
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
      <PageHead title={`Edit · ${props.slug}`} aside="Publishes a new version" />
      <Alert message={props.error} />
      <Form action={`/s/${props.slug}/edit`} enctype="multipart/form-data">
        <section class="band band--bleed">
          <div class="band__head">
            <label for="markdown" class="legend">SKILL.md text</label>
          </div>
          <div class="channel channel--area">
            <textarea id="markdown" name="markdown" rows={24} class="channel__area">
              {props.markdown}
            </textarea>
          </div>
          <p class="band__note">
            Saving publishes a new version; the old ones stay. To replace the whole archive — say, because
            you changed files other than SKILL.md — use{" "}
            <a href={`/s/${props.slug}/upload`}>Upload an archive</a>.
            {props.files.length > 0
              ? ` These files carry over to the new version unchanged: ${props.files.join(", ")}.`
              : ""}
          </p>
        </section>

        <div class="band">
          <Button>Save as a new version</Button>
        </div>
      </Form>
    </Layout>
  );
}

export function UploadVersionPage(props: { user: UserRow; slug: string; error?: string }) {
  return (
    <Layout title={`Upload a new version · ${props.slug}`} user={props.user}>
      <PageHead title={`Upload · ${props.slug}`} aside="Replaces the whole archive" />
      <Alert message={props.error} />
      <Form action={`/s/${props.slug}/upload`} enctype="multipart/form-data">
        <section class="band band--bleed">
          <div class="band__head">
            <label for="file" class="legend">Archive · .zip, .tar.gz or a bare SKILL.md</label>
            <span class="legend">2 MB maximum</span>
          </div>
          <div class="channel">
            <input id="file" type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="channel__file" />
          </div>
          <p class="band__note">
            The new version is exactly what this archive contains; the old ones stay. It must contain
            SKILL.md, optionally inside one wrapper directory, and the name field in that SKILL.md must
            still be {props.slug}. To change only SKILL.md, use{" "}
            <a href={`/s/${props.slug}/edit`}>Edit</a>.
          </p>
        </section>

        <div class="band">
          <Button>Publish as a new version</Button>
        </div>
      </Form>
    </Layout>
  );
}
