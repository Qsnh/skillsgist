import { Layout } from "./layout";
import type { SkillRow, UserRow, VersionRow } from "../db/queries";

function InstallBlock(props: { origin: string; slug: string; user: UserRow | null; isPublic: boolean }) {
  const base = props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin;
  const url = `${base}/.well-known/agent-skills/${props.slug}`;
  return (
    <div>
      <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">npx skills add {url}</pre>
      {!props.user && !props.isPublic ? null : (
        <p class="mt-1 text-xs text-slate-500">
          {props.user
            ? "这条命令带着你的 install key，可以装私有 skill。"
            : "这是公开地址，任何人都能用。"}
        </p>
      )}
    </div>
  );
}

export function IndexPage(props: {
  user: UserRow | null;
  skills: Array<SkillRow & { author: string }>;
  q: string;
  origin: string;
}) {
  return (
    <Layout title="全部 skill" user={props.user}>
      <form method="get" action="/" class="mb-6 flex gap-2">
        <input
          name="q"
          value={props.q}
          placeholder="搜索名称、简介或正文"
          class="flex-1 rounded border border-slate-300 px-3 py-2"
        />
        <button type="submit" class="rounded bg-slate-900 px-4 py-2 text-sm text-white">搜索</button>
      </form>

      {props.user ? (
        <div class="mb-6">
          <h2 class="mb-1 text-sm font-medium text-slate-700">一次装上全部</h2>
          <pre class="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-sm text-slate-100">npx skills add {props.origin}/i/{props.user.install_key}</pre>
        </div>
      ) : null}

      {props.skills.length === 0 ? (
        <p class="text-sm text-slate-500">
          {props.q ? "没有匹配的 skill。" : "还没有任何 skill。"}
        </p>
      ) : (
        <ul class="divide-y divide-slate-200">
          {props.skills.map((s) => (
            <li class="py-3">
              <div class="flex items-baseline gap-2">
                <a href={`/s/${s.slug}`} class="font-medium text-slate-900 hover:underline">{s.slug}</a>
                {s.visibility === "private" ? (
                  <span class="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">private</span>
                ) : (
                  <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">public</span>
                )}
                <span class="text-xs text-slate-400">v{s.latest_version} · {s.author}</span>
              </div>
              <p class="mt-1 text-sm text-slate-600">{s.description}</p>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export function SkillPage(props: {
  user: UserRow | null;
  skill: SkillRow & { author: string };
  version: VersionRow;
  versions: VersionRow[];
  origin: string;
  canManage: boolean;
}) {
  const files = JSON.parse(props.version.files) as Array<{ path: string; size: number }>;
  return (
    <Layout title={props.skill.slug} user={props.user}>
      <div class="mb-2 flex items-baseline gap-2">
        <h1 class="text-xl font-semibold">{props.skill.slug}</h1>
        <span class="text-xs text-slate-400">
          v{props.version.version} · {props.skill.author} · {props.skill.visibility}
        </span>
      </div>
      <p class="mb-6 text-sm text-slate-600">{props.version.description}</p>

      <div class="mb-6 space-y-2">
        <InstallBlock
          origin={props.origin}
          slug={props.skill.slug}
          user={props.user}
          isPublic={props.skill.visibility === "public"}
        />
        <div class="flex flex-wrap gap-2 text-sm">
          <a href={`/s/${props.skill.slug}/download`} class="rounded border border-slate-300 px-3 py-1.5">
            下载 zip
          </a>
          {props.canManage ? (
            <>
              <a href={`/s/${props.skill.slug}/edit`} class="rounded border border-slate-300 px-3 py-1.5">
                编辑
              </a>
              <form method="post" action={`/s/${props.skill.slug}/visibility`}>
                <button type="submit" class="rounded border border-slate-300 px-3 py-1.5">
                  {props.skill.visibility === "public" ? "改为 private" : "改为 public"}
                </button>
              </form>
              <form method="post" action={`/s/${props.skill.slug}/delete`}>
                <button type="submit" class="rounded border border-red-300 px-3 py-1.5 text-red-700">
                  删除
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>

      <section class="mb-6">
        <h2 class="mb-2 text-sm font-medium text-slate-700">文件</h2>
        <ul class="text-sm text-slate-600">
          {files.map((f) => (
            <li class="flex justify-between border-b border-slate-100 py-1">
              <span class="font-mono">{f.path}</span>
              <span class="text-slate-400">{f.size} B</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="mb-6">
        <h2 class="mb-2 text-sm font-medium text-slate-700">版本</h2>
        <ul class="text-sm text-slate-600">
          {props.versions.map((v) => (
            <li class="flex items-center gap-3 border-b border-slate-100 py-1">
              <a href={`/s/${props.skill.slug}?v=${v.version}`} class="hover:underline">v{v.version}</a>
              <span class="text-slate-400">{new Date(v.created_at).toISOString().slice(0, 16).replace("T", " ")}</span>
              <span class="flex-1" />
              <a href={`/s/${props.skill.slug}/v/${v.version}/download`} class="hover:underline">下载</a>
            </li>
          ))}
        </ul>
      </section>

      <article class="skill-doc" dangerouslySetInnerHTML={{ __html: props.version.html }} />
    </Layout>
  );
}
