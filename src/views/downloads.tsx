import { DOWNLOAD_SOURCES } from "../db/downloads";
import type {
  DownloadBreakdown, DownloadFilter, DownloadLogRow, DownloadShare, DownloadSource, DownloadStats, FilterNames,
} from "../db/downloads";
import type { ListedSkill, ProjectRow, Viewer } from "../db/queries";
import { useLocale, useT } from "../i18n";
import { formatClock, formatCount, formatDate, formatPercent, formatZone, wholePercents } from "../i18n/format";
import { ADMIN_DOWNLOADS_PATH, projectDownloadsPath, projectPath, skillDownloadsPath, skillPath } from "../paths";
import { DAY_MS } from "../time";
import { Icon, Layout, PageHead } from "./layout";
import { requestPlace } from "./place";

export const CHART_DAYS = 30;

const BAR_WIDTH = 8;
const BAR_GAP = 2;
const PLOT_HEIGHT = 100;
const SHARE_WIDTH = 100;

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
  latest: number | null;
  skillColumn: "slug" | "full" | null;
}

export function downloadsView(subject: DownloadsSubject): DownloadsView {
  switch (subject.kind) {
    case "skill":
      return {
        path: skillDownloadsPath(subject.skill),
        name: `${subject.skill.project_name}/${subject.skill.slug}`,
        home: skillPath(subject.skill),
        scope: { skillId: subject.skill.id },
        breakdown: "version",
        latest: subject.skill.latest_version,
        skillColumn: null,
      };
    case "project":
      return {
        path: projectDownloadsPath(subject.project.slug),
        name: subject.project.name,
        home: projectPath(subject.project.slug),
        scope: { project: subject.project.slug },
        breakdown: "skill",
        latest: null,
        skillColumn: "slug",
      };
    case "all":
      return {
        path: ADMIN_DOWNLOADS_PATH,
        name: null,
        home: null,
        scope: {},
        breakdown: "project",
        latest: null,
        skillColumn: "full",
      };
  }
}

const NARROWS: Record<DownloadBreakdown, "skillId" | "project" | null> = { version: null, skill: "skillId", project: "project" };

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

function breakAfter(text: string, mark: string) {
  return text.split(mark).map((part, i, parts) => (i < parts.length - 1 ? <>{part}{mark}<wbr /></> : part));
}

function CloseIcon() {
  return (
    <Icon>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Icon>
  );
}

function FilterBar(props: { view: DownloadsView; filter: DownloadFilter; names: FilterNames }) {
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
  if (chips.length === 0) {
    return (
      <div class="cf-frame cf-filters">
        <p class="cf-filters-note">
          <span class="cf-filters-label">{t.downloads.filters}</span>{" "}
          {t.downloads.noFilters}
        </p>
      </div>
    );
  }
  return (
    <div class="cf-frame cf-filters">
      <span class="cf-filters-label">{t.downloads.filters}</span>
      {chips.map((chip) => (
        <a href={chip.href} class="cf-chip cf-filter" aria-label={t.downloads.removeFilter(chip.label)}>
          {chip.label}
          <CloseIcon />
        </a>
      ))}
      {chips.length > 1 ? <a href={base} class="cf-link cf-filters-clear">{t.downloads.clearFilters}</a> : null}
    </div>
  );
}

function ShareBar(props: { part: number; whole: number }) {
  const share = props.whole === 0 ? 0 : props.part / props.whole;
  const width = share === 0 ? 0 : Math.max(1, Math.round(share * SHARE_WIDTH * 10) / 10);
  return (
    <svg class="cf-share" viewBox={`0 0 ${SHARE_WIDTH} 4`} preserveAspectRatio="none" aria-hidden="true">
      <rect class="cf-share-track" width={SHARE_WIDTH} height="4" />
      {width > 0 ? <rect class="cf-share-fill" width={width} height="4" /> : null}
    </svg>
  );
}

function Figures(props: { base: string; filter: DownloadFilter; stats: DownloadStats; windowDays: number }) {
  const locale = useLocale();
  const t = useT();
  const { base, filter, stats } = props;
  const picked = filter.source;
  const shares = wholePercents(DOWNLOAD_SOURCES.map((source) => stats.bySource[source]));
  const figures: Array<{ source: DownloadSource | null; label: string; count: number; percent: number }> = [
    { source: null, label: t.downloads.total, count: stats.total, percent: 100 },
    ...DOWNLOAD_SOURCES.map((source, i) => ({ source, label: t.downloads.sources[source], count: stats.bySource[source], percent: shares[i] })),
  ];
  return (
    <nav class="cf-frame cf-figures" aria-label={t.downloads.bySource}>
      {figures.map((figure) => {
        const current = figure.source === picked;
        const counted = picked === null || current;
        return (
          <a
            href={filterHref(base, filter, { source: figure.source })}
            class={figure.source === null ? "cf-figure cf-figure-all" : "cf-figure"}
            aria-current={current ? "true" : undefined}
          >
            <span class="cf-figure-label">{figure.label}</span>
            <span class="cf-figure-value">{counted ? formatCount(locale, figure.count) : "—"}</span>
            <span class="cf-figure-foot">
              {figure.source === null ? (
                picked === null ? t.downloads.lastDays(props.windowDays) : t.downloads.showAll
              ) : picked === null ? (
                <>
                  <ShareBar part={figure.count} whole={stats.total} />
                  <span class="cf-figure-percent">{formatPercent(locale, figure.count, stats.total, figure.percent)}</span>
                </>
              ) : null}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function DayChart(props: { days: Array<{ day: number; count: number }>; peak: number }) {
  const locale = useLocale();
  const t = useT();
  const { days, peak } = props;
  const date = (day: number) => formatDate(locale, day * DAY_MS);
  return (
    <figure class="cf-chart">
      <div class="cf-chart-area">
        <span class="cf-chart-peak" aria-hidden="true">{formatCount(locale, peak)}</span>
        <svg
          class="cf-chart-plot"
          viewBox={`0 0 ${days.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {days.map((d, i) => {
            const height = d.count === 0 ? 1 : Math.max(2, Math.round((d.count / peak) * PLOT_HEIGHT));
            const x = i * (BAR_WIDTH + BAR_GAP);
            return (
              <g class="cf-chart-day">
                <title>{`${date(d.day)} · ${formatCount(locale, d.count)}`}</title>
                <rect class="cf-chart-hit" x={x - BAR_GAP / 2} y="0" width={BAR_WIDTH + BAR_GAP} height={PLOT_HEIGHT} />
                <rect class={d.count === 0 ? "cf-chart-zero" : "cf-chart-bar"} x={x} y={PLOT_HEIGHT - height} width={BAR_WIDTH} height={height} />
              </g>
            );
          })}
        </svg>
      </div>
      <div class="cf-chart-axis" aria-hidden="true">
        <span>{date(days[0].day)}</span>
        <span>{date(days[days.length - 1].day)}</span>
      </div>
      <div class="sr-only">
        <table>
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
      </div>
    </figure>
  );
}

function Shares(props: { view: DownloadsView; filter: DownloadFilter; shares: DownloadShare[]; total: number }) {
  const locale = useLocale();
  const t = useT();
  const { breakdown, path, latest } = props.view;
  const narrow = NARROWS[breakdown];
  const href = (share: DownloadShare) => (narrow ? filterHref(path, props.filter, { [narrow]: share.key }) : null);
  const label = (share: DownloadShare) => (breakdown === "version" ? t.downloads.versionLabel(share.label) : share.label);
  if (props.shares.length === 0) return <p class="cf-shares-none">—</p>;
  return (
    <ol class="cf-shares">
      {props.shares.map((share) => {
        const link = href(share);
        return (
          <li class="cf-share-row">
            <span class="cf-share-name">
              {link ? <a href={link} class="cf-log-link">{label(share)}</a> : <span class="cf-share-label">{label(share)}</span>}
              {latest !== null && share.key === String(latest) ? <span class="cf-tag">{t.downloads.latest}</span> : null}
            </span>
            <span class="cf-share-count">{formatCount(locale, share.count)}</span>
            <span class="cf-share-percent">{formatPercent(locale, share.count, props.total)}</span>
            <ShareBar part={share.count} whole={props.total} />
          </li>
        );
      })}
    </ol>
  );
}

function Console(props: {
  view: DownloadsView;
  filter: DownloadFilter;
  stats: DownloadStats;
  days: Array<{ day: number; count: number }>;
}) {
  const locale = useLocale();
  const t = useT();
  const { view, filter, stats, days } = props;
  const busiest = days.reduce((top, d) => (d.count > top.count ? d : top), days[0]);
  return (
    <div class="cf-frame cf-console">
      <section class="cf-console-pane">
        <header class="cf-panel-head">
          <h2 class="cf-panel-title">{t.downloads.perDay}</h2>
          {busiest.count > 0 ? (
            <span class="cf-panel-meta">
              {t.downloads.busiest(formatCount(locale, busiest.count), formatDate(locale, busiest.day * DAY_MS))}
            </span>
          ) : null}
        </header>
        <DayChart days={days} peak={busiest.count} />
      </section>
      <section class="cf-console-pane">
        <header class="cf-panel-head">
          <h2 class="cf-panel-title">{t.downloads.top[view.breakdown]}</h2>
        </header>
        <Shares view={view} filter={filter} shares={stats.breakdown} total={stats.total} />
      </section>
    </div>
  );
}

function LogTable(props: { base: string; filter: DownloadFilter; rows: DownloadLogRow[]; skillColumn: "slug" | "full" | null }) {
  const locale = useLocale();
  const t = useT();
  const c = t.downloads.columns;
  return (
    <table class="cf-table cf-log-table">
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
            <td class="cf-table-date cf-log-time">
              <time datetime={new Date(row.created_at).toISOString()}>{formatClock(locale, row.created_at)}</time>{" "}
              <span class="cf-log-zone">{formatZone(locale, row.created_at)}</span>
            </td>
            {props.skillColumn ? (
              <td class="cf-log-skill">
                <a href={filterHref(props.base, props.filter, { skillId: row.skill_id })} class="cf-log-link">
                  {props.skillColumn === "full" ? <>{row.project_name}/<wbr />{row.slug}</> : row.slug}
                </a>
              </td>
            ) : null}
            <td class="cf-table-date cf-log-version">{t.downloads.versionLabel(row.version)}</td>
            <td class="cf-log-cell">
              <span class="cf-log-source">
                <a href={filterHref(props.base, props.filter, { source: row.source })} class="cf-log-link">
                  {t.downloads.sources[row.source]}
                </a>
                {row.user_agent ? <span class="cf-log-agent" title={row.user_agent}>{row.user_agent}</span> : null}
              </span>
            </td>
            <td class={row.user_id === null ? "cf-log-cell cf-log-nobody" : "cf-log-cell"}>
              {row.user_id === null ? (
                t.downloads.sources.anonymous
              ) : (
                <span class="cf-user">
                  <a href={filterHref(props.base, props.filter, { userId: row.user_id })} class="cf-log-link cf-user-name">
                    {row.username}
                  </a>
                  {row.source === "device" ? <span class="cf-chip cf-user-device">{row.device_name || t.auth.unnamedComputer}</span> : null}
                </span>
              )}
            </td>
            <td class="cf-log-cell cf-log-from" data-label={c.place}>
              <span class="cf-log-place">
                {requestPlace(t, locale, row.country)}
                {row.ip ? <span class="cf-log-ip">{breakAfter(row.ip, ":")}</span> : null}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Log(props: {
  base: string;
  filter: DownloadFilter;
  rows: DownloadLogRow[];
  skillColumn: "slug" | "full" | null;
  more: boolean;
  paged: boolean;
}) {
  const locale = useLocale();
  const t = useT();
  const { base, filter, rows } = props;
  const last = rows[rows.length - 1];
  return (
    <section class="cf-frame cf-log">
      {rows.length > 0 ? (
        <LogTable base={base} filter={filter} rows={rows} skillColumn={props.skillColumn} />
      ) : (
        <p class="cf-log-none">{t.downloads.pastEnd}</p>
      )}
      <footer class="cf-log-foot">
        {rows.length > 0 ? <p class="cf-log-count">{t.downloads.listed(rows.length, formatCount(locale, rows.length))}</p> : null}
        {props.paged || props.more ? (
          <nav class="cf-pager" aria-label={t.downloads.pages}>
            {props.paged ? <a href={filterHref(base, filter)} class="cf-btn cf-btn-outline cf-btn-sm">{t.downloads.newest}</a> : null}
            {props.more && last ? (
              <a href={filterHref(base, filter, {}, last.id)} class="cf-btn cf-btn-outline cf-btn-sm">
                {t.downloads.older}
              </a>
            ) : null}
          </nav>
        ) : null}
      </footer>
    </section>
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
  const title = view.name === null ? t.downloads.title : t.downloads.titleOf(view.name);
  const subjectLink = view.home === null ? null : <a href={view.home} class="cf-link">{view.name}</a>;
  const counts = new Map(stats.byDay.map((d) => [d.day, d.count]));
  const days = Array.from({ length: props.windowDays }, (_, i) => {
    const day = props.today - props.windowDays + 1 + i;
    return { day, count: counts.get(day) ?? 0 };
  });
  const filtered = filter.project !== null || filter.skillId !== null || filter.userId !== null || filter.source !== null;
  const empty = !props.paged && rows.length === 0 && stats.total === 0;
  return (
    <Layout title={title} user={props.user}>
      <PageHead title={title}>{t.downloads.lede(subjectLink, props.retentionDays)}</PageHead>
      <div class="cf-stack-lg">
        {empty && !filtered ? null : <FilterBar view={view} filter={filter} names={props.names} />}
        {empty ? (
          <div class="cf-frame cf-empty">
            <p class="cf-empty-title">{t.downloads.empty}</p>
            <p class="cf-empty-body">{t.downloads.emptyBody(props.retentionDays)}</p>
          </div>
        ) : (
          <>
            <Figures base={view.path} filter={filter} stats={stats} windowDays={props.windowDays} />
            <Console view={view} filter={filter} stats={stats} days={days} />
            <Log base={view.path} filter={filter} rows={rows} skillColumn={view.skillColumn} more={props.more} paged={props.paged} />
          </>
        )}
      </div>
    </Layout>
  );
}
