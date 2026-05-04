# Publishing @braintrust/pi-extension

This document describes how this package is released to npm and what the GitHub Actions publish workflow does.

## Overview

Publishing is handled by the manual workflow at:

- `.github/workflows/publish.yml`

The workflow is designed for npm trusted publishing with GitHub Actions OIDC and npm provenance attestations.

Key properties:

- no long-lived `NPM_TOKEN` is required once npm trusted publishing is configured
- the workflow requests `id-token: write`
- the package is published with `pnpm publish --provenance --access public`
- a git tag and GitHub release are created after a successful publish

## Prerequisites

Before using the workflow, make sure:

1. The package name on npm is correct: `@braintrust/pi-extension`
2. npm trusted publishing is configured for this repository/package
3. You have bumped `package.json` to the version you want to release
4. You have regenerated and committed `src/version.ts` with `pnpm run sync:version`
5. The branch you want to publish is pushed to GitHub

## Release steps

1. Update `package.json` with the target version.
2. Run `pnpm run sync:version` to regenerate `src/version.ts`.
3. Run the local preflight checks below.
4. Commit and push the version bump, including `src/version.ts`, to the branch you want to release from.
5. In GitHub, open **Actions**.
6. Run the **Publish package** workflow.
7. Enter the branch to publish from, such as `main`.
8. Start the workflow.
9. After it succeeds, verify:
   - the package version exists on npm
   - the provenance attestation is present on npm
   - the `pi-extension-v<version>` tag was pushed
   - the GitHub release was created

## What the workflow does

The workflow has two jobs.

### 1. `prepare-release`

This job:

- checks out the requested branch
- reads the pinned Node.js version from `.tool-versions`
- reads `name` and `version` from `package.json`
- records the release commit SHA
- computes the release tag as `pi-extension-v<version>`
- fails early if that tag already exists on `origin`

Outputs passed to the publish job:

- `branch`
- `commit`
- `package_name`
- `release_name`
- `release_tag`
- `version`

### 2. `publish`

This job:

- checks out the requested branch
- reads the pinned tool versions from `.tool-versions`
- sets up pnpm and Node.js with npm registry access using those pinned versions
- runs `pnpm install --frozen-lockfile`
- runs validation and packaging commands:
  - `pnpm run check` (including generated version sync validation)
  - `pnpm test`
  - `pnpm run pack` (regenerates `src/version.ts` via `prepack`)
  - `pnpm pack --dry-run`
  - `pnpm run smoke`
- publishes to npm with provenance:
  - `pnpm publish --provenance --access public`
- creates and pushes the git tag `pi-extension-v<version>`
- creates a GitHub release for that tag

## Authentication model

The workflow uses GitHub Actions OIDC for npm trusted publishing.

Relevant workflow permissions:

```yaml
permissions:
  contents: write
  id-token: write
```

Why these are needed:

- `id-token: write` allows GitHub Actions to request an OIDC token for npm trusted publishing
- `contents: write` allows the workflow to push the git tag and create the GitHub release

## Tagging and release naming

The workflow uses:

- git tag: `pi-extension-v<version>`
- GitHub release name: `@braintrust/pi-extension v<version>`

Example for version `0.1.0`:

- tag: `pi-extension-v0.1.0`
- release name: `@braintrust/pi-extension v0.1.0`

## Failure modes

The workflow will fail if:

- the target git tag already exists on the remote
- generated version sync, formatting, linting, type checking, tests, pack, or smoke checks fail
- npm trusted publishing is not configured correctly
- npm rejects the publish for version or package metadata reasons

Important behavior:

- the tag is only created after `pnpm publish` succeeds
- this avoids creating release tags for unpublished versions

## Local preflight checks

Before triggering a release, it is a good idea to run:

```bash
pnpm run sync:version
pnpm run check
pnpm test
pnpm run pack
pnpm pack --dry-run
pnpm run smoke
```

## Notes

- The package is public, and `package.json` includes `publishConfig.access = "public"`.
- The workflow is manual (`workflow_dispatch`) rather than tag-triggered.
- `src/version.ts` is generated from `package.json` so trace metadata reports the package version without runtime package metadata loading.
- If the release process changes, update this file, `AGENTS.md`, `CONTRIBUTING.md`, and `.github/workflows/publish.yml` as needed.
