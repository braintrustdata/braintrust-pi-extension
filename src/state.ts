import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger, PersistedSessionState, StateStore } from "./types.ts";
import { ensureDir, isPlainObject } from "./utils.ts";

const STATE_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoreData {
  version: number;
  sessions: Record<string, PersistedSessionState>;
}

function normalizeSessions(value: unknown): Record<string, PersistedSessionState> {
  if (!isPlainObject(value)) return {};

  const sessions: Record<string, PersistedSessionState> = {};
  for (const [key, session] of Object.entries(value)) {
    if (
      isPlainObject(session) &&
      typeof session.rootSpanId === "string" &&
      typeof session.startedAt === "number"
    ) {
      sessions[key] = {
        rootSpanId: session.rootSpanId,
        rootSpanRecordId:
          typeof session.rootSpanRecordId === "string" ? session.rootSpanRecordId : undefined,
        traceRootSpanId:
          typeof session.traceRootSpanId === "string" ? session.traceRootSpanId : undefined,
        parentSpanId: typeof session.parentSpanId === "string" ? session.parentSpanId : undefined,
        startedAt: session.startedAt,
        totalTurns: typeof session.totalTurns === "number" ? session.totalTurns : undefined,
        totalToolCalls:
          typeof session.totalToolCalls === "number" ? session.totalToolCalls : undefined,
        lastSeenAt: typeof session.lastSeenAt === "number" ? session.lastSeenAt : undefined,
        sessionFile: typeof session.sessionFile === "string" ? session.sessionFile : undefined,
      };
    }
  }

  return sessions;
}

export function createStateStore(stateDir: string, logger?: Logger): StateStore {
  ensureDir(stateDir);
  const stateFile = join(stateDir, "sessions.json");

  let state: StoreData = {
    version: STATE_VERSION,
    sessions: {},
  };

  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
      if (isPlainObject(parsed)) {
        state = {
          version: STATE_VERSION,
          sessions: normalizeSessions(parsed.sessions),
        };
      }
    } catch (error) {
      logger?.warn("failed to load state store", { error: String(error) });
    }
  }

  pruneExpired();

  function persist(): void {
    const tempFile = `${stateFile}.tmp`;
    writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempFile, stateFile);
  }

  function pruneExpired(): void {
    const cutoff = Date.now() - RETENTION_MS;
    let changed = false;

    for (const [key, value] of Object.entries(state.sessions)) {
      if ((value.lastSeenAt ?? value.startedAt ?? 0) < cutoff) {
        delete state.sessions[key];
        changed = true;
      }
    }

    if (changed) persist();
  }

  return {
    get(sessionKey) {
      return state.sessions[sessionKey];
    },
    set(sessionKey, value) {
      state.sessions[sessionKey] = value;
      persist();
      return state.sessions[sessionKey];
    },
    patch(sessionKey, patch) {
      state.sessions[sessionKey] = {
        ...state.sessions[sessionKey],
        ...patch,
      } as PersistedSessionState;
      persist();
      return state.sessions[sessionKey];
    },
    delete(sessionKey) {
      delete state.sessions[sessionKey];
      persist();
    },
  };
}
