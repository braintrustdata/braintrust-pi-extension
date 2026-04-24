#!/usr/bin/env node

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const packages = ["@mariozechner/pi-coding-agent", "@mariozechner/pi-ai"];
const count = Number(process.env.PI_VERSION_COUNT ?? "6");
const stableVersionPattern = /^\d+\.\d+\.\d+$/;

if (!Number.isInteger(count) || count <= 0) {
  throw new Error(
    `PI_VERSION_COUNT must be a positive integer, got: ${process.env.PI_VERSION_COUNT ?? "undefined"}`,
  );
}

const npmQueryDirectory = mkdtempSync(join(tmpdir(), "pi-version-query-"));

function npmViewVersions(packageName) {
  const output = execFileSync("npm", ["view", packageName, "versions", "--json"], {
    cwd: npmQueryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

  const parsed = JSON.parse(output);
  const versions = Array.isArray(parsed) ? parsed : [parsed];
  return versions.filter((version) => stableVersionPattern.test(version));
}

function compareVersions(a, b) {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const delta = aParts[index] - bParts[index];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

const sharedVersions =
  packages
    .map((packageName) => npmViewVersions(packageName))
    .reduce((commonVersions, packageVersions) => {
      if (commonVersions === null) {
        return packageVersions;
      }

      const packageVersionSet = new Set(packageVersions);
      return commonVersions.filter((version) => packageVersionSet.has(version));
    }, null)
    ?.sort(compareVersions) ?? [];

const releaseLines = [];

for (const version of sharedVersions) {
  const [major, minor] = version.split(".");
  const line = `${major}.${minor}`;
  const previousReleaseLine = releaseLines.at(-1);

  if (previousReleaseLine?.line === line) {
    previousReleaseLine.version = version;
    continue;
  }

  releaseLines.push({ line, version });
}

const selectedVersions = releaseLines.map(({ version }) => version).slice(-count);

if (selectedVersions.length < count) {
  throw new Error(
    `Expected at least ${count} shared stable pi release lines across ${packages.join(", ")}, found ${selectedVersions.length}`,
  );
}

const outputs = {
  versions: JSON.stringify(selectedVersions),
  latest: selectedVersions[selectedVersions.length - 1],
  oldest: selectedVersions[0],
};

if (process.env.GITHUB_OUTPUT) {
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Supported pi compatibility versions",
      "",
      `Testing the latest ${count} shared stable pi release lines: ${selectedVersions.join(", ")}`,
      "",
    ].join("\n"),
  );
}

console.log(`Resolved pi compatibility versions: ${selectedVersions.join(", ")}`);
