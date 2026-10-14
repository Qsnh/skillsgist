import { DOWNLOAD_SOURCES } from "../db/downloads";
import type {
  DownloadBreakdown, DownloadFilter, DownloadLogRow, DownloadShare, DownloadStats, FilterNames,
} from "../db/downloads";
import type { ListedSkill, ProjectRow, Viewer } from "../db/queries";
import { useLocale, useT } from "../i18n";
import { formatCount, formatDate, formatStamp } from "../i18n/format";
import { ADMIN_DOWNLOADS_PATH, projectDownloadsPath, projectPath, skillDownloadsPath, skillPath } from "../paths";
import { DAY_MS } from "../time";
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

export interface DownloadsView {
  path: string;
  name: string | null;
  home: string | null;
  scope: Partial<DownloadFilter>;
  breakdown: DownloadBreakdown;
  skillColumn: "slug" | "full" | null;
}

export function downloadsView(subject: DownloadsSubject): DownloadsView {
  switch (subject.kind) {
    case "skill":
      return {
        path: skillDownloadsPath(subject.skill),
        name: `${subject.skill.project_name}/${subject.skill.slug}`,
        home: skillPath(subject.skill),
        scope: { project: subject.skill.project, skillId: subject.skill.id },
        breakdown: "version",
        skillColumn: null,
      };
    case "project":
      return {
        path: projectDownloadsPath(subject.project.slug),
        name: subject.project.name,
        home: projectPath(subject.project.slug),
        scope: { project: subject.project.slug },
        breakdown: "skill",
        skillColumn: "slug",
      };
    case "all":
      return { path: ADMIN_DOWNLOADS_PATH, name: null, home: null, scope: {}, breakdown: "project", skillColumn: "full" };
  }
}

const NARROWS: Record<DownloadBreakdown, "skillId" | "project" | null> = { version: null, skill: "skillId", project: "project" };

const versionLabel = (version: number | string) => `v${version}`;

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

function Filters(props: { view: DownloadsView; filter: DownloadFilter; names: FilterNames }) {
  const t = useT();
  const { view, filter, names } = props;
  const base = view.path;
  const skill = names.skill && (view.skillColumn === "full" ? `${names.skill.projectName}/${names.skill.slug}` : names.skill.slug);
  const chips: Array<{ label: string; href: string }> = [];
  if (filter.project !== null) {
    chips.push({ label: t.downloads.filterProject(names.project ?? filter.project), href: filterHref(base, filter, { project: null }) });
  }
  if (filter.skillId !== null) {
    chips.push({ label: t.downloads.filterSkill(skill ?? filter.skillId), href: filterHref(base, filter, { skillId: null }) });
  }
  if (filter.userId !== null) {
    chips.push({ label: t.downloads.filterUser(names.user ?? filter.userId), href: filterHref(base, filter, { userId: null }) });
  }
  if (filter.source !== null) {
    chips.push({ label: t.downloads.filterSource(t.downloads.sources[filter.source]), href: filterHref(base, filter, { source: null }) });
  }
  if (chips.length === 0) return null;
  return (
    <div class="cf-filters">
      <span class="cf-label">{t.downloads.filters}</span>
      {chips.map((chip) => (
        <a href={chip.href} class="cf-chip cf-filter" aria-label={t.downloads.removeFilter(chip.label)}>
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

function Summary(props: { base: string; filter: DownloadFilter; stats: DownloadStats; windowDays: number }) {
  const locale = useLocale();
  const t = useT();
  return (
    <Panel title={t.downloads.summary} aside={<span class="cf-panel-meta">{t.downloads.lastDays(props.windowDays)}</span>} flush>
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

function Breakdown(props: { view: DownloadsView; filter: DownloadFilter; shares: DownloadShare[]; windowDays: number }) {
  const locale = useLocale();
  const t = useT();
  const { breakdown, path } = props.view;
  const narrow = NARROWS[breakdown];
  const href = (share: DownloadShare) => (narrow ? filterHref(path, props.filter, { [narrow]: share.key }) : null);
  const label = (share: DownloadShare) => (breakdown === "version" ? versionLabel(share.label) : share.label);
  return (
    <Panel title={t.downloads.top[breakdown]} aside={<span class="cf-panel-meta">{t.downloads.lastDays(props.windowDays)}</span>} flush>
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
                <dt class="cf-row-label">{link ? <a href={link} class="cf-link">{label(share)}</a> : label(share)}</dt>
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
              <td data-label={c.version} class="cf-table-date">{versionLabel(row.version)}</td>
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
                    {row.source === "device" ? <span class="cf-chip cf-user-device">{row.device_name || t.auth.unnamedComputer}</span> : null}
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
  view: DownloadsView;
  filter: DownloadFilter;
  names: FilterNames;
  stats: DownloadStats;
  rows: DownloadLogRow[];
  more: boolean;
  paged: boolean;
  retentionDays: number;
  windowDays: number;
  today: number;
}) {
  const t = useT();
  const { view, filter, stats, rows } = props;
  const base = view.path;
  const title = view.name === null ? t.downloads.title : t.downloads.titleOf(view.name);
  const subjectLink = view.home === null ? null : <a href={view.home} class="cf-link">{view.name}</a>;
  const counts = new Map(stats.byDay.map((d) => [d.day, d.count]));
  const days = Array.from({ length: props.windowDays }, (_, i) => {
    const day = props.today - props.windowDays + 1 + i;
    return { day, count: counts.get(day) ?? 0 };
  });
  const last = rows[rows.length - 1];
  return (
    <Layout title={title} user={props.user}>
      <PageHead title={title}>{t.downloads.lede(subjectLink, props.retentionDays)}</PageHead>
      <Filters view={view} filter={filter} names={props.names} />
      {!props.paged && rows.length === 0 && stats.total === 0 ? (
        <div class="cf-frame cf-empty">
          <p class="cf-empty-title">{t.downloads.empty}</p>
          <p class="cf-empty-body">{t.downloads.emptyBody(props.retentionDays)}</p>
        </div>
      ) : (
        <div class="cf-stack-lg">
          <div class="cf-downloads-summary">
            <Panel title={t.downloads.perDay} aside={<span class="cf-panel-meta">{t.downloads.lastDays(props.windowDays)}</span>}>
              <DayChart days={days} />
            </Panel>
            <Summary base={base} filter={filter} stats={stats} windowDays={props.windowDays} />
            <Breakdown view={view} filter={filter} shares={stats.breakdown} windowDays={props.windowDays} />
          </div>
          {rows.length > 0 ? <LogTable base={base} filter={filter} rows={rows} skillColumn={view.skillColumn} /> : null}
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
