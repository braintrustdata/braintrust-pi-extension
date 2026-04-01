import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "./config.ts";
import type { TraceConfig } from "./types.ts";

const ENV_KEYS = [
  "HOME",
  "BRAINTRUST_API_KEY",
  "BRAINTRUST_API_URL",
  "BRAINTRUST_APP_URL",
  "BRAINTRUST_ORG_NAME",
  "BRAINTRUST_PROJECT",
  "TRACE_TO_BRAINTRUST",
  "BRAINTRUST_DEBUG",
  "BRAINTRUST_LOG_FILE",
  "BRAINTRUST_STATE_DIR",
  "PI_PARENT_SPAN_ID",
  "PI_ROOT_SPAN_ID",
  "BRAINTRUST_ADDITIONAL_METADATA",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("loadConfig", () => {
  it("applies global config, project config, then env overrides", () => {
    const home = makeTempDir("trace-pi-home-");
    const cwd = join(home, "workspace");
    const projectStateDir = join(home, "project-state");
    const envStateDir = join(home, "env-state");

    process.env.HOME = home;
    process.env.BRAINTRUST_PROJECT = "from-env";
    process.env.TRACE_TO_BRAINTRUST = "false";
    process.env.BRAINTRUST_ADDITIONAL_METADATA = '{"origin":"env","team":"platform"}';
    process.env.BRAINTRUST_STATE_DIR = envStateDir;

    writeJson(join(home, ".pi", "agent", "braintrust.json"), {
      api_key: "global-key",
      api_url: "https://global.example",
      project: "from-global",
      trace_to_braintrust: false,
      debug: true,
      additional_metadata: { origin: "global" },
    });

    writeJson(join(cwd, ".pi", "braintrust.json"), {
      api_url: "https://project.example",
      project: "from-project",
      trace_to_braintrust: true,
      state_dir: projectStateDir,
      additional_metadata: { origin: "project" },
    });

    const config = loadConfig(cwd);

    expect(config.apiKey).toBe("global-key");
    expect(config.apiUrl).toBe("https://project.example");
    expect(config.projectName).toBe("from-env");
    expect(config.enabled).toBe(false);
    expect(config.additionalMetadata).toEqual({ origin: "env", team: "platform" });
    expect(config.stateDir).toBe(envStateDir);
    expect(config.configErrors).toEqual([]);
    expect(existsSync(envStateDir)).toBe(true);
  });

  it("records config file parse errors without throwing away other valid config sources", () => {
    const home = makeTempDir("trace-pi-home-");
    const cwd = join(home, "workspace");

    process.env.HOME = home;

    mkdirSync(dirname(join(home, ".pi", "agent", "braintrust.json")), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "braintrust.json"),
      '{\n  "trace_to_braintrust": true,\n  "api_key": "bad-json",\n}\n',
      "utf8",
    );

    writeJson(join(cwd, ".pi", "braintrust.json"), {
      trace_to_braintrust: true,
      project: "from-project",
    });

    const config = loadConfig(cwd);

    expect(config.enabled).toBe(true);
    expect(config.projectName).toBe("from-project");
    expect(config.configErrors).toHaveLength(1);
    expect(config.configErrors[0]).toMatchObject({
      path: join(home, ".pi", "agent", "braintrust.json"),
    });
    expect(config.configErrors[0]?.message).toContain("JSON");
  });

  it("mirrors the parent span id to the root span id when only parent is provided", () => {
    const home = makeTempDir("trace-pi-home-");
    process.env.HOME = home;
    process.env.BRAINTRUST_STATE_DIR = join(home, "state");
    process.env.PI_PARENT_SPAN_ID = "parent-123";

    const config = loadConfig(home);

    expect(config.parentSpanId).toBe("parent-123");
    expect(config.rootSpanId).toBe("parent-123");
  });

  it("mirrors the root span id to the parent span id when only root is provided", () => {
    const home = makeTempDir("trace-pi-home-");
    process.env.HOME = home;
    process.env.BRAINTRUST_STATE_DIR = join(home, "state");
    process.env.PI_ROOT_SPAN_ID = "root-123";

    const config = loadConfig(home);

    expect(config.rootSpanId).toBe("root-123");
    expect(config.parentSpanId).toBe("root-123");
  });
});

describe("createLogger", () => {
  it("writes json log lines to the default log file when debug is enabled", () => {
    const stateDir = makeTempDir("trace-pi-state-");
    const config: TraceConfig = {
      enabled: true,
      apiKey: "key",
      apiUrl: undefined,
      appUrl: "https://www.braintrust.dev",
      orgName: undefined,
      projectName: "pi",
      debug: true,
      logFile: undefined,
      stateDir,
      additionalMetadata: {},
      parentSpanId: undefined,
      rootSpanId: undefined,
      configErrors: [],
    };

    const logger = createLogger(config);
    logger.debug("debug message", { nested: { value: 1 } });
    logger.warn("warn message");

    const lines = readFileSync(logger.filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "debug",
      message: "debug message",
      data: { nested: { value: 1 } },
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      level: "warn",
      message: "warn message",
    });
  });
});
