import { membershipIn } from "../auth";
import { Form } from "../csrf";
import { useLocale, useT } from "../i18n";
import { formatCount, formatStamp } from "../i18n/format";
import { installBase, projectPath, projectSettingsPath, skillPath } from "../paths";
import { Button, CodeBlock, ConfirmDelete, GlobeIcon, Icon, Layout, Panel, Select } from "./layout";
import type { ListedSkill, SkillRow, VersionRow, VersionSummary, Viewer } from "../db/queries";

function Visibility(props: { value: SkillRow["visibility"] }) {
  const t = useT();
  return props.value === "public" ? (
    <span class="cf-vis cf-vis-public">
      <GlobeIcon />
      {t.skills.public}
    </span>
  ) : (
    <span class="cf-vis cf-vis-private">
      <LockIcon />
      {t.skills.private}
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
  const t = useT();
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">{t.skills.noMatches(props.q, props.within ?? null)}</p>
      <p class="cf-empty-body">{t.skills.searchScope}</p>
      <a href={props.clearHref} class="cf-btn cf-btn-outline">{t.skills.clearSearch}</a>
    </div>
  );
}

export function NoSkillsYet(props: { within?: string; publishHref?: string }) {
  const t = useT();
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">{t.skills.noSkillsYet(props.within ?? null)}</p>
      {props.publishHref ? (
        <>
          <p class="cf-empty-body">{t.skills.publishHow}</p>
          <a href={props.publishHref} class="cf-btn cf-btn-primary">{t.skills.publishFirst}</a>
        </>
      ) : null}
    </div>
  );
}

function EmptyRegistry(props: { user: Viewer | null; q: string }) {
  const t = useT();
  if (props.q) return <NoMatches q={props.q} clearHref="/" />;
  if (props.user) return <NoSkillsYet publishHref="/new" />;
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">{t.skills.noPublic}</p>
      <p class="cf-empty-body">{t.skills.noPublicBody}</p>
      <a href="/login" class="cf-btn cf-btn-outline">{t.layout.signIn}</a>
    </div>
  );
}

function HeroLede(props: { user: Viewer | null }) {
  const t = useT();
  if (!props.user) {
    return (
      <p class="cf-hero-lede">
        {t.skills.heroAnon(<code>npx skillsgist</code>, <a href="/login">{t.layout.signIn}</a>)}
      </p>
    );
  }
  if (props.user.memberships.length === 0) {
    return <p class="cf-hero-lede">{t.skills.heroNoProject}</p>;
  }
  return <p class="cf-hero-lede">{t.skills.heroMember(<a href="/projects">{t.layout.projects}</a>)}</p>;
}

export function SearchForm(props: { action: string; q: string }) {
  const t = useT();
  return (
    <form method="get" action={props.action} class="cf-search" role="search">
      <Icon>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </Icon>
      <label for="q" class="sr-only">{t.skills.search}</label>
      <input
        id="q"
        name="q"
        type="search"
        value={props.q}
        placeholder={t.skills.search}
        class="cf-search-input"
      />
      <button type="submit" class="cf-search-submit">{t.skills.searchButton}</button>
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
  const t = useT();
  const count = props.skills.length;
  return (
    <section class="cf-page cf-guides cf-registry" aria-labelledby="registry-title">
      <div class="cf-registry-head">
        <h2 id="registry-title" class="cf-registry-title">
          {props.q ? t.skills.resultsFor(props.q) : t.skills.title}
        </h2>
        <span class="cf-count">{count}</span>
        {props.q && count > 0 ? <a href={props.clearHref} class="cf-link">{t.skills.clearSearch}</a> : null}
        <span class="cf-registry-sort">{t.skills.sort}</span>
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
  const t = useT();
  return (
    <Layout title={t.skills.title} user={props.user} bare>
      <section class="cf-hero" aria-labelledby="hero-title">
        <div class="cf-hero-inner cf-hero-center">
          <h1 id="hero-title" class="cf-hero-title">{t.skills.hero}</h1>
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
  const t = useT();
  return <span>{t.skills.downloads(props.count, formatCount(locale, props.count))}</span>;
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
  const t = useT();
  return (
    <details class="cf-confirm cf-move">
      <summary class="cf-btn cf-btn-ghost">
        <MoveIcon />
        {t.skills.move}
      </summary>
      <div class="cf-confirm-panel">
        <Form action={`${skillPath(props.skill)}/move`} class="cf-stack cf-stack-form">
          <Select label={t.skills.moveTo} name="project">
            {props.targets.map((p) => (
              <option value={p.slug}>{p.name}</option>
            ))}
          </Select>
          <p class="cf-hint">{t.skills.moveHint(props.skill.project_name, props.skill.slug)}</p>
          <div>
            <Button size="sm">{t.skills.moveSkill(props.skill.slug)}</Button>
          </div>
        </Form>
      </div>
    </details>
  );
}

function skillsgistAdd(url: string) {
  return `skillsgist add ${url}`;
}

function KeyNote(props: { note: unknown }) {
  return props.note ? <p class="cf-install-note">{props.note}</p> : null;
}

function Command(props: { url: string; note: unknown }) {
  return (
    <>
      <CodeBlock raised>npx {skillsgistAdd(props.url)}</CodeBlock>
      <KeyNote note={props.note} />
    </>
  );
}

function Install(props: { url: string; promptUrl: string; slug: string; commandNote: unknown; promptNote: unknown }) {
  const t = useT();
  return (
    <div class="cf-install">
      <fieldset class="cf-install-modes">
        <legend class="sr-only">{t.skills.installWith}</legend>
        <label class="cf-install-mode">
          <input type="radio" name="install-mode" value="command" class="sr-only" aria-controls="install-command" checked />
          {t.skills.installCommand}
        </label>
        <label class="cf-install-mode">
          <input type="radio" name="install-mode" value="prompt" class="sr-only" aria-controls="install-prompt" />
          {t.skills.installPrompt}
        </label>
      </fieldset>
      <div id="install-command" data-mode="command" role="group" aria-label={t.skills.installCommand}>
        <Command url={props.url} note={props.commandNote} />
      </div>
      <div id="install-prompt" data-mode="prompt" role="group" aria-label={t.skills.installPrompt}>
        <CodeBlock raised prompt={false}>
          {t.skills.agentPrompt(`npx -y ${skillsgistAdd(props.promptUrl)} --skill ${props.slug} -g -y`)}
        </CodeBlock>
        <KeyNote note={props.promptNote} />
      </div>
    </div>
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
  const t = useT();
  const { skill, version } = props;
  const files = JSON.parse(version.files) as Array<{ path: string; size: number }>;
  const isLatest = version.version === skill.latest_version;
  const path = skillPath(skill);
  const membership = props.user ? membershipIn(props.user, skill.project) : undefined;
  const isPublic = skill.visibility === "public";
  const base = installBase(props.origin, skill.project, membership?.install_key, isPublic);
  const publicBase = installBase(props.origin, skill.project, undefined, isPublic);
  const address = (from: string) => `${from}/.well-known/agent-skills/${skill.slug}`;
  const settings = <a href={projectSettingsPath(skill.project)}>{t.projects.settings}</a>;
  const commandNote = membership?.install_key ? t.skills.commandKeyNote(skill.project_name, settings) : null;
  return (
    <Layout title={fullName(skill)} user={props.user} bare>
      <section class="cf-hero" aria-labelledby="skill-title">
        <div class="cf-hero-inner cf-hero-start">
          <h1 id="skill-title" class="cf-hero-title cf-skill-title">{fullName(skill)}</h1>
          <p class="cf-hero-lede">{version.description}</p>
          {base === null ? null : isLatest ? (
            <Install
              url={address(base)}
              promptUrl={address(publicBase ?? base)}
              slug={skill.slug}
              commandNote={commandNote}
              promptNote={isPublic ? null : t.skills.promptKeyNote(skill.project_name, settings)}
            />
          ) : (
            <Command url={address(base)} note={commandNote} />
          )}
        </div>
      </section>

      <div class="cf-page cf-guides cf-skill-body">
        <div class="cf-frame cf-toolbar">
          <div class="cf-toolbar-group">
            <a href={`${path}/download`} class="cf-btn cf-btn-ghost">
              <DownloadIcon />
              {t.skills.downloadZip}
            </a>
          </div>
          {props.canManage ? (
            <>
              <div class="cf-toolbar-group">
                <a href={`${path}/edit`} class="cf-btn cf-btn-ghost">
                  <EditIcon />
                  {t.skills.editSkillMd}
                </a>
                <a href={`${path}/upload`} class="cf-btn cf-btn-ghost">
                  <UploadIcon />
                  {t.skills.uploadArchive}
                </a>
              </div>
              <div class="cf-toolbar-group">
                <Form action={`${path}/visibility`}>
                  {skill.visibility === "public" ? (
                    <Button variant="ghost">
                      <LockIcon />
                      {t.skills.makePrivate}
                    </Button>
                  ) : (
                    <Button variant="ghost">
                      <GlobeIcon />
                      {t.skills.makePublic}
                    </Button>
                  )}
                </Form>
                {props.moveTargets.length > 0 ? <MoveSkill skill={skill} targets={props.moveTargets} /> : null}
              </div>
              <div class="cf-toolbar-group cf-toolbar-end">
                <ConfirmDelete
                  action={`${path}/delete`}
                  label={t.skills.delete}
                  confirm={t.skills.deleteSkill(skill.slug)}
                  ghost
                  icon={<TrashIcon />}
                >
                  {t.skills.deleteWarning(skill.slug)}
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
                <span class="cf-panel-meta">{t.skills.latest(version.version)}</span>
              ) : (
                <span class="cf-panel-meta">
                  {t.skills.viewing(version.version)}{" "}
                  <a href={path} class="cf-link">{t.skills.goToLatest(skill.latest_version)}</a>
                </span>
              )}
            </header>
            <div id="skill-doc" class="skill-doc" data-fold dangerouslySetInnerHTML={{ __html: version.html }} />
            <FoldFoot controls="skill-doc" />
          </article>

          <aside class="cf-stack-lg">
            <Panel title={t.skills.details} flush>
              <dl class="cf-rows">
                <div class="cf-row">
                  <dt class="cf-row-label">{t.skills.project}</dt>
                  <dd class="cf-row-value">
                    <a href={projectPath(skill.project)} class="cf-row-link">{skill.project_name}</a>
                  </dd>
                </div>
                <div class="cf-row">
                  <dt class="cf-row-label">{t.skills.author}</dt>
                  <dd class="cf-row-value">{skill.author}</dd>
                </div>
                <div class="cf-row">
                  <dt class="cf-row-label">{t.skills.visibility}</dt>
                  <dd class="cf-row-value">
                    <Visibility value={skill.visibility} />
                  </dd>
                </div>
                {props.user ? (
                  <div class="cf-row">
                    <dt class="cf-row-label">{t.skills.downloadsLabel}</dt>
                    <dd class="cf-row-value">{formatCount(locale, skill.download_count)}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
            <Panel
              title={t.skills.files}
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
              title={t.skills.versions}
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
                        aria-label={t.skills.downloadVersion(v.version)}
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
