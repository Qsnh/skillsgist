# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two confirmed audiences, both first-class:

- **Operators / self-hosters.** People who deploy their own skillsgist instance on Cloudflare and run it for themselves or a small trusted team. This includes the project's own author and team, and external people who take the open-source project and stand up their own instance.
- **Skill consumers.** People who install skills from an instance they have been given access to. They never touch the web UI if they do not want to; they sign in once with `npx skillsgist login` or, in CI, hold an install key, and run `npx skillsgist add`.

Both the publisher/maintainer role and the installer/consumer role are primary. A single person is often both.

Every skill belongs to one project. An instance has two roles, `admin` and `member`, and each project membership has its own `admin` or `member` role. Instance admins additionally manage accounts, projects, roles, install keys, API tokens, and deletions, and see every project. Project admins manage their project's name, members, and every skill in it, and decide which members may publish: a new member starts with publishing blocked, and a blocked member still sees and installs the project's skills but can neither publish into it nor manage the skills they own there.

## Product Purpose

A private registry for Agent Skills that one person can stand up on Cloudflare and manage from the browser. Skills are uploaded, edited, and versioned from the web, and installed with a single `npx skillsgist add` command.

Success means a team can keep their skills private — not published to any shared public registry — and still install them with one command, on infrastructure they own, without a credential ever appearing in a URL.

## Positioning

**Self-hosting and privacy are the position.** The instance, the data, the storage bucket, and the credentials all belong to whoever deploys it. Skills are private by default; making one public is a deliberate per-skill act.

The mechanism that makes this practical: skillsgist serves the discovery protocol (`/.well-known/agent-skills/index.json`, discovery schema `0.2.0`), so any client that speaks it installs **public** skills, the stock `npx skills` included. Private skills need the skillsgist CLI, which sends a sign-in or an install key in the `Authorization` header and only to the instance it belongs to.

## Operating Context

- **First deploy.** Either the Deploy to Cloudflare button, which copies the repository, provisions D1 and R2, prompts for `SESSION_SECRET` (declared in `.dev.vars.example`) and deploys through Workers Builds; or by hand, `wrangler d1 create` + `wrangler r2 bucket create` + a `SESSION_SECRET` secret + `npm run deploy`, which applies remote migrations by binding name before deploying. `wrangler.jsonc` carries no account-specific IDs: Wrangler resolves D1 and R2 by name, so a clone deploys without editing tracked files. Then `/setup` creates the first admin and disables itself permanently once any user exists. Binding a custom domain is a Custom Domain added in the Cloudflare dashboard, which deploys leave alone; no code change.
- **Publishing from the web.** `/new` accepts a `.zip`, a `.tar.gz`, or a single `SKILL.md`. `/p/:project/s/:slug/edit` changes only the `SKILL.md` text and repacks the previous version's other files unchanged. `/p/:project/s/:slug/upload` replaces the whole archive. Editing text and uploading an archive are deliberately two separate pages so a single page never offers two competing inputs. All three pages refuse content identical to the skill's latest version with an error, and a refused request changes nothing else, visibility included. Content identical to an older version still publishes, which is how a rollback works.
- **Publishing from a terminal.** `PUT /api/projects/:project/skills/:slug` with `Authorization: Bearer <token>` and a raw archive body. The token is generated on demand from `/me`, or by an admin from the account's settings page, `/admin/users/:id`. Unlike the web pages, the API is idempotent: identical content answers `200` with `unchanged: true` and still applies `?visibility=`, so a script can republish on every push.
- **Installing.** `npx skillsgist add https://<domain>/p/<project>` for a project, `.../p/<project>/.well-known/agent-skills/<name>` for one skill, or the bare origin for public skills. Private skills need `npx skillsgist login https://<domain>` once per computer, which lets the browser page pick the projects, or `SKILLSGIST_HOST` and `SKILLSGIST_INSTALL_KEY` in CI.
- **Account administration.** `/admin/users` lists accounts with their role, project count, created-skill count, join date and last sign-in. `/admin/users/:id` is one account's settings page, where an admin switches its role, resets its password, rotates its install keys and signs its computers out, generates or revokes its API token, and deletes it. `/admin/users/new` creates them. `/projects` lists projects, each name opening its settings page, and instance admins create them at `/projects/new`. `/p/:project` is the home page for one project: the viewer's install command for it, a search over its skills and a grid of them. `/p/:project/settings` is where a member copies and resets their install key for CI and sees its members, and where its admins rename it, add and remove members, and allow or block each member's publishing. `/me` lists and signs out CLI sign-ins. `/device` approves a `skillsgist login`.
- **Local development.** A local-only `SESSION_SECRET` in `.dev.vars`, `d1 migrations apply --local`, then `npm run dev` (Tailwind watch + `wrangler dev`). `npm test`, `npm run typecheck`, and `npm run verify:cli` are the verification commands; `verify:cli` starts its own `wrangler dev` with an injected secret and needs no `.dev.vars`.

## Capabilities and Constraints

**Confirmed functionality**

- Upload formats: `.zip`, `.tar.gz`, or a bare `SKILL.md`. A single wrapper directory is stripped; junk files are dropped.
- Versions are immutable and numbered by a monotonic integer per skill. Every version keeps its own `SKILL.md`, rendered HTML, file manifest, digest, and R2 object. Older versions stay viewable and downloadable.
- Artifacts are content-addressed by digest; the discovery index hands the CLI a digest it can verify.
- Visibility is per skill, `private` by default, flippable to `public` by whoever can manage it. A private skill is visible to its project's members and to instance admins; a public one to everyone.
- Skill names are unique within a project. A project has a changeable name and a fixed address. A skill moves between projects with its versions, owner, visibility and download count, unless the target already has a skill with its name.
- Search covers names, descriptions, and body text. Anonymous visitors see only public skills.
- The discovery index drops any entry whose name, description, or digest would fail the CLI's own validation, rather than serving a half-broken index.
- The web UI is in English, Simplified Chinese, Traditional Chinese and Japanese. The language comes from the `sg_lang` cookie that the footer switcher sets, then the browser's `Accept-Language`, then English. Taiwan, Hong Kong, Macau and `zh-Hant` browsers get Traditional Chinese (in Taiwan wording); every other Chinese variant gets Simplified. Page addresses, install commands, the discovery index and the API, error messages included, are the same in every language. Skill content and every name are never translated.

**Durable constraints**

- **Server-rendered HTML; client-side JavaScript only as progressive enhancement.** Every page works with JavaScript disabled, and all interaction that changes state is forms and links. There are three scripts, all same-origin and deferred: `public/copy.js` adds one-click copy to command blocks because no HTML or CSS feature can write to the clipboard, `public/fold.js` folds a long SKILL.md, Files list or Versions list behind a Show more button because no HTML or CSS feature can tell whether an element overflows, and `public/dismiss.js` closes an open menu or confirmation on Escape, on a press outside it, or when focus leaves it, because a `<details>` element never closes itself.
- **Credentials never travel in a URL.** Private installs authenticate with `Authorization: Bearer`, either a device sign-in (`sgd_`, limited to the projects ticked at approval and to current memberships, expires after 90 days unused, revocable per computer) or an install key (`sgi_`, one person in one project, install-only, shown only on that member's project settings page and resettable there). A credential that does not open a project, or no longer works, still gets that project's public skills, as an anonymous visitor would; it is refused only where it would need to open something private. `/api/*` reads only `Authorization: Bearer` and never the session cookie, so a browser cannot be tricked into making an API call on a user's behalf; the web forms take the other path, a session-bound CSRF token attached automatically.
- Content-Security-Policy on every HTML response: `default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- The last remaining admin can never be demoted or deleted.
- Deleting a user reassigns the skills they own and the author records on their versions to the admin performing the delete, because neither column may be null. Original authorship is lost. Withdrawing access without that cost means removing the person from their projects and resetting their password.
- Code, identifiers, documentation and commit messages are in English. UI text is written in English and translated into Simplified Chinese, Traditional Chinese and Japanese; English is the source and the fallback.

**Undecided**

- Upload limits are currently 2 MB uploaded, 8 MB unpacked, 200 files, sized to fit the Workers Free plan's 10 ms CPU ceiling per request; on Workers Paid they and `PBKDF2_ITERATIONS` can be raised. **Whether these ceilings are permanent product constraints or a temporary consequence of the free tier is not yet decided.** Do not treat either reading as settled.
- No accessibility standard or product-specific accessibility requirement has been established.

## Brand Commitments

- The name is `skillsgist`, lowercase.
- No brand commitment has been confirmed: no logo, no fixed voice, no mandated palette or typeface, no binding visual reference.
- The user named **Vercel** as a product they admire. Recorded as a stated preference only — it is not a binding commitment, and it does not by itself authorize any particular visual direction.

## Evidence on Hand

- `README.md` — who skillsgist is for, what it does, and the one-click deploy. `docs/usage.md` and `docs/deploy.md` — real install, publish, deploy, and user-management instructions.
- `npm run verify:cli` (`scripts/verify-cli.mjs`) — a contract test run against the real skillsgist CLI: install-key headers, `skillsgist login` device sign-in and `logout`, rejection of a wrong-project key for private skills while it still installs public ones, rejection of retired `/i/` addresses, and the stock `npx skills` binary installing a public skill, the concrete proof behind the discovery protocol claim.
- `test/` — the unit and integration suite, run under `@cloudflare/vitest-pool-workers`.
- `docs/superpowers/plans/` — implementation plans for shipped work.

**Absent, and must not be fabricated:** no customers, users, testimonials, case studies, press, benchmarks, uptime figures, install counts, pricing, or hosted-service offering. There is no logo or brand asset. Nothing states that a public instance is deployed or that anyone outside the author's team uses it.

## Product Principles

1. **Private by default; every act of sharing is explicit.** Nothing becomes public as a side effect.
2. **The discovery protocol is the contract for public skills.** Any compatible client installs them. Private skills need the skillsgist CLI, because their credential must travel in a header.
3. **Server-rendered; JavaScript only enhances.** Forms and links carry every interaction. A script may add a convenience the platform cannot provide without it, such as clipboard copy, and the page must still work without it.
4. **Both audiences are first-class.** The operator standing up an instance and the person who only ever runs one install command each deserve a path that works without learning the other's.
5. **Stay self-hostable and cheap.** One person with a Cloudflare account must be able to deploy and run this without operational burden.
