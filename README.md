# skillsgist

A private Agent Skills registry you self-host on Cloudflare. Manage skills in the browser, install them with the stock `npx skills add`.

[![CI](https://github.com/Qsnh/skillsgist/actions/workflows/ci.yml/badge.svg)](https://github.com/Qsnh/skillsgist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Qsnh/skillsgist)

![The skillsgist home page: an install command that carries the install key, a search box, and the skill list](docs/images/home.png)

skillsgist gives a team one place to keep its [Agent Skills](https://skills.sh). You upload a skill in the browser; everyone on the team installs it with the same `npx skills add` they already use. There is no custom CLI, plugin or fork, and nothing is published to a shared public registry. The Worker, the database, the storage bucket and the credentials all live in your own Cloudflare account.

## Why skillsgist

- **Private by default.** A new skill is visible only to accounts on your instance. Making one public is a deliberate switch on that one skill.
- **The stock CLI is the client.** skillsgist serves the skills.sh discovery protocol (`/.well-known/agent-skills/index.json`) directly. `npm run verify:cli` checks this end to end against the real `npx skills` binary.
- **Your infrastructure, nearly free.** One Worker, one D1 database and one R2 bucket. The default limits fit the Workers Free plan.
- **Managed from the browser.** Publishing, editing, versions, visibility and accounts are all web pages. There is no config file to maintain.

## Features

- Publish a `.zip`, a `.tar.gz` or a single `SKILL.md`, from the browser or from a script
- Edit `SKILL.md` in the browser while the skill's other files carry over unchanged
- Immutable, numbered versions; every version stays viewable and downloadable, and republishing an older version's content rolls back
- Content-addressed artifacts, so the CLI can verify every download against its digest
- A download count on every skill, shown to signed-in users. Each archive the CLI or a browser downloads adds one; index fetches and page views do not. `npx skills add` pointed at a whole index downloads every skill it lists, even the ones it does not install, so each of them counts once
- Rendered `SKILL.md` pages with a file list and version history
- Search across skill names, descriptions and body text
- Per-user install keys that can only install, and API tokens for publishing from CI
- Two roles, admin and member, with account administration in the browser
- Server-rendered pages that work without JavaScript, under a strict Content-Security-Policy

![A skill page: the install command for one skill, actions, the rendered SKILL.md, its files and its versions](docs/images/skill.png)

## Deploy

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Qsnh/skillsgist)

The button walks you through the whole deploy:

1. Cloudflare copies this repository into your GitHub or GitLab account.
2. It creates the D1 database and the R2 bucket.
3. It asks for `SESSION_SECRET`. Paste a long random value, such as the output of `openssl rand -hex 32`.
4. It builds the project, applies the database migrations and deploys the Worker.

When it finishes, open `/setup` on the new Worker's URL to create the first admin. The copy is connected to Workers Builds, so every push to it deploys again.

### With Wrangler

You need Node.js 22 or later and a Cloudflare account.

```bash
git clone https://github.com/Qsnh/skillsgist.git
cd skillsgist
npm install
npx wrangler login

npx wrangler d1 create skillsgist        # put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create skillsgist
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET

npm run deploy                           # applies migrations, builds the CSS, deploys
```

Then open `https://<your-worker>/setup` to create the first admin. The page switches itself off as soon as any user exists.

To serve the instance on your own domain, add a route to `wrangler.jsonc` and deploy again. No code changes are needed:

```jsonc
"routes": [{ "pattern": "skills.example.com", "custom_domain": true }]
```

## Install skills

Every signed-in page shows an install command with your install key in it, and `/me` shows the key itself. The examples below use `skills.example.com` as the instance's address.

```bash
# Every skill on the instance, public and private
npx skills add https://skills.example.com/i/<install_key>

# One skill
npx skills add https://skills.example.com/i/<install_key>/.well-known/agent-skills/<skill-name>

# Public skills need no key
npx skills add https://skills.example.com
npx skills add https://skills.example.com/.well-known/agent-skills/<skill-name>

# Or let the CLI pick one skill out of the whole index
npx skills add https://skills.example.com -s <skill-name>
```

An install key can only install. Whoever holds it cannot sign in, publish or delete, and you can rotate it from `/me` in one click.

## Publish skills

A skill is a directory with a `SKILL.md` at its root. The `name` in its frontmatter becomes the skill's address; it must be 1–64 lowercase letters, digits and single hyphens. The `description` must be non-empty and at most 1024 characters.

```markdown
---
name: release-notes
description: Draft release notes from merged pull requests, in the team's house style.
---

# Release notes
...
```

### From the browser

- `/new` takes a `.zip`, a `.tar.gz` or a bare `SKILL.md`. A single wrapper directory is stripped, and junk files such as `.DS_Store` are dropped.
- `/s/<name>/edit` changes only the `SKILL.md` text and carries every other file over from the previous version.
- `/s/<name>/upload` replaces the whole archive.

These pages refuse content that is identical to the latest version. Content identical to an *older* version publishes normally, which is how you roll back.

### From a terminal or CI

Generate an API token on `/me`. It is shown once, and it travels only in the `Authorization` header, never in a URL.

```bash
cd my-skill
zip -r - . | curl --fail-with-body -sS -X PUT --data-binary @- \
  -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
  -H "Content-Type: application/zip" \
  https://skills.example.com/api/skills/my-skill
```

- The name in the URL must match the `name` in `SKILL.md`.
- The body can be a zip, a gzipped tarball or a bare `SKILL.md`; the format is read from the bytes. Always send a `Content-Type` such as `application/zip`, `application/gzip` or `text/markdown`. Without one, curl labels the body as a form submission, and the server refuses it with `403`.
- Add `?visibility=public` or `?visibility=private` to set visibility in the same call. Without it, a new skill starts private and an existing skill keeps its current visibility.
- The API is idempotent. A new version answers `201`; content identical to the latest version answers `200` with `"unchanged": true` and still applies `visibility`. Errors answer JSON of the form `{ "error": "...", "message": "..." }`.

Because an unchanged upload is a no-op, CI can republish on every push. For example, with GitHub Actions:

```yaml
name: Publish skill

on:
  push:
    branches: [main]
    paths: ["skills/release-notes/**"]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Publish to skillsgist
        working-directory: skills/release-notes
        env:
          SKILLSGIST_TOKEN: ${{ secrets.SKILLSGIST_TOKEN }}
        run: |
          zip -r - . | curl --fail-with-body -sS -X PUT --data-binary @- \
            -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
            -H "Content-Type: application/zip" \
            https://skills.example.com/api/skills/release-notes
```

## Accounts and roles

An instance has two roles:

- **Members** browse and install every skill, publish new skills, and manage the skills they own.
- **Admins** can also manage every skill and every account.

`/admin/users` lists accounts. From there an admin can switch roles, reset passwords, rotate install keys, revoke API tokens and delete accounts; `/admin/users/new` creates them. The last remaining admin can never be demoted or deleted.

**Deleting an account reassigns its skills and the author records on its versions to the admin who deletes it**, because neither may point at a user that no longer exists. The original authorship is lost.

To withdraw someone's access and keep their authorship, reset their password, rotate their install key and revoke their API token. The key and token stop working at once. A browser that is already signed in, however, keeps its session until it expires, up to 30 days after sign-in. To end every session immediately, delete the account instead, or rotate `SESSION_SECRET`, which signs out everyone.

## Security model

- **The install key sits in the URL.** `npx skills` sends no custom headers, so the credential for a private install can only live in the path. That is why the key can do nothing but install, and why it rotates in one click.
- **API tokens live only in a header.** `/api/*` reads `Authorization: Bearer` and never the session cookie, so a browser cannot be tricked into publishing on someone's behalf. Tokens are stored as hashes.
- **Web forms carry a CSRF token** bound to the session, on top of an `Origin` check.
- **Sessions are signed cookies**, HMAC-signed with `SESSION_SECRET` and valid for 30 days. Passwords are hashed with PBKDF2.
- **Every page is served with a Content-Security-Policy** that allows only same-origin scripts and forbids framing.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limits

An upload may be at most 2 MB, unpack to at most 8 MB, and contain at most 200 files. These limits keep each request inside the Workers Free plan's 10 ms CPU budget. On Workers Paid you can raise `MAX_UPLOAD_BYTES`, `MAX_UNPACKED_BYTES` and `MAX_FILES` in `src/skills/normalize.ts`, and `PBKDF2_ITERATIONS` in `src/auth.ts`.

## Upgrade

With Wrangler, pull and deploy. `npm run deploy` applies any new migrations first:

```bash
git pull
npm install
npm run deploy
```

If you deployed with the button, your copy is a separate repository rather than a fork. Merge this repository into it and push; Workers Builds deploys again and applies any new migrations. Keep the `database_id` that Cloudflare wrote into your `wrangler.jsonc` if the merge touches it.

```bash
git remote add upstream https://github.com/Qsnh/skillsgist.git
git fetch upstream
git merge upstream/main    # the first time, Git may ask for --allow-unrelated-histories
git push
```

## How it works

```mermaid
flowchart LR
  cli["npx skills add"] -- "GET /i/:key/.well-known/agent-skills/index.json" --> worker
  browser["Browser"] -- "HTML pages and forms" --> worker
  ci["CI / curl"] -- "PUT /api/skills/:name" --> worker
  worker["Cloudflare Worker<br/>(Hono)"] --> d1[("D1<br/>accounts, skills, versions")]
  worker --> r2[("R2<br/>one zip per version")]
```

The Worker renders every page on the server and serves the discovery index the CLI reads. D1 holds accounts, skills, versions, download counts and the search text. R2 holds one zip per version, addressed by the digest the index hands to the CLI.

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
scripts/          verify-cli and test fixture tools
test/             unit and integration tests
```

## Development

`wrangler dev` reads secrets from `.dev.vars`, which `.gitignore` excludes. Create one with a local-only session secret, then run:

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars
npm run db:migrate:local
npm run dev                # Tailwind in watch mode plus wrangler dev
```

Open `http://localhost:8787/setup` to create a local admin.

```bash
npm test                   # unit and integration tests
npm run typecheck
npm run verify:cli         # a contract test against the real npx skills
```

`verify:cli` starts its own `wrangler dev` with a throwaway session secret, so it needs no `.dev.vars`.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`, and run `npm run verify:cli` as well if you touched the registry or publishing code. Code, docs and UI text are in English. [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md) record the product decisions and the design system.

## License

[MIT](LICENSE)
