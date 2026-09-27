---
name: release-notes
description: Draft release notes from merged pull requests, grouped by user-facing change, in the team's house style.
---

# Release notes

Turn the pull requests merged since the last tag into release notes a user can read in under a minute.

## When to use

- Cutting a new version of a service or library
- Summarising a sprint for a changelog or an announcement post

## Steps

1. List the merged pull requests since the previous tag with `scripts/collect.sh`.
2. Drop internal-only changes: refactors, CI tweaks, dependency bumps without user impact.
3. Group what remains under **Added**, **Changed**, **Fixed** and **Removed**.
4. Write each entry as one sentence in the past tense, starting with the user-visible effect.
5. Fill `templates/release.md` and link every entry to its pull request.

## Style

| Do | Don't |
| --- | --- |
| "Fixed a crash when an upload was empty." | "Fix NPE in upload handler" |
| Name the setting or page that changed | Mention internal module names |
| Keep breaking changes at the top | Bury them in **Changed** |

> Breaking changes always get their own **Upgrade notes** section with the exact steps to migrate.
