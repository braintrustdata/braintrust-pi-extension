# Publishing @braintrust/trace-pi

This document describes how this package is released to npm and what the GitHub Actions publish workflow does.

## Overview

Publishing is handled by the manual workflow at:

- `.github/workflows/publish.yml`

The workflow is designed for npm trusted publishing with GitHub Actions OIDC and npm provenance attestations.

Key properties:

- no long-lived `NPM_TOKEN` is required once npm trusted publishing is configured
- the workflow requests `id-token: write`
- the package is published with `npm publish --provenance --access public`
- a git tag and GitHub release are created after a successful publish

## Prerequisites

Before using the workflow, make sure:

1. The package name on npm is correct: `@braintrust/trace-pi`
2. npm trusted publishing is configured for this repository/package
3. You have bumped `package.json` to the version you want to release
4. The branch you want to publish is pushed to GitHub

## Release steps

1. Update `package.json` with the target version.
2. Commit and push the version bump to the branch you want to release from.
3. In GitHub, open **Actions**.
4. Run the **Publish package** workflow.
5. Enter the branch to publish from, such as `main`.
6. Start the workflow.
7. After it succeeds, verify:
   - the package version exists on npm
   - the provenance attestation is present on npm
   - the `trace-pi-v<version>` tag was pushed
   - the GitHub release was created

## What the workflow does

The workflow has two jobs.

### 1. `prepare-release`

This job:

- checks out the requested branch
- reads `name` and `version` from `package.json`
- records the release commit SHA
- computes the release tag as `trace-pi-v<version>`
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
- sets up Node.js 24 with npm registry access
- runs `npm ci`
- runs validation and packaging commands:
  - `npm run check`
  - `npm test`
  - `npm run pack`
  - `npm pack --dry-run`
  - `npm run smoke`
- publishes to npm with provenance:
  - `npm publish --provenance --access public`
- creates and pushes the git tag `trace-pi-v<version>`
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

- git tag: `trace-pi-v<version>`
- GitHub release name: `@braintrust/trace-pi v<version>`

Example for version `0.1.0`:

- tag: `trace-pi-v0.1.0`
- release name: `@braintrust/trace-pi v0.1.0`

## Failure modes

The workflow will fail if:

- the target git tag already exists on the remote
- formatting, linting, type checking, tests, pack, or smoke checks fail
- npm trusted publishing is not configured correctly
- npm rejects the publish for version or package metadata reasons

Important behavior:

- the tag is only created after `npm publish` succeeds
- this avoids creating release tags for unpublished versions

## Local preflight checks

Before triggering a release, it is a good idea to run:

```bash
npx vp check
npm test
npm run pack
npm pack --dry-run
npm run smoke
```

## Notes

- The package is public, and `package.json` includes `publishConfig.access = "public"`.
- The workflow is manual (`workflow_dispatch`) rather than tag-triggered.
- If the release process changes, update both this file and `.github/workflows/publish.yml`.
