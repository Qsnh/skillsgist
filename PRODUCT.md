# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two confirmed audiences, both first-class:

- **Operators / self-hosters.** People who deploy their own skillsgist instance on Cloudflare and run it for themselves or a small trusted team. This includes the project's own author and team, and external people who take the open-source project and stand up their own instance.
- **Skill consumers.** People who install skills from an instance they have been given access to. They never touch the web UI if they do not want to; they hold an install key and run `npx skills add`.

Both the publisher/maintainer role and the installer/consumer role are primary. A single person is often both.

Inside an instance there are exactly two roles: `admin` and `member`. Admins additionally manage accounts, roles, install keys, API tokens, and deletions.

## Product Purpose

A private registry for Agent Skills that one person can stand up on Cloudflare and manage from the browser. Skills are uploaded, edited, and versioned from the web, and installed with a single `npx skills add` command.

Success means a team can keep their skills private — not published to any shared public registry — and still install them with the unmodified stock CLI, on infrastructure they own.

## Positioning

**Self-hosting and privacy are the position.** The instance, the data, the storage bucket, and the credentials all belong to whoever deploys it. Skills are private by default; making one public is a deliberate per-skill act.

The mechanism that makes this practical: skillsgist serves the skills.sh discovery protocol (`/.well-known/agent-skills/index.json`, discovery schema `0.2.0`) directly, so no custom client, plugin, or fork of the CLI is required. This is verified end to end against the real `npx skills` binary by `npm run verify:cli`.

## Operating Context

- **First deploy.** Either the Deploy to Cloudflare button, which copies the repository, provisions D1 and R2, prompts for `SESSION_SECRET` (declared in `.dev.vars.example`) and deploys through Workers Builds; or by hand, `wrangler d1 create` + `wrangler r2 bucket create` + a `SESSION_SECRET` secret + `npm run deploy`, which applies remote migrations by binding name before deploying. Then `/setup` creates the first admin and disables itself permanently once any user exists. Binding a custom domain is a `routes` entry in `wrangler.jsonc`, no code change.
- **Publishing from the web.** `/new` accepts a `.zip`, a `.tar.gz`, or a single `SKILL.md`. `/s/:slug/edit` changes only the `SKILL.md` text and repacks the previous version's other files unchanged. `/s/:slug/upload` replaces the whole archive. Editing text and uploading an archive are deliberately two separate pages so a single page never offers two competing inputs. All three pages refuse content identical to the skill's latest version with an error, and a refused request changes nothing else, visibility included. Content identical to an older version still publishes, which is how a rollback works.
- **Publishing from a terminal.** `PUT /api/skills/:slug` with `Authorization: Bearer <token>` and a raw archive body. The token is generated on demand from `/me`. Unlike the web pages, the API is idempotent: identical content answers `200` with `unchanged: true` and still applies `?visibility=`, so a script can republish on every push.
- **Installing.** `npx skills add https://<domain>/i/<install_key>` for everything visible to that key, `.../i/<key>/.well-known/agent-skills/<name>` for one skill, or the bare origin for public skills with no key at all.
- **Account administration.** `/admin/users` lists accounts, switches roles, resets passwords, rotates install keys, revokes API tokens, and deletes accounts. `/admin/users/new` creates them.
- **Local development.** A local-only `SESSION_SECRET` in `.dev.vars`, `d1 migrations apply --local`, then `npm run dev` (Tailwind watch + `wrangler dev`). `npm test`, `npm run typecheck`, and `npm run verify:cli` are the verification commands; `verify:cli` starts its own `wrangler dev` with an injected secret and needs no `.dev.vars`.

## Capabilities and Constraints

**Confirmed functionality**

- Upload formats: `.zip`, `.tar.gz`, or a bare `SKILL.md`. A single wrapper directory is stripped; junk files are dropped.
- Versions are immutable and numbered by a monotonic integer per skill. Every version keeps its own `SKILL.md`, rendered HTML, file manifest, digest, and R2 object. Older versions stay viewable and downloadable.
- Artifacts are content-addressed by digest; the discovery index hands the CLI a digest it can verify.
- Visibility is per skill, `private` by default, flippable to `public` by whoever can manage it.
- Search covers names, descriptions, and body text. Anonymous visitors see only public skills.
- Each skill keeps one lifetime download count. Every archive the Worker serves with a `GET` — to the CLI through `/d/` or `/i/<key>/d/`, or to a browser through `/s/:slug/download` or `/s/:slug/v/:n/download` — adds one, written after the response so it never slows or breaks the download. Index fetches, page views, `HEAD` requests and refused requests do not count. No IP, user agent or user id is stored. Signed-in users see the count in the skill list and on the skill page; anonymous visitors do not. The count measures downloads, not installs: the stock CLI (skills 1.7.0) downloads every archive in the index it is pointed at before it installs the selected ones, so a whole-index `npx skills add` counts every listed skill once, while a single-skill address counts only that skill. `npm run verify:cli` asserts the single-skill case and one download for the skill a whole-index install selects, and logs what the whole-index install counted for the others.
- The discovery index drops any entry whose name, description, or digest would fail the CLI's own validation, rather than serving a half-broken index.

**Durable constraints**

- **Server-rendered HTML; client-side JavaScript only as progressive enhancement.** Every page works with JavaScript disabled, and all interaction that changes state is forms and links. There are two scripts, both same-origin and deferred: `public/copy.js` adds one-click copy to command blocks because no HTML or CSS feature can write to the clipboard, and `public/fold.js` folds a long SKILL.md, Files list or Versions list behind a Show more button because no HTML or CSS feature can tell whether an element overflows.
- **The stock CLI is the contract.** `npx skills` sends no custom headers, so a private install credential can only live in the URL path. The install key is therefore install-only — it cannot sign in, publish, or delete — and is rotatable from `/me` in one click.
- **API tokens never travel in a URL.** `/api/*` reads only `Authorization: Bearer` and never the session cookie, so a browser cannot be tricked into making an API call on a user's behalf. The web forms take the other path: a session-bound CSRF token attached automatically.
- Content-Security-Policy on every HTML response: `default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- The last remaining admin can never be demoted or deleted.
- Deleting a user reassigns the skills they own and the author records on their versions to the admin performing the delete, because neither column may be null. Original authorship is lost. Withdrawing access without that cost means demoting to member plus rotating the install key.
- Project language is English throughout — code, identifiers, documentation, commit messages, and UI text.

**Undecided**

- Upload limits are currently 2 MB uploaded, 8 MB unpacked, 200 files, sized to fit the Workers Free plan's 10 ms CPU ceiling per request; on Workers Paid they and `PBKDF2_ITERATIONS` can be raised. **Whether these ceilings are permanent product constraints or a temporary consequence of the free tier is not yet decided.** Do not treat either reading as settled.
- No accessibility standard or product-specific accessibility requirement has been established.

## Brand Commitments

- The name is `skillsgist`, lowercase.
- No brand commitment has been confirmed: no logo, no fixed voice, no mandated palette or typeface, no binding visual reference.
- The user named **Vercel** as a product they admire. Recorded as a stated preference only — it is not a binding commitment, and it does not by itself authorize any particular visual direction.

## Evidence on Hand

- `README.md` — real install, publish, deploy, and user-management instructions.
- `npm run verify:cli` (`scripts/verify-cli.mjs`) — a contract test run against the real `npx skills` binary, the concrete proof behind the "no custom CLI needed" claim.
- `test/` — the unit and integration suite, run under `@cloudflare/vitest-pool-workers`.
- `docs/superpowers/plans/` — implementation plans for shipped work.

**Absent, and must not be fabricated:** no customers, users, testimonials, case studies, press, benchmarks, uptime figures, install counts, pricing, or hosted-service offering. There is no logo or brand asset. Nothing states that a public instance is deployed or that anyone outside the author's team uses it.

## Product Principles

1. **Private by default; every act of sharing is explicit.** Nothing becomes public as a side effect.
2. **The stock CLI is the contract.** Speak the published discovery protocol; never require a custom client, and never break `npx skills add`.
3. **Server-rendered; JavaScript only enhances.** Forms and links carry every interaction. A script may add a convenience the platform cannot provide without it, such as clipboard copy, and the page must still work without it.
4. **Both audiences are first-class.** The operator standing up an instance and the person who only ever runs one install command each deserve a path that works without learning the other's.
5. **Stay self-hostable and cheap.** One person with a Cloudflare account must be able to deploy and run this without operational burden.
