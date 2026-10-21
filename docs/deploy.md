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

## Download logs

The Worker records every download and keeps the records for 90 days. A Cron Trigger in `wrangler.jsonc` runs at 17 minutes past every hour. It first adds the new records to each skill's download count and to the per-day counts, at most 50,000 records per run, so a download count can trail by up to an hour. Then it deletes older records, and then the records of deleted skills, at most 40,000 per run and so 960,000 a day. A larger backlog, such as the one left by lowering the retention or by deleting a busy skill, is cleared over the following runs, and each run that stops at either limit logs a warning. Each download writes two rows to D1, three when the downloader is signed in, and reads two. The hourly run then reads about four rows per download and writes a few rows for each skill, day, version and source it adds to. Deleting a record later writes two or three more rows. On the Free plan the writes count toward the 100,000 rows written per day and the reads toward the 5 million rows read per day. The log pages add up the per-day counts and the records the hourly run has not reached yet, instead of reading every record, and the list reads at most about a page of records for each skill and source it covers, so the rows they read stay few as downloads grow; a page filtered by account reads that account's records. A Cloudflare account on the Free plan can have 5 Cron Triggers across all its Workers. If a deploy fails because they are used up, remove one from another Worker or move to Workers Paid.

To keep records for a different number of days, set `DOWNLOAD_LOG_RETENTION_DAYS` to a positive whole number. In the Cloudflare dashboard, open the Worker, go to Settings → Variables and Secrets, and add it as a Text variable. `wrangler.jsonc` sets `keep_vars`, so later deploys leave it in place, whether they come from the button or from Wrangler. If the value is not a positive whole number, the Worker logs an error and keeps 90 days. For local development, put it in `.dev.vars`.


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

## Reset a forgotten password

An admin can set a new password for any account on that account's settings page. If no admin can sign in, reset the password from a terminal instead:

```bash
npm run reset-password                   # asks for the username and the new password
npm run reset-password -- alice          # names the account up front
npm run reset-password -- alice --local  # the local development database
```

The script writes the new password straight to the D1 database, so it needs the same Wrangler login as `npm run deploy`. If you deployed with the button, clone your copy and run `npm install` and `npx wrangler login` first. It also signs out every computer signed in to that account with `skillsgist login`. Sessions that are already signed in stay signed in; to sign everyone out, change `SESSION_SECRET`.
