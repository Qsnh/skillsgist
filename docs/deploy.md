# Deploy and run

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

npx wrangler d1 create skillsgist --no-update-config
npx wrangler r2 bucket create skillsgist --no-update-config
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET

npm run deploy                           # applies migrations, builds the CSS, deploys
```

Then open `https://<your-worker>/setup` to create the first admin. The page switches itself off as soon as any user exists.

### Custom domain

To serve the instance on your own domain, open the Worker in the Cloudflare dashboard and add a Custom Domain under Settings → Domains & Routes.

## Rate-limit sign-in requests

`POST /api/oauth/device`, where `skillsgist login` starts, needs no credentials, and every call writes a row to D1. As new requests arrive, the Worker deletes expired ones and sign-ins unused for 90 days, but it does not limit how fast requests come, so once the instance has a custom domain, add a rate limiting rule to it: in the Cloudflare dashboard, open the domain, go to Security → Security rules, and choose Create rule → Rate limiting rules.

- **If incoming requests match:** URI Path equals `/api/oauth/device`
- **With the same characteristics:** IP
- **When rate exceeds:** 5 requests per 10 seconds
- **Then take action:** Block, for 10 seconds

The Free plan allows one rule like this; Pro and above can count over a longer period and block for longer. `skillsgist login` calls the address once per sign-in, so a person signing in stays far below the limit. The rule covers only the custom domain, not the Worker's `workers.dev` address.

## Limits

An upload may be at most 2 MB, unpack to at most 8 MB, and contain at most 200 files. These limits keep each request inside the Workers Free plan's 10 ms CPU budget. On Workers Paid you can raise `MAX_UPLOAD_BYTES`, `MAX_UNPACKED_BYTES` and `MAX_FILES` in `src/skills/normalize.ts`, and `PBKDF2_ITERATIONS` in `src/auth.ts`.

## Upgrade

With Wrangler, pull and deploy. `npm run deploy` applies any new migrations first:

```bash
git pull
npm install
npm run deploy
```

If you deployed with the button, your copy is a separate repository rather than a fork. Merge this repository into it and push; Workers Builds deploys again and applies any new migrations.

```bash
git remote add upstream https://github.com/Qsnh/skillsgist.git
git fetch upstream
git merge upstream/main
git push
```

### Upgrading to the release with sign-ins

The migrations in this release replace every install key with a new `sgi_` key and delete the `/i/` install addresses. Old `npx skills add https://…/i/<key>` commands and agent prompts stop working at once. Run `npx skillsgist login <origin>` to sign a computer in, or copy the new key for CI from the project's settings page. The stock `npx skills` keeps installing public skills; it cannot install private ones. Until you upgrade an instance, keep using `npx skillsgist@0.4.1` against it.

`npm run deploy` applies the migrations before it deploys the new Worker, so if the deploy fails partway through, finish it before anyone uses the site, or reset the install keys afterward — between the two steps, the old Worker is still running and shows the new keys inside the install commands under the now-removed `/i/` routes. A repository whose `skills-lock.json` still records an old `/i/` address needs those skills reinstalled from the `/p/<project>` address, because `npx skills update` can no longer reach the old one.

## Reset a forgotten password

An admin can set a new password for any account on that account's settings page. If no admin can sign in, reset the password from a terminal instead:

```bash
npm run reset-password                   # asks for the username and the new password
npm run reset-password -- alice          # names the account up front
npm run reset-password -- alice --local  # the local development database
```

The script writes the new password straight to the D1 database, so it needs the same Wrangler login as `npm run deploy`. If you deployed with the button, clone your copy and run `npm install` and `npx wrangler login` first. It also signs out every computer signed in to that account with `skillsgist login`. Sessions that are already signed in stay signed in; to sign everyone out, change `SESSION_SECRET`.
