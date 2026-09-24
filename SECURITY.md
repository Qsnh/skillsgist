# Security Policy

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest release is supported, so upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub instead:

1. Open the [Security tab](https://github.com/Qsnh/skillsgist/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe the issue, the affected version or commit, and the steps to reproduce it.

The report stays private between you and the maintainer until a fix is released, and the advisory is then published on this repository.

## Scope

In scope: the Worker in this repository — authentication, sessions and CSRF, install keys and API tokens, visibility of private skills, archive handling, and the discovery endpoints under `/.well-known/agent-skills/`.

Out of scope: vulnerabilities in Cloudflare's platform or in the `npx skills` CLI, which should be reported to their own maintainers, and weaknesses in a deployment's own configuration, such as a leaked `SESSION_SECRET`.
