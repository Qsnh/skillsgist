import { Alert, Button, Layout } from "./layout";
import type { UserRow } from "../db/queries";

export function NewSkillPage(props: { user: UserRow; error?: string; markdown?: string }) {
  return (
    <Layout title="发布 skill" user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">发布 skill</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <form method="post" action="/new" enctype="multipart/form-data" class="space-y-6">
        <div>
          <span class="block text-sm font-medium text-slate-700">上传压缩包</span>
          <input type="file" name="file" accept=".zip,.tar.gz,.tgz,.md" class="mt-1 block text-sm" />
          <p class="mt-1 text-xs text-slate-500">
            支持 .zip 与 .tar.gz，压缩包内需包含 SKILL.md（多包一层目录也可以）。上限 2 MB。
          </p>
        </div>
        <div>
          <span class="block text-sm font-medium text-slate-700">或直接粘贴 SKILL.md</span>
          <textarea
            name="markdown"
            rows={16}
            class="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder={"---\nname: my-skill\ndescription: 一句话说明这个 skill 做什么\n---\n\n# 正文"}
          >
            {props.markdown ?? ""}
          </textarea>
        </div>
        <label class="block max-w-xs">
          <span class="block text-sm font-medium text-slate-700">可见性</span>
          <select name="visibility" class="mt-1 w-full rounded border border-slate-300 px-3 py-2">
            <option value="private">private（仅登录用户可见）</option>
            <option value="public">public（任何人可见和安装）</option>
          </select>
        </label>
        <Button>发布</Button>
      </form>
    </Layout>
  );
}

export function EditSkillPage(props: { user: UserRow; slug: string; markdown: string; error?: string }) {
  return (
    <Layout title={`编辑 ${props.slug}`} user={props.user}>
      <h1 class="mb-4 text-xl font-semibold">编辑 {props.slug}</h1>
      {props.error ? <Alert>{props.error}</Alert> : null}
      <p class="mb-4 text-sm text-slate-500">保存会发布一个新版本，旧版本保留。</p>
      <form method="post" action={`/s/${props.slug}/edit`} enctype="multipart/form-data" class="space-y-4">
        <textarea
          name="markdown"
          rows={24}
          class="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        >
          {props.markdown}
        </textarea>
        <Button>保存为新版本</Button>
      </form>
    </Layout>
  );
}
