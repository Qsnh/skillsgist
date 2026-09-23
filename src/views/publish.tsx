import { Form } from "../csrf";
import { Alert, Button, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function NewSkillPage(props: { user: UserRow; error?: string; markdown?: string }) {
  return (
    <Layout title="Publish a skill" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">Publish a skill</h1>
      <Alert message={props.error} />
      <Form action="/new" enctype="multipart/form-data" class="space-y-6">
        <div>
          <span class="block text-sm font-medium text-slate-700">Upload an archive</span>
          <input type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="mt-1 block text-sm" />
          <p class="mt-1 text-xs text-slate-500">
            .zip and .tar.gz are supported. The archive must contain SKILL.md, optionally inside one wrapper directory. 2 MB maximum.
          </p>
        </div>
        <div>
          <span class="block text-sm font-medium text-slate-700">Or paste SKILL.md directly</span>
          <textarea
            name="markdown"
            rows={16}
            class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder={"---\nname: my-skill\ndescription: One sentence on what this skill does\n---\n\n# Body"}
          >
            {props.markdown ?? ""}
          </textarea>
        </div>
        <label class="block max-w-xs">
          <span class="block text-sm font-medium text-slate-700">Visibility</span>
          <select name="visibility" class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option value="private">private (visible to signed-in users only)</option>
            <option value="public">public (anyone can see and install it)</option>
          </select>
        </label>
        <Button>Publish</Button>
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
      <h1 class="mb-4 text-xl font-semibold">Edit {props.slug}</h1>
      <Alert message={props.error} />
      <p class="mb-4 text-sm text-slate-500">
        Saving publishes a new version; the old ones stay. To replace the whole archive (say, because you changed files other than SKILL.md), use{" "}
        <a href={`/s/${props.slug}/upload`} class="underline">Upload an archive</a>.
      </p>
      <Form action={`/s/${props.slug}/edit`} enctype="multipart/form-data" class="space-y-4">
        <textarea
          name="markdown"
          rows={24}
          class="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        >
          {props.markdown}
        </textarea>
        {props.files.length > 0 ? (
          <p class="text-xs text-slate-500">
            These files carry over to the new version unchanged: {props.files.join(", ")}
          </p>
        ) : null}
        <Button>Save as a new version</Button>
      </Form>
    </Layout>
  );
}

export function UploadVersionPage(props: { user: UserRow; slug: string; error?: string }) {
  return (
    <Layout title={`Upload a new version · ${props.slug}`} user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">Upload a new version: {props.slug}</h1>
      <Alert message={props.error} />
      <p class="mb-4 text-sm text-slate-500">
        Whole-archive replacement: the new version is exactly what this archive contains; the old ones stay. To change only SKILL.md, use{" "}
        <a href={`/s/${props.slug}/edit`} class="underline">Edit</a>.
      </p>
      <Form action={`/s/${props.slug}/upload`} enctype="multipart/form-data" class="space-y-6">
        <div>
          <input type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="block text-sm" />
          <p class="mt-1 text-xs text-slate-500">
            .zip and .tar.gz are supported. The archive must contain SKILL.md, optionally inside one
            wrapper directory, and the name field in that SKILL.md must still be {props.slug}. 2 MB maximum.
          </p>
        </div>
        <Button>Publish as a new version</Button>
      </Form>
    </Layout>
  );
}
