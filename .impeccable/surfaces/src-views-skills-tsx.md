---
version: 1
slug: "src-views-skills-tsx"
primary_target: "src/views/skills.tsx"
related_targets: ["src/views/layout.tsx"]
---

# Surface brief: index page (`/`)

## Scope and mode

- Route `/`, rendered by `IndexPage` in `src/views/skills.tsx`, plus the shared nav and footer in `src/views/layout.tsx`.
- Mode: Operate. Visitors come to find a skill and copy its install command; signed-in members also get the install-everything command.
- Other pages inherit the new nav, footer, ground, and faces only; their bodies keep the old styles until a later pass.

## Audience, job, constraints

- Signed-in members: copy the install-everything command (carries their install key), search, open a skill.
- Anonymous visitors: see only public skills and the bare-origin install command; find the way to sign in.
- No client-side JavaScript. Fonts self-hosted (CSP `default-src 'self'`). No Cloudflare logo or trademarked assets; the style is borrowed, not the brand.
- No invented claims: no counts beyond the real list, no uptime, no customers.

## Chosen direction

User-pinned visual world: Cloudflare (cloudflare.com + developers.cloudflare.com). User-locked structure: A, the orange command panel.

## Direction contract

THESIS: The install command is the hero. One drenched orange panel hands over the single line that installs everything, and the registry sits right under it as a hairline-framed grid. It refuses the stock "search bar over a gray list" admin index.

OWN-WORLD: Cloudflare's current language. Orange #FF5E1F owns the hero panel, dot-matrix texture and a warm glow at its foot. Warm white ground (#FDFDFC / #F9F7F6), ink #171717, warm hairlines #F0E3DE, dashed page gutters, small square corner registration marks on framed blocks, pill buttons, Schibsted Grotesk (stand-in for FT Kunst Grotesk) and Red Hat Mono (stand-in for Apercu Mono) for commands, versions, dates, and tracked visibility labels.

STORY: The visitor understands this is a skills registry installed with the stock `npx skills` CLI, believes one line is all it takes, and copies it or opens a skill.

FIRST VIEWPORT: Nav (64px) with the lowercase wordmark, a REGISTRY tag in Cloudflare's DOCS-tag form, and the actions: Publish as the orange pill plus a no-JS account menu (signed in), or Sign in (anonymous). No link group: the index is the only top-level destination, and every other route is reached through Publish or the account menu. The orange panel sits inset 8px from the viewport edges, about 520px tall at 1440 wide, with a centered headline at 56px, one supporting line, the command in a white rounded box with an orange prompt (clicking selects the whole command, with a muted "Click to select" caption at 1280px and wider), and a translucent search pill below it. The first row's titles and descriptions land above a 900px fold. The primary action is the command itself.

FORM: Orange command panel, position 3 on the ordered structure list, dealt as the lead by surface seed 61383bad. Signature interaction: one click selects the whole command (`user-select: all`), with a caret-blink prompt. Motion grammar: a slow breathing glow at the panel foot and 200ms ease-out warm tints on grid cells, all off under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
