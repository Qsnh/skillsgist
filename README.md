# skillsgist

A minimal private Agent Skills registry running on Cloudflare. Managed from the
web, installed with one `npx skills` command.

## What it does

- Upload / paste / edit skills from the web, with support for `.zip`, `.tar.gz` and a single `SKILL.md`
- Private by default; individual skills can be made public as needed.
- Compatible with the [skills.sh](https://skills.sh) ecosystem's discovery protocol, so no custom CLI is
  needed — already verified end to end with the real `npx skills add` (see `npm run verify:cli`)

## Installing skills

```bash
# Install everything you can see (the install key is on the /me page)
npx skills add https://<your-domain>/i/<install_key>

# Install just one
npx skills add https://<your-domain>/i/<install_key>/.well-known/agent-skills/<skill-name>

# Public skills don't need a key
npx skills add https://<your-domain>

# Install just one public skill, also without a key
npx skills add https://<your-domain>/.well-known/agent-skills/<skill-name>

# Equivalent form: use the CLI's --skill option to pick from the whole index
npx skills add https://<your-domain> -s <skill-name>
```

## Publishing skills

Drag an archive onto `/new` in the browser, or:

```bash
cd my-skill
zip -r - . | curl -X PUT --data-binary @- \
  -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
  -H "Content-Type: application/zip" \
  https://<your-domain>/api/skills/my-skill
```

The API token is generated on demand from the `/me` page. It only ever travels in a header, never in a URL.

The curl call above needs no CSRF token and no `Origin` header: `/api/*` only ever
reads `Authorization: Bearer` and never reads the session cookie, so a browser
cannot make this request on your behalf. The web form takes a different
path — a session-bound CSRF token, attached automatically, with nothing for you to manage.

## First deploy

```bash
npm install

# Create resources
npx wrangler d1 create skillsgist        # fill the output database_id into wrangler.jsonc
npx wrangler r2 bucket create skillsgist

# Create tables
npx wrangler d1 migrations apply skillsgist --remote

# Set the session secret
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET

# Deploy
npm run deploy
```

After deploying, visit `https://<your-domain>/setup` to create the first admin. That page disables itself automatically once a user exists.

To bind a custom domain: add `routes` in `wrangler.jsonc` and run `npm run deploy` again — no code changes needed.

## Upgrading

Pull the new code, apply any new migrations, then deploy:

```bash
npx wrangler d1 migrations apply skillsgist --remote
npm run deploy
```

## Local development

`wrangler dev` has no way to know `SESSION_SECRET` (it's only ever set as a secret at deploy
time), so before running local development for the first time, generate yourself a
local-only session secret and write it into `.dev.vars`, which `wrangler dev`
reads automatically and which `.gitignore` already excludes:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars

npx wrangler d1 migrations apply skillsgist --local
npm run dev          # tailwind --watch + wrangler dev
npm test             # unit and integration tests
npm run verify:cli   # a contract test run against the real npx skills
npm run typecheck
```

The `wrangler dev` instance that `npm run verify:cli` starts for itself does not depend on
`.dev.vars` — it generates its own temporary session secret and injects it via `--var`, so it
runs fine on a clean checkout with no `.dev.vars` present.

## User management

`/admin/users` supports creating accounts, changing roles (admin ↔ member), resetting passwords, rotating install keys, revoking API tokens and deleting accounts, all restricted to admins, and it never allows demoting or deleting the last remaining admin.

**Deleting a user reassigns the skills they own (`owner_id`) and the author
records on their published versions (`author_id`) to the admin doing the
delete**, because neither column may be null or point at a user that does not
exist. That is a real cost: the original authorship is lost. To withdraw access
only — say, when someone leaves — prefer "Demote to member" plus "Rotate install
key": the install key stops working immediately and both the skills and the
version author records stay untouched. Delete only when the account itself must
go.

## Two constraints worth knowing

**The install key appears in the URL.** `npx skills` sends no custom headers, so
the credential for a private install can only be encoded in the path. The key
can only install — whoever holds it cannot sign in, publish or delete — and it
can be reset from the `/me` page in one click.

**Upload limits are 2 MB, 8 MB unpacked, 200 files.** These fit the Workers Free
plan's 10 ms CPU ceiling per request. On Workers Paid you can raise the three
constants in `src/skills/normalize.ts` and `PBKDF2_ITERATIONS` in `src/auth.ts`.
