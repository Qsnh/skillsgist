# Contributing

Issues and pull requests are welcome. [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md) record the product decisions and the design system.

## How it works

```mermaid
flowchart LR
  cli["npx skillsgist add"] -- "GET /p/:project/.well-known/agent-skills/index.json\nAuthorization: Bearer" --> worker
  login["npx skillsgist login"] -- "/api/oauth/*" --> worker
  browser["Browser"] -- "HTML pages and forms" --> worker
  ci["CI / curl"] -- "PUT /api/projects/:project/skills/:name" --> worker
  worker["Cloudflare Worker<br/>(Hono)"] --> d1[("D1<br/>accounts, projects, skills, versions")]
  worker --> r2[("R2<br/>one zip per version")]
```

The Worker renders every page on the server and serves the discovery index the CLI reads. D1 holds accounts, projects and their members, skills, versions and the search text. R2 holds one zip per version, addressed by the digest the index hands to the CLI.

```
src/
  index.ts        app entry and middleware
  routes/         registry, publishing, skill pages, accounts
  views/          server-rendered pages (hono/jsx)
  skills/         archive reading and normalization
  db/queries.ts   D1 access
  render/         SKILL.md to HTML
migrations/       D1 schema
public/           static assets and fonts
scripts/          verify-cli, reset-password, logo export and test fixture tools
test/             unit and integration tests
```

## Development

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787/setup` to create a local admin.

```bash
npm test
npm run typecheck
npm run verify:cli
```

`npm run verify:cli` uses the published CLI; set `SKILLSGIST_CLI="node ../skillsgist-cli/dist/cli.js"` to test a local build, and quote a path that has spaces, as in `SKILLSGIST_CLI='node "../my cli/dist/cli.js"'`.

## Logo and images

`scripts/logo.html` draws the mark on a canvas and previews it at every size. `npm run logo` renders that page in headless Chrome and writes `public/logo.png` (144px, so the 48px mark in the sign-in frame is sharp at 3x; shown at 24px in the nav, 18px in the footer and 48px in the sign-in frame), `public/favicon.png` (64px), `public/favicon.ico` (16, 32 and 48px, for requests that never read a page), `public/apple-touch-icon.png` (180px, square, with the cuts and keyhole filled Paper (#fdfdfc) because iOS turns transparency black) and `docs/images/logo.png` (256px, for the README), and captures `scripts/social-preview.html` twice: as `docs/images/social-preview.png` (1280×640, for GitHub) and, without its command box, as `public/og.png` (1200×630, the `og:image` of every page). Change the drawing, then rerun it; never edit the images by hand.

## Pull requests

Before opening a pull request, run `npm run typecheck` and `npm test`, and run `npm run verify:cli` as well if you touched the registry or publishing code.
