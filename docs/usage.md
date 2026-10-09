# Install and publish

## Install skills

```bash
npx skillsgist add https://skills.example.com/p/<project>          # public skills, no sign-in
npx skillsgist login https://skills.example.com                    # once per computer, for private skills
```

In CI, skip the sign-in and use the key from the project's settings page, stored as a masked secret:

```yaml
      - run: npx skillsgist add https://skills.example.com/p/<project> -g -y
        env:
          SKILLSGIST_HOST: https://skills.example.com
          SKILLSGIST_INSTALL_KEY: ${{ secrets.SKILLSGIST_INSTALL_KEY }}
```

- `SKILLSGIST_INSTALL_KEY` is not `SKILLSGIST_TOKEN`, which is the publish token described below.
- The CLI sends the key only when `SKILLSGIST_HOST` names the address being installed from.
- One key covers one project.

Every option of `npx skillsgist` is in the [skillsgist CLI](https://github.com/Qsnh/skillsgist-cli) repository.

## Publish from a terminal or CI

Generate an API token on `/me`, or have an admin generate one on your account's settings page, which suits an account used only by CI. It is shown once, and it travels only in the `Authorization` header, never in a URL.

```bash
cd my-skill
zip -r - . | curl --fail-with-body -sS -X PUT --data-binary @- \
  -H "Authorization: Bearer $SKILLSGIST_TOKEN" \
  -H "Content-Type: application/zip" \
  https://skills.example.com/api/projects/<project>/skills/my-skill
```

- The name in the URL must match the `name` in `SKILL.md`, and you must be a member of the project who is allowed to publish (an instance admin can publish into any project).
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
            https://skills.example.com/api/projects/<project>/skills/release-notes
```

## Projects, accounts and roles

Every skill belongs to exactly one project, and people are members of projects. A project has a name, which its admins can change at any time, and an address such as `platform`, which is fixed when the project is created and appears in its page, install and API addresses. An instance has two roles:

- **Members** see and install public skills and the skills of the projects they are in, publish into those projects where a project admin allows it, and manage the skills they own there.
- **Admins** can also see and manage every project and every skill, create and delete projects, and manage every account.

Each membership has its own role:

- **Project members** see and install the project's skills. Once a project admin allows their publishing, they also publish into the project and manage the skills they own there. New members start with publishing blocked; a blocked member still sees and installs everything in the project, but can neither publish into it nor manage the skills they own there.
- **Project admins** can also manage every skill in the project, rename the project, add, remove, promote and demote its members, and allow or block each member's publishing. Project admins can always publish.

**Deleting an account reassigns its skills and the author records on its versions to the admin who deletes it**, because neither may point at a user that no longer exists. The original authorship is lost.
