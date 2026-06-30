# Publishing @braintrust/pi-extension

This document describes how this package is released to npm and what the GitHub Actions publish workflow does.

## Overview

Publishing is handled by the manual workflow at:

- `.github/workflows/publish.yml`

The workflow runs the **shared, centrally-maintained release actions** from
[`braintrustdata/sdk-actions`](https://github.com/braintrustdata/sdk-actions), pinned by commit
SHA. Bumping that SHA pulls in upstream release-tooling improvements. The repo keeps only a thin
`compute-metadata` job for its own glue; the rest of the flow is the shared actions.

Key properties:

- npm **trusted publishing** with GitHub Actions OIDC + npm provenance — no long-lived `NPM_TOKEN`
- you release an **explicit commit SHA** (not a branch), so the release is pinned to a specific,
  reviewed commit
- the publish job is gated by a **GitHub Environment** (manual approval) and posts **Slack**
  notifications before approval and on completion
- supports **stable** and **rc prerelease** releases, plus a **dry run**
- the package ships its `src/` directly (no build step); `npm publish`'s `prepack` regenerates
  `src/version.ts`

The environments, npm trusted publisher, and Slack secret/variable are one-time setup —
see the `SETUP REQUIREMENTS` comment block at the top of `.github/workflows/publish.yml`.

## Release steps

1. Update `package.json` to the target version, run `pnpm run sync:version`, commit, and **merge to `main`**.
2. In GitHub, open **Actions → Publish package** and **Run workflow**.
3. Set the inputs:
   - `release_type`: `stable` or `prerelease`
   - `sha`: the full 40-character commit SHA to release
   - `prerelease_suffix` (optional, prereleases only; defaults to the run number)
   - `dry_run` (optional): `true` to validate + pack without publishing
4. When the `publish` job requests it, **approve the `publish` environment**.
5. After it succeeds, verify:
   - the version exists on npm (`npm view @braintrust/pi-extension dist-tags`)
   - the provenance attestation is present on npm
   - (stable only) the `pi-extension-v<version>` tag was pushed and the GitHub release created

CI already runs the full quality suite (version-sync, format, lint, types, tests, pack, smoke)
on every push, so the release workflow does **not** re-run it — it is concerned only with release
policy and publishing.

## What the workflow does

Flow: `compute-metadata → validate → prepare → notify-pending → [approval gate] → publish`.

1. **`compute-metadata`** (this repo's glue): reads `package.json` and computes the release
   coordinates from `release_type` — `version` (stable: as-is; prerelease: `<version>-rc.<suffix>`),
   `channel` (`latest`/`rc`), and whether to create a GitHub release.
2. **`validate`** (shared): release policy — the tag isn't already taken, the npm version isn't
   already published, the channel is allowed, and the SHA is well-formed and on `main`. Runs with
   `build: false` (nothing to build).
3. **`prepare`** (shared): generates the release notes + PR list.
4. **`notify-pending`** (shared): posts a Slack notification that a release is pending approval.
5. **`publish`** (shared, gated): patches `package.json` to the computed version, then publishes
   to npm with provenance (`npm publish`, OIDC), and — for **stable** only — pushes the
   `pi-extension-v<version>` tag and creates the GitHub release. `prepack` regenerates
   `src/version.ts` to match the published version. Posts a Slack completion notification.

Stable → published to the `latest` dist-tag + git tag + GitHub release. Prerelease → published to
the `rc` dist-tag, **no** tag or GitHub release.

## Authentication model

The workflow uses GitHub Actions OIDC for npm trusted publishing. The `publish` job requests:

```yaml
permissions:
  contents: write # push the git tag + create the GitHub release
  id-token: write # OIDC token for npm trusted publishing + provenance
```

## Tagging and release naming

- git tag: `pi-extension-v<version>` (stable only)
- GitHub release name: `@braintrust/pi-extension v<version>`

Example for `0.8.0`: tag `pi-extension-v0.8.0`, release `@braintrust/pi-extension v0.8.0`.

## Failure modes

- the target tag already exists, or the npm version is already published → `validate` fails early
- the channel isn't in the allowlist, or the SHA is malformed → `validate` fails
- the npm trusted publisher isn't configured for the `publish` environment → publish fails
  with `ENEEDAUTH`. A `dry_run` does **not** exercise OIDC, so the first **real** publish is the
  first true test — canary with a prerelease (rc) before any stable release.
- the tag/GitHub release are created only after a successful publish (stable), so a failed publish
  leaves no orphaned tag

## Local preflight checks

The release workflow relies on CI for quality, but before bumping a version it's still useful to run:

```bash
pnpm run sync:version
pnpm run check
pnpm test
pnpm run pack
pnpm pack --dry-run
pnpm run smoke
```

## Notes

- The package is public; `package.json` includes `publishConfig.access = "public"`.
- The workflow is manual (`workflow_dispatch`) and releases an explicit `sha`, not a branch.
- `src/version.ts` is generated from `package.json` (by `scripts/sync-version.mjs`, run via
  `prepack`) so trace metadata reports the version without runtime package-metadata loading.
- The shared actions are pinned to a `braintrustdata/sdk-actions` SHA in `publish.yml`; bumping it
  adopts upstream improvements.
- If the release process changes, update this file, `AGENTS.md`, `CONTRIBUTING.md`, and
  `.github/workflows/publish.yml` as needed.
