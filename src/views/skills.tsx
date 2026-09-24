import { Form } from "../csrf";
import { Button, CodeBlock, ConfirmDelete, Icon, Layout, Panel } from "./layout";
import type { SkillRow, UserRow, VersionRow, VersionSummary } from "../db/queries";

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

function SkillCell(props: { skill: SkillRow & { author: string } }) {
  const s = props.skill;
  return (
    <li class="cf-cell">
      <div class="cf-cell-head">
        <h3 class="cf-cell-title">
          <a href={`/s/${s.slug}`} class="cf-cell-link">{s.slug}</a>
        </h3>
        <Visibility value={s.visibility} />
      </div>
      <p class="cf-cell-desc">{s.description}</p>
      <p class="cf-cell-meta">
        <span>{s.author}</span>
        <span class="cf-cell-arrow">
          <Icon>
            <path d="M3 8h10M9 4l4 4-4 4" />
          </Icon>
        </span>
      </p>
    </li>
  );
}

function EmptyRegistry(props: { user: UserRow | null; q: string }) {
  if (props.q) {
    return (
      <div class="cf-empty">
        <p class="cf-empty-title">No skills match &ldquo;{props.q}&rdquo;.</p>
        <p class="cf-empty-body">Search looks at skill names, descriptions and the text of each SKILL.md.</p>
        <a href="/" class="cf-btn cf-btn-outline">Clear search</a>
      </div>
    );
  }
  if (props.user) {
    return (
      <div class="cf-empty">
        <p class="cf-empty-title">No skills yet.</p>
        <p class="cf-empty-body">
          Upload a .zip, a .tar.gz or a single SKILL.md from the browser, or send an archive to the API with a token
          from your account.
        </p>
        <a href="/new" class="cf-btn cf-btn-primary">Publish the first skill</a>
      </div>
    );
  }
  return (
    <div class="cf-empty">
      <p class="cf-empty-title">No public skills yet.</p>
      <p class="cf-empty-body">Skills are private until their owner makes them public. Sign in to see the rest.</p>
      <a href="/login" class="cf-btn cf-btn-outline">Sign in</a>
    </div>
  );
}

export function IndexPage(props: {
  user: UserRow | null;
  skills: Array<SkillRow & { author: string }>;
  q: string;
  origin: string;
}) {
  const address = props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin;
  const count = props.skills.length;
  const fillWide = (3 - (count % 3)) % 3;
  const fillMid = count % 2;
  return (
    <Layout title="Skills" user={props.user} bare>
      <section class="cf-hero" aria-labelledby="hero-title">
        <div class="cf-hero-inner">
          <h1 id="hero-title" class="cf-hero-title">
            {props.user ? "Install every skill with one command" : "Install public skills with one command"}
          </h1>
          {props.user ? (
            <p class="cf-hero-lede">
              The address carries your install key, so private skills come along. The key can only install; reset it
              from <a href="/me">your account</a> if it leaks.
            </p>
          ) : (
            <p class="cf-hero-lede">
              This registry serves Agent Skills to the stock <code>npx skills</code> CLI. Public skills need no key.{" "}
              <a href="/login">Sign in</a> to see the private ones.
            </p>
          )}
          <CodeBlock raised>npx skills add {address}</CodeBlock>
          <form method="get" action="/" class="cf-search" role="search">
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
        </div>
      </section>

      <section class="cf-page cf-guides cf-registry" aria-labelledby="registry-title">
        <div class="cf-registry-head">
          <h2 id="registry-title" class="cf-registry-title">
            {props.q ? <>Results for &ldquo;{props.q}&rdquo;</> : "Skills"}
          </h2>
          <span class="cf-count">{count}</span>
          {props.q && count > 0 ? <a href="/" class="cf-link">Clear search</a> : null}
          <span class="cf-registry-sort">Recently updated first</span>
        </div>
        <div class="cf-frame">
          {count === 0 ? (
            <EmptyRegistry user={props.user} q={props.q} />
          ) : (
            <div class="cf-grid-clip">
              <ul class="cf-grid">
                {props.skills.map((s) => (
                  <SkillCell skill={s} />
                ))}
                {fillWide ? <li class={`cf-cell-fill cf-fill-wide cf-span-${fillWide}`} aria-hidden="true" /> : null}
                {fillMid ? <li class="cf-cell-fill cf-fill-mid" aria-hidden="true" /> : null}
              </ul>
            </div>
          )}
        </div>
      </section>
    </Layout>
  );
}

const STAMP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FoldFoot(props: { controls: string }) {
  return (
    <footer class="cf-fold-foot" hidden>
      <button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls={props.controls} aria-expanded="false">
        Show more
      </button>
    </footer>
  );
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

export function SkillPage(props: {
  user: UserRow | null;
  skill: SkillRow & { author: string };
  version: VersionRow;
  versions: VersionSummary[];
  origin: string;
  canManage: boolean;
}) {
  const { skill, version } = props;
  const files = JSON.parse(version.files) as Array<{ path: string; size: number }>;
  const isLatest = version.version === skill.latest_version;
  const base = props.user ? `${props.origin}/i/${props.user.install_key}` : props.origin;
  const url = `${base}/.well-known/agent-skills/${skill.slug}`;
  return (
    <Layout title={skill.slug} user={props.user} bare>
      <section class="cf-hero cf-hero-compact" aria-labelledby="skill-title">
        <div class="cf-hero-inner cf-hero-start">
          <h1 id="skill-title" class="cf-hero-title cf-skill-title">{skill.slug}</h1>
          <p class="cf-hero-lede">{version.description}</p>
          <p class="cf-hero-meta">
            <span>{skill.author}</span>
            <Visibility value={skill.visibility} />
          </p>
          <CodeBlock raised>npx skills add {url}</CodeBlock>
          {props.user ? (
            <p class="cf-hero-note">This command carries your install key, so it can install private skills.</p>
          ) : skill.visibility === "public" ? (
            <p class="cf-hero-note">This is the public address. Anyone can use it.</p>
          ) : null}
        </div>
      </section>

      <div class="cf-page cf-guides cf-skill-body">
        <div class="cf-frame cf-toolbar">
          <div class="cf-toolbar-group">
            <a href={`/s/${skill.slug}/download`} class="cf-btn cf-btn-ghost">
              <DownloadIcon />
              Download zip
            </a>
          </div>
          {props.canManage ? (
            <>
              <div class="cf-toolbar-group">
                <a href={`/s/${skill.slug}/edit`} class="cf-btn cf-btn-ghost">
                  <EditIcon />
                  Edit SKILL.md
                </a>
                <a href={`/s/${skill.slug}/upload`} class="cf-btn cf-btn-ghost">
                  <UploadIcon />
                  Upload an archive
                </a>
              </div>
              <Form action={`/s/${skill.slug}/visibility`} class="cf-toolbar-group">
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
              <div class="cf-toolbar-group cf-toolbar-end">
                <ConfirmDelete
                  action={`/s/${skill.slug}/delete`}
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
                  <a href={`/s/${skill.slug}`} class="cf-link">Go to the latest, v{skill.latest_version}</a>
                </span>
              )}
            </header>
            <div id="skill-doc" class="skill-doc" data-fold dangerouslySetInnerHTML={{ __html: version.html }} />
            <FoldFoot controls="skill-doc" />
          </article>

          <aside class="cf-skill-aside">
            <Panel
              title="Files"
              aside={<span class="cf-count">{files.length}</span>}
              foot={<FoldFoot controls="skill-files" />}
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
            >
              <ul id="skill-versions" class="cf-rows" data-fold>
                {props.versions.map((v) => {
                  const at = new Date(v.created_at);
                  const current = v.version === version.version;
                  return (
                    <li class={current ? "cf-row cf-row-current" : "cf-row"}>
                      <a
                        href={`/s/${skill.slug}?v=${v.version}`}
                        class="cf-row-main cf-row-version"
                        aria-current={current ? "page" : undefined}
                      >
                        v{v.version}
                      </a>
                      <time class="cf-row-meta" datetime={at.toISOString()}>{STAMP.format(at)}</time>
                      <a
                        href={`/s/${skill.slug}/v/${v.version}/download`}
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
