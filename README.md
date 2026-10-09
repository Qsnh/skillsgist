<img src="docs/images/logo.png" width="72" height="72" alt="">

# skillsgist

A private Agent Skills registry you self-host on Cloudflare.

[![CI](https://github.com/Qsnh/skillsgist/actions/workflows/ci.yml/badge.svg)](https://github.com/Qsnh/skillsgist/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Keep your team's Agent Skills in one place that only your team can see. Upload a skill in the browser, and anyone with access installs it into Claude Code, Codex, Cursor and dozens of other coding agents with one command:

```bash
npx skillsgist add https://skills.example.com/p/<project>
```

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Qsnh/skillsgist)

![The skillsgist home page: a search box and the skill list](docs/images/home.png)

## Is it for you?

skillsgist is a good fit if:

- your team writes its own skills and wants to keep them out of public registries;
- you want them on a Cloudflare account you own, not on someone else's service;
- different groups need different access, and each group decides who sees its skills;
- you would rather manage skills, versions and people in web pages than in config files.

It is not a good fit if:

- you are looking for a public marketplace of other people's skills;
- you cannot use Cloudflare, since skillsgist runs only there;
- you want a hosted service, since there is none and you deploy your own copy;
- your skills are large: an upload is capped at 2 MB, 8 MB unpacked and 200 files, to fit Cloudflare's free plan.

## What you get

- **Private by default.** A new skill is visible only to its project's members. Making one public is a deliberate switch on that one skill.
- **Projects with their own people.** Skills and members are grouped by project. Project admins manage their own members and skills, and decide who may publish.
- **One-command installs.** Every skill page shows its install command, and a prompt you paste into your agent to have it install the skill and use it right away. A computer signs in once through the browser, for only the projects you tick, and keys never appear in a link.
- **Publishing in the browser.** Upload a `.zip`, a `.tar.gz` or a single `SKILL.md`, or edit `SKILL.md` right on the page.
- **Every version kept.** Each publish is a new numbered version. Older versions stay viewable and downloadable, and publishing one again rolls back.
- **Search** across skill names, descriptions and contents.
- **Automation.** Publish from CI with an API token, and install in CI with a project's install key.
- **Works with the standard tools.** Public skills also install with the stock `npx skills`.
- **In four languages.** English, Simplified Chinese, Traditional Chinese and Japanese.
- **Cheap to run.** One Cloudflare Worker, one D1 database and one R2 bucket, sized for the Workers Free plan.

## Get started

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Qsnh/skillsgist)

1. Click the button. Cloudflare copies this repository into your GitHub or GitLab account, creates the database and storage, and deploys it. When it asks for `SESSION_SECRET`, paste a long random value, such as the output of `openssl rand -hex 32`.
2. Open `/setup` on the new site and create the first admin.
3. Create a project, upload a skill, and share the install command on its page.

To deploy from a terminal, use your own domain or upgrade later, see [Deploy and run](docs/deploy.md).

## Documentation

- [Install and publish](docs/usage.md): signing in, installing in CI, publishing from a terminal or CI
- [Projects, accounts and roles](docs/usage.md#projects-accounts-and-roles): who can see, publish and manage what
- [Deploy and run](docs/deploy.md): Wrangler, custom domains, rate limiting, limits, upgrades and password resets
- [skillsgist CLI](https://github.com/Qsnh/skillsgist-cli): every option of `npx skillsgist`
- [Contributing](CONTRIBUTING.md): how it works and local development

## License

[MIT](LICENSE)
