---
version: 1
slug: "src-views-downloads-tsx"
primary_target: "src/views/downloads.tsx"
related_targets: ["src/app.css"]
---

# Surface brief: download logs (`/p/:project/s/:slug/downloads`, `/p/:project/downloads`, `/admin/downloads`)

## Scope and mode

- One template, `DownloadsPage` in `src/views/downloads.tsx`, with its styles in `src/app.css`; the skill, project and instance logs all render through it.
- Mode: Operate. The visitor reads usage first (trend, sources, which versions or skills are fetched) and audits single downloads second.

## Audience, job, constraints

- Whoever manages the skill, a project's admins, and instance admins.
- Layout only: no new query parameters, filters or queries. The existing filters (project, skill, account, source) and the 50-row pager stay as they are.
- Server-rendered, no script; CSP forbids inline styles, so proportions are SVG attributes.

## Direction contract

THESIS: A working analytics console. The figures are the source switch, and the chart and breakdown answer "how much, how, which version" before the log.

OWN-WORLD: DESIGN.md unchanged: paper ground, square hairline frames with registration marks, Paper Shade header strips, one Signal Orange for bars and share fills, Red Hat Mono for every count, date and version.

STORY: The visitor sees the 30-day total and its split by source, picks a source to narrow everything, reads the daily trend and the top versions beside it, then scans the log.

FIRST VIEWPORT: Page head; a filter bar frame showing active filter chips or how to add one; one console frame: a row of five figure links (All downloads, then each source with count, share bar and percent; the current one marked), below it a Paper Shade strip over a 2fr chart pane and a 1fr breakdown pane of share bars, the latest version tagged; the log table starts below.

FORM: Console, position 7 on the ordered structure list, dealt as the lead by surface seed bee50936. Signature move: the numbers are the filter. Motion: 200ms tints on figure and bar hover only.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
