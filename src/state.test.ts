import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "./state.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("createStateStore", () => {
  it("loads valid sessions and prunes expired ones on startup", () => {
    const stateDir = makeTempDir("trace-pi-state-");
    const now = Date.now();
    const oldTimestamp = now - 31 * 24 * 60 * 60 * 1000;

    writeFileSync(
      join(stateDir, "sessions.json"),
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            fresh: {
              rootSpanId: "fresh-root",
              startedAt: now,
              totalTurns: 2,
            },
            expired: {
              rootSpanId: "old-root",
              startedAt: oldTimestamp,
              lastSeenAt: oldTimestamp,
            },
            invalid: {
              startedAt: now,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const store = createStateStore(stateDir);

    expect(store.get("fresh")).toMatchObject({ rootSpanId: "fresh-root", totalTurns: 2 });
    expect(store.get("expired")).toBeUndefined();
    expect(store.get("invalid")).toBeUndefined();

    const persisted = JSON.parse(readFileSync(join(stateDir, "sessions.json"), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(persisted.sessions)).toEqual(["fresh"]);
  });

  it("persists set, patch, and delete operations", () => {
    const stateDir = makeTempDir("trace-pi-state-");
    const store = createStateStore(stateDir);

    store.set("session-1", {
      rootSpanId: "root-1",
      startedAt: 1,
      totalTurns: 1,
    });
    store.patch("session-1", {
      totalTurns: 3,
      totalToolCalls: 5,
    });

    expect(store.get("session-1")).toEqual({
      rootSpanId: "root-1",
      startedAt: 1,
      totalTurns: 3,
      totalToolCalls: 5,
    });

    let persisted = JSON.parse(readFileSync(join(stateDir, "sessions.json"), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(persisted.sessions["session-1"]).toEqual({
      rootSpanId: "root-1",
      startedAt: 1,
      totalTurns: 3,
      totalToolCalls: 5,
    });

    store.delete("session-1");
    persisted = JSON.parse(readFileSync(join(stateDir, "sessions.json"), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(persisted.sessions).toEqual({});
  });
});
