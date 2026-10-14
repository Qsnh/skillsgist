import { DOWNLOAD_SOURCES } from "../db/downloads";
import type { DownloadFilter, DownloadLogRow, DownloadShare, DownloadStats } from "../db/downloads";
import type { ListedSkill, ProjectRow, Viewer } from "../db/queries";
import { useLocale, useT } from "../i18n";
import { formatCount, formatDate, formatStamp } from "../i18n/format";
import { ADMIN_DOWNLOADS_PATH, projectDownloadsPath, projectPath, skillDownloadsPath, skillPath } from "../paths";
import { DAY_MS } from "../retention";
import { Icon, Layout, PageHead, Panel } from "./layout";
import { requestPlace } from "./place";

export const CHART_DAYS = 30;

const BAR_WIDTH = 8;
const BAR_GAP = 2;
const PLOT_HEIGHT = 100;

export type DownloadsSubject =
  | { kind: "skill"; skill: ListedSkill }
  | { kind: "project"; project: ProjectRow }
  | { kind: "all" };

export function subjectPath(subject: DownloadsSubject): string {
  switch (subject.kind) {
    case "skill":
      return skillDownloadsPath(subject.skill);
    case "project":
      return projectDownloadsPath(subject.project.slug);
    case "all":
      return ADMIN_DOWNLOADS_PATH;
  }
}

export function filterHref(
  base: string,
  filter: DownloadFilter,
  change: Partial<DownloadFilter> = {},
  before: number | null = null,
): string {
  const next = { ...filter, ...change };
  const params = new URLSearchParams();
  if (next.project !== null) params.set("project", next.project);
  if (next.skillId !== null) params.set("skill", next.skillId);
  if (next.userId !== null) params.set("user", next.userId);
  if (next.source !== null) params.set("source", next.source);
  if (before !== null) params.set("before", String(before));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function CloseIcon() {
  return (
    <Icon>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Icon>
  );
}

function Filters(props: { base: string; filter: DownloadFilter; first: DownloadLogRow | undefined }) {
  const t = useT();
  const { base, filter, first } = props;
  const chips: Array<{ label: string; href: string }> = [];
  if (filter.project !== null) {
    chips.push({ label: t.downloads.filterProject(first?.project_name ?? filter.project), href: filterHref(base, filter, { project: null }) });
  }
  if (filter.skillId !== null) {
    chips.push({ label: t.downloads.filterSkill(first?.slug ?? filter.skillId), href: filterHref(base, filter, { skillId: null }) });
  }
  if (filter.userId !== null) {
    chips.push({ label: t.downloads.filterUser(first?.username ?? filter.userId), href: filterHref(base, filter, { userId: null }) });
  }
  if (filter.source !== null) {
    chips.push({ label: t.downloads.filterSource(t.downloads.sources[filter.source]), href: filterHref(base, filter, { source: null }) });
  }
  if (chips.length === 0) return null;
  return (
    <div class="cf-filters">
      <span class="cf-label">{t.downloads.filters}</span>
      {chips.map((chip) => (
        <a href={chip.href} class="cf-tag cf-filter" aria-label={t.downloads.removeFilter(chip.label)}>
          {chip.label}
          <CloseIcon />
        </a>
      ))}
      {chips.length > 1 ? <a href={base} class="cf-link">{t.downloads.clearFilters}</a> : null}
    </div>
  );
}

function DayChart(props: { days: Array<{ day: number; count: number }> }) {
  const locale = useLocale();
  const t = useT();
  const { days } = props;
  const peak = Math.max(0, ...days.map((d) => d.count));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const date = (day: number) => formatDate(locale, day * DAY_MS);
  return (
    <figure class="cf-chart">
      <svg
        class="cf-chart-plot"
        viewBox={`0 0 ${days.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {days.map((d, i) => {
          const height = d.count === 0 ? 1 : Math.max(2, Math.round((d.count / peak) * PLOT_HEIGHT));
          return (
            <rect
              class={d.count === 0 ? "cf-chart-zero" : "cf-chart-bar"}
              x={i * (BAR_WIDTH + BAR_GAP)}
              y={PLOT_HEIGHT - height}
              width={BAR_WIDTH}
              height={height}
            />
          );
        })}
      </svg>
      <div class="cf-chart-axis" aria-hidden="true">
        <span>{date(days[0].day)}</span>
        <span>{date(days[days.length - 1].day)}</span>
      </div>
      <p class="cf-hint">{t.downloads.chart(formatCount(locale, total), formatCount(locale, peak))}</p>
      <table class="sr-only">
        <caption>{t.downloads.perDay}</caption>
        <tbody>
          {days.map((d) => (
            <tr>
              <th scope="row">{date(d.day)}</th>
              <td>{formatCount(locale, d.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Summary(props: { base: string; filter: DownloadFilter; stats: DownloadStats }) {
  const locale = useLocale();
  const t = useT();
  return (
    <Panel title={t.downloads.summary} aside={<span class="cf-panel-meta">{t.downloads.last30}</span>} flush>
      <dl class="cf-rows">
        <div class="cf-row">
          <dt class="cf-row-label">{t.downloads.total}</dt>
          <dd class="cf-row-value">{formatCount(locale, props.stats.total)}</dd>
        </div>
        {DOWNLOAD_SOURCES.map((source) => (
          <div class="cf-row">
            <dt class="cf-row-label">
              <a href={filterHref(props.base, props.filter, { source })} class="cf-link">{t.downloads.sources[source]}</a>
            </dt>
            <dd class="cf-row-value">{formatCount(locale, props.stats.bySource[source])}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Breakdown(props: { subject: DownloadsSubject; base: string; filter: DownloadFilter; shares: DownloadShare[] }) {
  const locale = useLocale();
  const t = useT();
  const { subject } = props;
  const title =
    subject.kind === "skill" ? t.downloads.byVersion : subject.kind === "project" ? t.downloads.topSkills : t.downloads.byProject;
  const href = (share: DownloadShare): string | null => {
    if (subject.kind === "project") return filterHref(props.base, props.filter, { skillId: share.key });
    if (subject.kind === "all") return filterHref(props.base, props.filter, { project: share.key });
    return null;
  };
  return (
    <Panel title={title} aside={<span class="cf-panel-meta">{t.downloads.last30}</span>} flush>
      {props.shares.length === 0 ? (
        <div class="cf-panel-body">
          <p class="cf-hint">—</p>
        </div>
      ) : (
        <dl class="cf-rows">
          {props.shares.map((share) => {
            const link = href(share);
            return (
              <div class="cf-row">
                <dt class="cf-row-label">{link ? <a href={link} class="cf-link">{share.label}</a> : share.label}</dt>
                <dd class="cf-row-value">{formatCount(locale, share.count)}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </Panel>
  );
}

function LogTable(props: { base: string; filter: DownloadFilter; rows: DownloadLogRow[]; skillColumn: "slug" | "full" | null }) {
  const locale = useLocale();
  const t = useT();
  const c = t.downloads.columns;
  return (
    <div class="cf-frame cf-table-frame">
      <table class="cf-table">
        <thead>
          <tr>
            <th scope="col">{c.time}</th>
            {props.skillColumn ? <th scope="col">{c.skill}</th> : null}
            <th scope="col">{c.version}</th>
            <th scope="col">{c.source}</th>
            <th scope="col">{c.account}</th>
            <th scope="col">{c.place}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr>
              <td data-label={c.time} class="cf-table-date">{formatStamp(locale, row.created_at)}</td>
              {props.skillColumn ? (
                <td data-label={c.skill}>
                  <a href={filterHref(props.base, props.filter, { skillId: row.skill_id })} class="cf-link">
                    {props.skillColumn === "full" ? `${row.project_name}/${row.slug}` : row.slug}
                  </a>
                </td>
              ) : null}
              <td data-label={c.version} class="cf-table-date">{`v${row.version}`}</td>
              <td data-label={c.source}>
                <a href={filterHref(props.base, props.filter, { source: row.source })} class="cf-link">
                  {t.downloads.sources[row.source]}
                </a>
              </td>
              <td data-label={c.account}>
                {row.user_id === null ? (
                  t.downloads.sources.anonymous
                ) : (
                  <span class="cf-user">
                    <a href={filterHref(props.base, props.filter, { userId: row.user_id })} class="cf-link cf-user-name">
                      {row.username}
                    </a>
                    {row.source === "device" ? <span class="cf-tag">{row.device_name || t.auth.unnamedComputer}</span> : null}
                  </span>
                )}
              </td>
              <td data-label={c.place}>{requestPlace(t, locale, row.country)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DownloadsPage(props: {
  user: Viewer;
  subject: DownloadsSubject;
  filter: DownloadFilter;
  stats: DownloadStats;
  rows: DownloadLogRow[];
  more: boolean;
  paged: boolean;
  retentionDays: number;
  today: number;
}) {
  const t = useT();
  const { subject, filter, stats, rows } = props;
  const base = subjectPath(subject);
  const name =
    subject.kind === "skill"
      ? `${subject.skill.project_name}/${subject.skill.slug}`
      : subject.kind === "project"
        ? subject.project.name
        : null;
  const title = name === null ? t.downloads.title : t.downloads.titleOf(name);
  const subjectLink =
    subject.kind === "skill" ? (
      <a href={skillPath(subject.skill)} class="cf-link">{name}</a>
    ) : subject.kind === "project" ? (
      <a href={projectPath(subject.project.slug)} class="cf-link">{name}</a>
    ) : null;
  const counts = new Map(stats.byDay.map((d) => [d.day, d.count]));
  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const day = props.today - CHART_DAYS + 1 + i;
    return { day, count: counts.get(day) ?? 0 };
  });
  const last = rows[rows.length - 1];
  const skillColumn = subject.kind === "skill" ? null : subject.kind === "project" ? "slug" : "full";
  return (
    <Layout title={title} user={props.user}>
      <PageHead title={title}>{t.downloads.lede(subjectLink, props.retentionDays)}</PageHead>
      <Filters base={base} filter={filter} first={rows[0]} />
      {rows.length === 0 && stats.total === 0 ? (
        <div class="cf-frame cf-empty">
          <p class="cf-empty-title">{t.downloads.empty}</p>
          <p class="cf-empty-body">{t.downloads.emptyBody(props.retentionDays)}</p>
        </div>
      ) : (
        <div class="cf-stack-lg">
          <div class="cf-downloads-summary">
            <Panel title={t.downloads.perDay} aside={<span class="cf-panel-meta">{t.downloads.last30}</span>}>
              <DayChart days={days} />
            </Panel>
            <Summary base={base} filter={filter} stats={stats} />
            <Breakdown subject={subject} base={base} filter={filter} shares={stats.breakdown} />
          </div>
          {rows.length > 0 ? <LogTable base={base} filter={filter} rows={rows} skillColumn={skillColumn} /> : null}
          {props.paged || props.more ? (
            <nav class="cf-pager" aria-label={t.downloads.pages}>
              {props.paged ? <a href={filterHref(base, filter)} class="cf-btn cf-btn-outline cf-btn-sm">{t.downloads.newest}</a> : null}
              {props.more && last ? (
                <a href={filterHref(base, filter, {}, last.id)} class="cf-btn cf-btn-outline cf-btn-sm cf-pager-older">
                  {t.downloads.older}
                </a>
              ) : null}
            </nav>
          ) : null}
          <p class="cf-hint">{t.downloads.kept(props.retentionDays)}</p>
        </div>
      )}
    </Layout>
  );
}
