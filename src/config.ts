import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject, Logger, LogLevel, TraceConfig } from "./types.ts";
import {
  coerceToString,
  ensureDir,
  isPlainObject,
  parseBoolean,
  safeJsonParse,
  writeJsonLog,
} from "./utils.ts";

const DEFAULT_STATE_DIR = join(homedir(), ".pi", "agent", "state", "braintrust-trace-pi");

interface ConfigFileResult {
  value?: JsonObject;
  error?: string;
}

function readConfigFile(path: string): ConfigFileResult {
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlainObject(parsed)) {
      return {
        error: "expected a JSON object",
      };
    }
    return { value: parsed as JsonObject };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyConfig(target: TraceConfig, source: JsonObject | undefined): TraceConfig {
  if (!source) return target;

  const apiKey = coerceToString(source.api_key);
  if (apiKey !== undefined) target.apiKey = apiKey;

  const apiUrl = coerceToString(source.api_url);
  if (apiUrl !== undefined) target.apiUrl = apiUrl;

  const appUrl = coerceToString(source.app_url);
  if (appUrl !== undefined) target.appUrl = appUrl;

  const orgName = coerceToString(source.org_name);
  if (orgName !== undefined) target.orgName = orgName;

  const projectName = coerceToString(source.project);
  if (projectName !== undefined) target.projectName = projectName;

  if (source.trace_to_braintrust !== undefined) {
    target.enabled = parseBoolean(source.trace_to_braintrust, target.enabled);
  }
  if (source.debug !== undefined) target.debug = parseBoolean(source.debug, target.debug);

  const logFile = coerceToString(source.log_file);
  if (logFile !== undefined) target.logFile = logFile;

  const stateDir = coerceToString(source.state_dir);
  if (stateDir !== undefined) target.stateDir = stateDir;

  const parentSpanId = coerceToString(source.parent_span_id);
  if (parentSpanId !== undefined) target.parentSpanId = parentSpanId;

  const rootSpanId = coerceToString(source.root_span_id);
  if (rootSpanId !== undefined) target.rootSpanId = rootSpanId;

  if (isPlainObject(source.additional_metadata)) {
    target.additionalMetadata = source.additional_metadata as JsonObject;
  }

  return target;
}

export function loadConfig(cwd = process.cwd()): TraceConfig {
  const config: TraceConfig = {
    enabled: false,
    apiKey: "",
    apiUrl: undefined,
    appUrl: "https://www.braintrust.dev",
    orgName: undefined,
    projectName: "pi",
    debug: false,
    logFile: undefined,
    stateDir: DEFAULT_STATE_DIR,
    additionalMetadata: {},
    parentSpanId: undefined,
    rootSpanId: undefined,
    configErrors: [],
  };

  const globalConfigPath = join(homedir(), ".pi", "agent", "braintrust.json");
  const projectConfigPath = join(cwd, ".pi", "braintrust.json");

  const globalConfig = readConfigFile(globalConfigPath);
  if (globalConfig.error) {
    config.configErrors.push({
      path: globalConfigPath,
      message: globalConfig.error,
    });
  }
  applyConfig(config, globalConfig.value);

  const projectConfig = readConfigFile(projectConfigPath);
  if (projectConfig.error) {
    config.configErrors.push({
      path: projectConfigPath,
      message: projectConfig.error,
    });
  }
  applyConfig(config, projectConfig.value);

  if (process.env.BRAINTRUST_API_KEY) config.apiKey = process.env.BRAINTRUST_API_KEY;
  if (process.env.BRAINTRUST_API_URL) config.apiUrl = process.env.BRAINTRUST_API_URL;
  if (process.env.BRAINTRUST_APP_URL) config.appUrl = process.env.BRAINTRUST_APP_URL;
  if (process.env.BRAINTRUST_ORG_NAME) config.orgName = process.env.BRAINTRUST_ORG_NAME;
  if (process.env.BRAINTRUST_PROJECT) config.projectName = process.env.BRAINTRUST_PROJECT;
  if (process.env.TRACE_TO_BRAINTRUST !== undefined) {
    config.enabled = parseBoolean(process.env.TRACE_TO_BRAINTRUST, config.enabled);
  }
  if (process.env.BRAINTRUST_DEBUG !== undefined) {
    config.debug = parseBoolean(process.env.BRAINTRUST_DEBUG, config.debug);
  }
  if (process.env.BRAINTRUST_LOG_FILE !== undefined) {
    config.logFile = process.env.BRAINTRUST_LOG_FILE;
  }
  if (process.env.BRAINTRUST_STATE_DIR) config.stateDir = process.env.BRAINTRUST_STATE_DIR;
  if (process.env.PI_PARENT_SPAN_ID) config.parentSpanId = process.env.PI_PARENT_SPAN_ID;
  if (process.env.PI_ROOT_SPAN_ID) config.rootSpanId = process.env.PI_ROOT_SPAN_ID;
  if (process.env.BRAINTRUST_ADDITIONAL_METADATA) {
    const parsed = safeJsonParse<unknown>(process.env.BRAINTRUST_ADDITIONAL_METADATA, undefined);
    if (isPlainObject(parsed)) config.additionalMetadata = parsed as JsonObject;
  }

  if (config.parentSpanId && !config.rootSpanId) config.rootSpanId = config.parentSpanId;
  if (config.rootSpanId && !config.parentSpanId) config.parentSpanId = config.rootSpanId;

  ensureDir(config.stateDir);
  return config;
}

export function createLogger(config: TraceConfig): Logger {
  const explicitLogFile =
    config.logFile && config.logFile !== "true" && config.logFile !== "auto"
      ? config.logFile
      : join(config.stateDir, "braintrust-trace-pi.log");
  const loggingEnabled = config.debug || Boolean(config.logFile);

  if (loggingEnabled) ensureDir(dirname(explicitLogFile));

  function emit(level: LogLevel, message: string, data?: unknown): void {
    if (!loggingEnabled) return;
    writeJsonLog(explicitLogFile, level, message, data);
  }

  return {
    filePath: explicitLogFile,
    debug(message, data) {
      if (config.debug) emit("debug", message, data);
    },
    info(message, data) {
      emit("info", message, data);
    },
    warn(message, data) {
      emit("warn", message, data);
    },
    error(message, data) {
      emit("error", message, data);
    },
  };
}
