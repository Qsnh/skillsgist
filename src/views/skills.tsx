import { membershipIn } from "../auth";
import { Form } from "../csrf";
import { useLocale, useT } from "../i18n";
import { formatCount, formatStamp } from "../i18n/format";
import { installBase, projectPath, skillPath } from "../paths";
import { Button, CodeBlock, ConfirmDelete, Icon, Layout, Panel, Select } from "./layout";
import type { ListedSkill, SkillRow, VersionRow, VersionSummary, Viewer } from "../db/queries";

function Visibility(props: { value: SkillRow["visibility"] }) {
  return props.value === "public" ? (
    <span class="cf-vis cf-vis-public">
      <GlobeIcon />
      Public
    </span>
  ) : (
    <span class="cf-vis cf-vis-private">
      <LockIcon />
      Private
    </span>
  );
}

function fullName(skill: ListedSkill) {
  return `${skill.project_name}/${skill.slug}`;
}

function SkillCell(props: { skill: ListedSkill; showDownloads: boolean }) {
  const s = props.skill;
  return (
    <li class="cf-cell">
      <div class="cf-cell-head">
        <h3 class="cf-cell-title">
          <a href={skillPath(s)} class="cf-cell-link">{fullName(s)}</a>
        </h3>
        <Visibility value={s.visibility} />
      </div>
      <p class="cf-cell-desc">{s.description}</p>
      <p class="cf-cell-meta">
        <span>{s.author}</span>
        {props.showDownloads ? <Downloads count={s.download_count} /> : null}
        <span class="cf-cell-arrow">
          <Icon>
            <path d="M3 8h10M9 4l4 4-4 4" />
          </Icon>
        </span>
      </p>
    </li>
  );
}

export function NoMatches(props: { q: string; within?: string; clearHref: string }) {
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">
        No skills{props.within ? ` in ${props.within}` : null} match &ldquo;{props.q}&rdquo;.
      </p>
      <p class="cf-empty-body">Search looks at skill names, descriptions and the text of each SKILL.md.</p>
      <a href={props.clearHref} class="cf-btn cf-btn-outline">Clear search</a>
    </div>
  );
}

export function NoSkillsYet(props: { within?: string; publishHref: string }) {
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">No skills{props.within ? ` in ${props.within}` : null} yet.</p>
      <p class="cf-empty-body">
        Upload a .zip, a .tar.gz or a single SKILL.md from the browser, or send an archive to the API with a token
        from your account.
      </p>
      <a href={props.publishHref} class="cf-btn cf-btn-primary">Publish the first skill</a>
    </div>
  );
}

function EmptyRegistry(props: { user: Viewer | null; q: string }) {
  if (props.q) return <NoMatches q={props.q} clearHref="/" />;
  if (props.user) return <NoSkillsYet publishHref="/new" />;
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">No public skills yet.</p>
      <p class="cf-empty-body">Skills are private until their owner makes them public. Sign in to see the rest.</p>
      <a href="/login" class="cf-btn cf-btn-outline">Sign in</a>
    </div>
  );
}

function HeroLede(props: { user: Viewer | null }) {
  if (!props.user) {
    return (
      <p class="cf-hero-lede">
        This registry serves Agent Skills to the stock <code>npx skills</code> CLI. Every skill has its install command
        on its page, and public skills need no key. <a href="/login">Sign in</a> to see the private ones.
      </p>
    );
  }
  if (props.user.memberships.length === 0) {
    return (
      <p class="cf-hero-lede">
        You are not in a project yet, so you have no install key. Every public skill has its install command on its
        page.
      </p>
    );
  }
  return (
    <p class="cf-hero-lede">
      Each project you are in has your install command on its page, listed under <a href="/projects">Projects</a>, and
      so do its skills.
    </p>
  );
}

export function SearchForm(props: { action: string; q: string }) {
  return (
    <form method="get" action={props.action} class="cf-search" role="search">
      <Icon>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </Icon>
      <label for="q" class="sr-only">Search skills</label>
      <input
        id="q"
        name="q"
        type="search"
        value={props.q}
        placeholder="Search skills"
        class="cf-search-input"
      />
      <button type="submit" class="cf-search-submit">Search</button>
    </form>
  );
}

export function SkillRegistry(props: {
  skills: ListedSkill[];
  q: string;
  clearHref: string;
  showDownloads: boolean;
  empty: unknown;
}) {
  const count = props.skills.length;
  return (
    <section class="cf-page cf-guides cf-registry" aria-labelledby="registry-title">
      <div class="cf-registry-head">
        <h2 id="registry-title" class="cf-registry-title">
          {props.q ? <>Results for &ldquo;{props.q}&rdquo;</> : "Skills"}
        </h2>
        <span class="cf-count">{count}</span>
        {props.q && count > 0 ? <a href={props.clearHref} class="cf-link">Clear search</a> : null}
        <span class="cf-registry-sort">Recently updated first</span>
      </div>
      <div class="cf-frame">
        {count === 0 ? (
          props.empty
        ) : (
          <div class="cf-grid-clip">
            <ul class="cf-grid">
              {props.skills.map((s) => (
                <SkillCell skill={s} showDownloads={props.showDownloads} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export function IndexPage(props: {
  user: Viewer | null;
  skills: ListedSkill[];
  q: string;
}) {
  return (
    <Layout title="Skills" user={props.user} bare>
      <section class="cf-hero" aria-labelledby="hero-title">
        <div class="cf-hero-inner cf-hero-center">
          <h1 id="hero-title" class="cf-hero-title">Find a skill to install</h1>
          <HeroLede user={props.user} />
          <SearchForm action="/" q={props.q} />
        </div>
      </section>

      <SkillRegistry
        skills={props.skills}
        q={props.q}
        clearHref="/"
        showDownloads={props.user !== null}
        empty={<EmptyRegistry user={props.user} q={props.q} />}
      />
    </Layout>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FoldFoot(props: { controls: string }) {
  const t = useT();
  return (
    <footer class="cf-fold-foot" hidden>
      <button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls={props.controls} aria-expanded="false">
        {t.layout.showMore}
      </button>
    </footer>
  );
}

function Downloads(props: { count: number }) {
  const locale = useLocale();
  return <span>{`${formatCount(locale, props.count)} ${props.count === 1 ? "download" : "downloads"}`}</span>;
}

function DownloadIcon() {
  return (
    <Icon>
      <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
    </Icon>
  );
}

function UploadIcon() {
  return (
    <Icon>
      <path d="M8 10.5v-8M4.5 6L8 2.5 11.5 6M3 13.5h10" />
    </Icon>
  );
}

function EditIcon() {
  return (
    <Icon>
      <path d="M10.25 2.75l3 3L6 13H3v-3l7.25-7.25zM8.75 4.25l3 3" />
    </Icon>
  );
}

function GlobeIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2z" />
    </Icon>
  );
}

function LockIcon() {
  return (
    <Icon>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1.5M4 4.5l.6 8.1a1 1 0 001 .9h4.8a1 1 0 001-.9l.6-8.1M6.75 7v4M9.25 7v4" />
    </Icon>
  );
}

function MoveIcon() {
  return (
    <Icon>
      <path d="M2.5 8h8M7.5 4.5L11 8l-3.5 3.5M13.5 3v10" />
    </Icon>
  );
}

function MoveSkill(props: { skill: ListedSkill; targets: Array<{ slug: string; name: string }> }) {
  return (
    <details class="cf-confirm cf-move">
      <summary class="cf-btn cf-btn-ghost">
        <MoveIcon />
        Move
      </summary>
      <div class="cf-confirm-panel">
        <Form action={`${skillPath(props.skill)}/move`} class="cf-stack cf-stack-form">
          <Select label="Move to project" name="project">
            {props.targets.map((p) => (
              <option value={p.slug}>{p.name}</option>
            ))}
          </Select>
          <p class="cf-hint">
            Install keys for {props.skill.project_name} stop reaching {props.skill.slug} at once, keys for the new
            project start to, and its page moves to the new project's address.
          </p>
          <div>
            <Button size="sm">Move {props.skill.slug}</Button>
          </div>
        </Form>
      </div>
    </details>
  );
}

export function SkillPage(props: {
  user: Viewer | null;
  skill: ListedSkill;
  version: VersionRow;
  versions: VersionSummary[];
  origin: string;
  canManage: boolean;
  moveTargets: Array<{ slug: string; name: string }>;
}) {
  const locale = useLocale();
  const { skill, version } = props;
  const files = JSON.parse(version.files) as Array<{ path: string; size: number }>;
  const isLatest = version.version === skill.latest_version;
  const path = skillPath(skill);
  const membership = props.user ? membershipIn(props.user, skill.project) : undefined;
  const base = installBase(props.origin, skill.project, membership?.install_key, skill.visibility === "public");
  return (
    <Layout title={fullName(skill)} user={props.user} bare>
      <section class="cf-hero" aria-labelledby="skill-title">
        <div class="cf-hero-inner cf-hero-start">
          <h1 id="skill-title" class="cf-hero-title cf-skill-title">{fullName(skill)}</h1>
          <p class="cf-hero-lede">{version.description}</p>
          {base ? <CodeBlock raised>npx skills add {`${base}/.well-known/agent-skills/${skill.slug}`}</CodeBlock> : null}
        </div>
      </section>

      <div class="cf-page cf-guides cf-skill-body">
        <div class="cf-frame cf-toolbar">
          <div class="cf-toolbar-group">
            <a href={`${path}/download`} class="cf-btn cf-btn-ghost">
              <DownloadIcon />
              Download zip
            </a>
          </div>
          {props.canManage ? (
            <>
              <div class="cf-toolbar-group">
                <a href={`${path}/edit`} class="cf-btn cf-btn-ghost">
                  <EditIcon />
                  Edit SKILL.md
                </a>
                <a href={`${path}/upload`} class="cf-btn cf-btn-ghost">
                  <UploadIcon />
                  Upload an archive
                </a>
              </div>
              <div class="cf-toolbar-group">
                <Form action={`${path}/visibility`}>
                  {skill.visibility === "public" ? (
                    <Button variant="ghost">
                      <LockIcon />
                      Make private
                    </Button>
                  ) : (
                    <Button variant="ghost">
                      <GlobeIcon />
                      Make public
                    </Button>
                  )}
                </Form>
                {props.moveTargets.length > 0 ? <MoveSkill skill={skill} targets={props.moveTargets} /> : null}
              </div>
              <div class="cf-toolbar-group cf-toolbar-end">
                <ConfirmDelete
                  action={`${path}/delete`}
                  label="Delete"
                  confirm={`Delete ${skill.slug}`}
                  ghost
                  icon={<TrashIcon />}
                >
                  Deleting removes {skill.slug} and all of its versions. It cannot be undone.
                </ConfirmDelete>
              </div>
            </>
          ) : null}
        </div>

        <div class="cf-skill-grid">
          <article class="cf-frame cf-doc" aria-label="SKILL.md">
            <header class="cf-panel-head">
              <span class="cf-chip">SKILL.md</span>
              {isLatest ? (
                <span class="cf-panel-meta">v{version.version}, the latest version</span>
              ) : (
                <span class="cf-panel-meta">
                  Viewing v{version.version}.{" "}
                  <a href={path} class="cf-link">Go to the latest, v{skill.latest_version}</a>
                </span>
              )}
            </header>
            <div id="skill-doc" class="skill-doc" data-fold dangerouslySetInnerHTML={{ __html: version.html }} />
            <FoldFoot controls="skill-doc" />
          </article>

          <aside class="cf-stack-lg">
            <Panel title="Details" flush>
              <dl class="cf-rows">
                <div class="cf-row">
                  <dt class="cf-row-label">Project</dt>
                  <dd class="cf-row-value">
                    <a href={projectPath(skill.project)} class="cf-row-link">{skill.project_name}</a>
                  </dd>
                </div>
                <div class="cf-row">
                  <dt class="cf-row-label">Author</dt>
                  <dd class="cf-row-value">{skill.author}</dd>
                </div>
                <div class="cf-row">
                  <dt class="cf-row-label">Visibility</dt>
                  <dd class="cf-row-value">
                    <Visibility value={skill.visibility} />
                  </dd>
                </div>
                {props.user ? (
                  <div class="cf-row">
                    <dt class="cf-row-label">Downloads</dt>
                    <dd class="cf-row-value">{formatCount(locale, skill.download_count)}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
            <Panel
              title="Files"
              aside={<span class="cf-count">{files.length}</span>}
              foot={<FoldFoot controls="skill-files" />}
              flush
            >
              <ul id="skill-files" class="cf-rows" data-fold>
                {files.map((f) => (
                  <li class="cf-row">
                    <span class="cf-row-main cf-row-path">{f.path}</span>
                    <span class="cf-row-meta">{formatSize(f.size)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel
              title="Versions"
              aside={<span class="cf-count">{props.versions.length}</span>}
              foot={<FoldFoot controls="skill-versions" />}
              flush
            >
              <ul id="skill-versions" class="cf-rows" data-fold>
                {props.versions.map((v) => {
                  const at = new Date(v.created_at);
                  const current = v.version === version.version;
                  return (
                    <li class={current ? "cf-row cf-row-current" : "cf-row"}>
                      <a
                        href={`${path}?v=${v.version}`}
                        class="cf-row-main cf-row-version"
                        aria-current={current ? "page" : undefined}
                      >
                        v{v.version}
                      </a>
                      <time class="cf-row-meta" datetime={at.toISOString()}>{formatStamp(locale, v.created_at)}</time>
                      <a
                        href={`${path}/v/${v.version}/download`}
                        class="cf-icon-link"
                        aria-label={`Download v${v.version}`}
                      >
                        <DownloadIcon />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </aside>
        </div>
      </div>
    </Layout>
  );
}
