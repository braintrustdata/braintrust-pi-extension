import { basename, resolve } from "node:path";
import { hostname, userInfo } from "node:os";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BraintrustClient, type BraintrustSpanHandle } from "./client.ts";
import { createLogger, loadConfig } from "./config.ts";
import { createStateStore } from "./state.ts";
import type {
  AgentMessageLike,
  AssistantMessageLike,
  ConfigIssue,
  ImageLike,
  NormalizedAgentMessage,
  NormalizedAssistantMessage,
  TraceConfig,
} from "./types.ts";
import {
  buildTurnInput,
  extractErrorText,
  formatToolSpanName,
  generateUuid,
  isPlainObject,
  normalizeAssistantMessage,
  normalizeContextMessages,
  normalizeToolResult,
  repoSlugForCwd,
  rootSpanName,
  sessionKeyFor,
  shortHash,
  toUnixSeconds,
} from "./utils.ts";

const EXTENSION_VERSION = "0.1.0";
const TRACING_STATUS_KEY = "braintrust-tracing";
const TRACING_WIDGET_KEY = "braintrust-trace-link";

interface SessionDescriptor {
  sessionFile: string | undefined;
  sessionId: string | undefined;
  sessionKey: string;
}

interface PendingLlmCall {
  startedAt: number;
  input: NormalizedAgentMessage[];
}

interface TrackedToolStart {
  startedAt: number;
  args: unknown;
  toolName: string;
}

interface ActiveTurn {
  spanId: string;
  span?: BraintrustSpanHandle;
  prompt: string;
  llmCalls: PendingLlmCall[];
  llmCallCount: number;
  toolCallCount: number;
  toolStarts: Map<string, TrackedToolStart>;
  toolParentSpanIds: Map<string, string>;
  lastAssistantMessage?: AssistantMessageLike;
  lastOutput?: NormalizedAssistantMessage;
  error?: string;
}

interface ActiveSession {
  sessionKey: string;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  openedVia?: string;
  parentSessionFile?: string;
  rootSpanId?: string;
  rootSpan?: BraintrustSpanHandle;
  rootSpanRecordId?: string;
  traceRootSpanId?: string;
  parentSpanId?: string;
  traceUrl?: string;
  traceUrlPromise?: Promise<void>;
  startedAt?: number;
  totalTurns: number;
  totalToolCalls: number;
  currentTurn?: ActiveTurn;
}

function hasSessionRoot(session: ActiveSession | undefined): session is ActiveSession & {
  rootSpanId: string;
  traceRootSpanId: string;
  startedAt: number;
} {
  return Boolean(
    session &&
    typeof session.rootSpanId === "string" &&
    typeof session.traceRootSpanId === "string" &&
    typeof session.startedAt === "number",
  );
}

function getUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

function getSessionDescriptor(ctx: ExtensionContext): SessionDescriptor {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionKey = sessionKeyFor(sessionFile ? resolve(sessionFile) : undefined, sessionId);

  return {
    sessionFile,
    sessionId,
    sessionKey,
  };
}

function safeModelName(model: unknown): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  if (!isPlainObject(model)) return undefined;
  const provider = model.provider ?? model.providerId ?? model.providerID;
  const id = model.id ?? model.modelId ?? model.modelID;
  if (typeof provider === "string" && typeof id === "string") return `${provider}/${id}`;
  if (typeof id === "string") return id;
  return undefined;
}

function getPreviousSessionFile(event: unknown): string | undefined {
  if (!isPlainObject(event)) return undefined;
  return typeof event.previousSessionFile === "string" ? event.previousSessionFile : undefined;
}

function getSessionStartReason(event: unknown): string | undefined {
  if (!isPlainObject(event)) return undefined;
  return typeof event.reason === "string" ? event.reason : undefined;
}

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
  return isPlainObject(message) && message.role === "assistant";
}

function findLastAssistant(
  messages: AgentEndEvent["messages"] = [],
): AssistantMessageLike | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) return message;
  }
  return undefined;
}

function standardRootMetadata(ctx: ExtensionContext, config: TraceConfig): Record<string, unknown> {
  const descriptor = getSessionDescriptor(ctx);
  return {
    ...config.additionalMetadata,
    source: "pi",
    extension_version: EXTENSION_VERSION,
    session_id: descriptor.sessionId,
    session_key: descriptor.sessionKey,
    session_file: descriptor.sessionFile,
    workspace: basename(ctx.cwd),
    directory: ctx.cwd,
    repo: repoSlugForCwd(ctx.cwd),
    hostname: hostname(),
    username: getUsername(),
    os: process.platform,
  };
}

function projectTraceUrl(config: TraceConfig, traceId: string | undefined): string | undefined {
  if (!traceId || !config.orgName) return undefined;
  return `${config.appUrl}/app/${encodeURIComponent(config.orgName)}/p/${encodeURIComponent(config.projectName)}/logs?oid=${encodeURIComponent(traceId)}`;
}

function primaryConfigIssue(config: TraceConfig): ConfigIssue | undefined {
  return config.configIssues.find((issue) => issue.severity === "error") ?? config.configIssues[0];
}

function configIssueStatusLabel(issue: ConfigIssue | undefined): string | undefined {
  if (!issue) return undefined;
  return issue.severity === "warning" ? "config warning" : "config error";
}

function setTracingStatus(
  ctx: ExtensionContext,
  config: TraceConfig,
  options: {
    active: boolean;
    initError?: string;
    missingApiKey?: boolean;
    configIssue?: ConfigIssue;
  },
): void {
  if (!ctx.hasUI || !config.showUi) {
    if (ctx.hasUI) ctx.ui.setStatus(TRACING_STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;

  if (options.initError) {
    ctx.ui.setStatus(
      TRACING_STATUS_KEY,
      theme.fg("warning", "Braintrust") + theme.fg("dim", " setup failed"),
    );
    return;
  }

  if (options.active) {
    ctx.ui.setStatus(
      TRACING_STATUS_KEY,
      theme.fg("accent", "Braintrust") +
        theme.fg(
          "dim",
          ` tracing ${config.projectName}${options.configIssue ? " (config warning)" : ""}`,
        ),
    );
    return;
  }

  if (options.missingApiKey) {
    ctx.ui.setStatus(
      TRACING_STATUS_KEY,
      theme.fg("warning", "Braintrust") + theme.fg("dim", " missing API key"),
    );
    return;
  }

  const configIssueLabel = configIssueStatusLabel(options.configIssue);
  if (configIssueLabel) {
    ctx.ui.setStatus(
      TRACING_STATUS_KEY,
      theme.fg("warning", "Braintrust") + theme.fg("dim", ` ${configIssueLabel}`),
    );
    return;
  }

  ctx.ui.setStatus(TRACING_STATUS_KEY, undefined);
}

function makeHyperlink(url: string, text: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const left = Math.max(1, Math.floor((maxLength - 1) / 2));
  const right = Math.max(1, maxLength - left - 1);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function shortenTraceUrl(traceUrl: string): string {
  try {
    const parsed = new URL(traceUrl);
    const host = parsed.host.replace(/^www\./, "");
    const oid = parsed.searchParams.get("oid") ?? parsed.searchParams.get("id");
    const shortOid = oid ? truncateMiddle(oid, 16) : undefined;
    const suffix = shortOid ? `?oid=${shortOid}` : "";
    return truncateMiddle(`${host}${parsed.pathname}${suffix}`, 72);
  } catch {
    return truncateMiddle(traceUrl, 72);
  }
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function setTraceWidget(
  ctx: ExtensionContext,
  config: TraceConfig,
  traceUrl: string | undefined,
  configIssue: ConfigIssue | undefined,
): void {
  if (!ctx.hasUI || !config.showUi) {
    if (ctx.hasUI) ctx.ui.setWidget(TRACING_WIDGET_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const lines: string[] = [];

  if (traceUrl && config.showTraceLink) {
    const label = makeHyperlink(
      traceUrl,
      theme.fg("accent", theme.underline("Braintrust trace ↗")),
    );
    lines.push(label, theme.fg("dim", shortenTraceUrl(traceUrl)));
  }

  if (configIssue) {
    const issueLabel =
      traceUrl || configIssue.severity === "warning"
        ? "Braintrust config warning"
        : "Braintrust config error";
    lines.push(
      theme.fg("warning", issueLabel),
      theme.fg(
        "dim",
        truncateMiddle(`${displayPath(configIssue.path)}: ${configIssue.message}`, 120),
      ),
    );
  }

  ctx.ui.setWidget(TRACING_WIDGET_KEY, lines.length > 0 ? lines : undefined, {
    placement: "belowEditor",
  });
}

export default function braintrustPiExtension(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  const logger = createLogger(config);
  const store = createStateStore(config.stateDir, logger);

  let client: BraintrustClient | undefined;
  let clientInitializationError: string | undefined;

  if (config.enabled && config.apiKey) {
    client = new BraintrustClient(config, logger);
    client.initialize().catch((error: unknown) => {
      clientInitializationError = String(error);
      logger.error("failed to initialize Braintrust client", { error: clientInitializationError });
    });
  } else if (config.enabled && !config.apiKey) {
    logger.warn("TRACE_TO_BRAINTRUST is enabled but BRAINTRUST_API_KEY is missing");
  }

  function tracingEnabled(): boolean {
    return Boolean(config.enabled && client && !clientInitializationError);
  }

  function refreshTracingUi(ctx: ExtensionContext): void {
    const configIssue = primaryConfigIssue(config);
    setTracingStatus(ctx, config, {
      active: tracingEnabled(),
      initError: clientInitializationError,
      missingApiKey: Boolean(config.enabled && !config.apiKey),
      configIssue,
    });
    setTraceWidget(ctx, config, activeSession?.traceUrl, configIssue);
  }

  function persistTraceUrl(session: ActiveSession, traceUrl: string): void {
    session.traceUrl = traceUrl;
    store.patch(session.sessionKey, {
      traceUrl,
      lastSeenAt: Date.now(),
    });
  }

  function refreshTraceUrl(ctx: ExtensionContext, session: ActiveSession): void {
    if (!client || session.traceUrlPromise || !hasSessionRoot(session)) return;

    const quickUrl =
      session.traceUrl ??
      client.getSpanLink(session.rootSpan) ??
      projectTraceUrl(config, session.rootSpanRecordId);

    if (quickUrl && quickUrl !== session.traceUrl) {
      persistTraceUrl(session, quickUrl);
      if (activeSession?.sessionKey === session.sessionKey) refreshTracingUi(ctx);
    }

    if (!session.rootSpan || session.traceUrl) return;

    session.traceUrlPromise = client
      .getSpanPermalink(session.rootSpan)
      .then((traceUrl) => {
        if (!traceUrl || traceUrl === session.traceUrl) return;
        persistTraceUrl(session, traceUrl);
        if (activeSession?.sessionKey === session.sessionKey) refreshTracingUi(ctx);
      })
      .finally(() => {
        session.traceUrlPromise = undefined;
      });
  }

  let activeSession: ActiveSession | undefined;

  function materializeSessionRoot(
    ctx: ExtensionContext,
    session: ActiveSession,
  ): ActiveSession | undefined {
    if (!client) return undefined;
    if (hasSessionRoot(session)) return session;

    const startedAt = Date.now();
    const rootSpanId = generateUuid();
    const traceRootSpanId = config.rootSpanId ?? rootSpanId;
    const parentSpanId = config.parentSpanId;
    const rootSpan = client.startSpan({
      spanId: rootSpanId,
      rootSpanId: traceRootSpanId,
      parentSpanId,
      startedAt,
      name: rootSpanName(ctx.cwd),
      type: "task",
      metadata: {
        ...standardRootMetadata(ctx, config),
        opened_via: session.openedVia,
        parent_session_file: session.parentSessionFile,
      },
    });

    session.rootSpanId = rootSpanId;
    session.rootSpan = rootSpan;
    session.rootSpanRecordId = rootSpan?.id;
    session.traceRootSpanId = traceRootSpanId;
    session.parentSpanId = parentSpanId;
    session.traceUrl = client.getSpanLink(rootSpan) ?? projectTraceUrl(config, rootSpan?.id);
    session.startedAt = startedAt;

    store.set(session.sessionKey, {
      rootSpanId,
      rootSpanRecordId: rootSpan?.id,
      traceRootSpanId,
      parentSpanId,
      traceUrl: session.traceUrl,
      startedAt,
      totalTurns: session.totalTurns,
      totalToolCalls: session.totalToolCalls,
      lastSeenAt: startedAt,
      sessionFile: session.sessionFile,
    });
    store.schedulePersist(0);

    refreshTracingUi(ctx);
    refreshTraceUrl(ctx, session);
    return session;
  }

  async function ensureSession(
    ctx: ExtensionContext,
    options: {
      reason?: string;
      parentSessionFile?: string | undefined;
      createIfMissingRoot?: boolean;
    } = {},
  ): Promise<ActiveSession | undefined> {
    if (!tracingEnabled() || !client) return undefined;

    const descriptor = getSessionDescriptor(ctx);
    if (activeSession?.sessionKey === descriptor.sessionKey) {
      activeSession.sessionFile = descriptor.sessionFile;
      activeSession.sessionId = descriptor.sessionId;
      if (!hasSessionRoot(activeSession)) {
        activeSession.openedVia ??= options.reason;
        activeSession.parentSessionFile ??= options.parentSessionFile;
      }

      if (options.createIfMissingRoot === false) {
        refreshTracingUi(ctx);
        return activeSession;
      }

      return materializeSessionRoot(ctx, activeSession);
    }

    const persisted = store.get(descriptor.sessionKey);
    if (persisted) {
      activeSession = {
        sessionKey: descriptor.sessionKey,
        sessionFile: descriptor.sessionFile,
        sessionId: descriptor.sessionId,
        openedVia: options.reason,
        parentSessionFile: options.parentSessionFile,
        rootSpanId: persisted.rootSpanId,
        rootSpan: undefined,
        rootSpanRecordId: persisted.rootSpanRecordId,
        traceRootSpanId: persisted.traceRootSpanId ?? persisted.rootSpanId,
        parentSpanId: persisted.parentSpanId,
        traceUrl: persisted.traceUrl ?? projectTraceUrl(config, persisted.rootSpanRecordId),
        startedAt: persisted.startedAt,
        totalTurns: persisted.totalTurns ?? 0,
        totalToolCalls: persisted.totalToolCalls ?? 0,
        currentTurn: undefined,
      };
      store.patch(descriptor.sessionKey, {
        traceUrl: activeSession.traceUrl,
        lastSeenAt: Date.now(),
        sessionFile: descriptor.sessionFile,
      });
      refreshTracingUi(ctx);
      return activeSession;
    }

    activeSession = {
      sessionKey: descriptor.sessionKey,
      sessionFile: descriptor.sessionFile,
      sessionId: descriptor.sessionId,
      openedVia: options.reason,
      parentSessionFile: options.parentSessionFile,
      totalTurns: 0,
      totalToolCalls: 0,
      currentTurn: undefined,
    };

    if (options.createIfMissingRoot === false) {
      refreshTracingUi(ctx);
      return activeSession;
    }

    return materializeSessionRoot(ctx, activeSession);
  }

  async function finishTurn(
    reason: string,
    endedAt = Date.now(),
    finalAssistantMessage?: AssistantMessageLike,
  ): Promise<void> {
    if (!activeSession?.currentTurn || !client) return;

    const turn = activeSession.currentTurn;
    const finalAssistant = finalAssistantMessage ?? turn.lastAssistantMessage;
    const finalOutput = finalAssistant
      ? normalizeAssistantMessage(finalAssistant)
      : turn.lastOutput;
    const error =
      turn.error ||
      (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted"
        ? extractErrorText(finalAssistant, finalAssistant.errorMessage)
        : undefined);

    client.logSpan(turn.span, {
      output: finalOutput,
      error,
      metadata: {
        llm_calls: turn.llmCallCount,
        tool_calls: turn.toolCallCount,
        finish_reason: reason,
      },
    });
    client.endSpan(turn.span, endedAt);

    activeSession.currentTurn = undefined;
    store.patch(activeSession.sessionKey, {
      totalTurns: activeSession.totalTurns,
      totalToolCalls: activeSession.totalToolCalls,
      lastSeenAt: endedAt,
    });
    await store.flush();
  }

  async function finalizeSession(reason: string, endedAt = Date.now()): Promise<void> {
    if (!activeSession || !client) return;

    await finishTurn(reason, endedAt);
    if (!hasSessionRoot(activeSession)) return;

    const summaryMetadata = {
      total_turns: activeSession.totalTurns,
      total_tool_calls: activeSession.totalToolCalls,
      last_close_reason: reason,
    };

    if (activeSession.rootSpan) {
      client.logSpan(activeSession.rootSpan, {
        metadata: summaryMetadata,
      });
      client.endSpan(activeSession.rootSpan, endedAt);
    } else if (activeSession.rootSpanRecordId) {
      client.updateSpan({
        id: activeSession.rootSpanRecordId,
        spanId: activeSession.rootSpanId,
        rootSpanId: activeSession.traceRootSpanId,
        metadata: summaryMetadata,
        metrics: {
          end: toUnixSeconds(endedAt),
        },
      });
    }

    store.patch(activeSession.sessionKey, {
      totalTurns: activeSession.totalTurns,
      totalToolCalls: activeSession.totalToolCalls,
      lastSeenAt: endedAt,
    });
    await store.flush();
  }

  async function rolloverSession(
    ctx: ExtensionContext,
    reason: string,
    previousSessionFile: string | undefined,
  ): Promise<void> {
    if (!tracingEnabled()) return;

    const previousKey = activeSession?.sessionKey;
    const nextKey = getSessionDescriptor(ctx).sessionKey;
    if (previousKey && previousKey !== nextKey) {
      await finalizeSession(reason);
      activeSession = undefined;
    }

    await ensureSession(ctx, {
      reason,
      parentSessionFile: previousSessionFile,
      createIfMissingRoot: false,
    });
  }

  pi.on("session_start", async (event, ctx) => {
    refreshTracingUi(ctx);

    const reason = getSessionStartReason(event);
    if (reason === "new" || reason === "resume" || reason === "fork") {
      await rolloverSession(
        ctx,
        reason === "fork" ? "session_fork" : "session_switch",
        getPreviousSessionFile(event),
      );
      return;
    }

    await ensureSession(ctx, {
      reason: "session_start",
      createIfMissingRoot: false,
    });
  });

  pi.on("session_switch", async (event, ctx) => {
    refreshTracingUi(ctx);
    await rolloverSession(ctx, "session_switch", getPreviousSessionFile(event));
  });

  pi.on("session_fork", async (event, ctx) => {
    refreshTracingUi(ctx);
    await rolloverSession(ctx, "session_fork", getPreviousSessionFile(event));
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshTracingUi(ctx);
    const session = await ensureSession(ctx, { reason: "agent_start" });
    if (!session || !client || !hasSessionRoot(session)) return;

    if (session.currentTurn) {
      await finishTurn("replaced_by_new_prompt", Date.now());
    }

    const startedAt = Date.now();
    session.totalTurns += 1;
    const turnSpanId = generateUuid();
    const turnInput = buildTurnInput(
      event.prompt,
      event.images as readonly ImageLike[] | undefined,
    );
    const turnSpan = client.startSpan({
      spanId: turnSpanId,
      rootSpanId: session.traceRootSpanId,
      parentSpanId: session.rootSpanId,
      startedAt,
      input: turnInput,
      metadata: {
        turn_number: session.totalTurns,
        active_model: safeModelName(ctx.model),
      },
      name: `Turn ${session.totalTurns}`,
      type: "task",
    });

    session.currentTurn = {
      spanId: turnSpanId,
      span: turnSpan,
      prompt: turnInput,
      llmCalls: [],
      llmCallCount: 0,
      toolCallCount: 0,
      toolStarts: new Map(),
      toolParentSpanIds: new Map(),
      lastAssistantMessage: undefined,
      lastOutput: undefined,
      error: undefined,
    };

    store.patch(session.sessionKey, {
      totalTurns: session.totalTurns,
      lastSeenAt: startedAt,
    });
  });

  pi.on("context", async (event) => {
    if (!activeSession?.currentTurn) return;
    activeSession.currentTurn.llmCalls.push({
      startedAt: Date.now(),
      input: normalizeContextMessages(event.messages as unknown as readonly AgentMessageLike[]),
    });
  });

  pi.on("message_end", async (event) => {
    const session = activeSession;
    if (
      !session?.currentTurn ||
      !isAssistantMessage(event.message) ||
      !client ||
      !hasSessionRoot(session)
    ) {
      return;
    }
    const message = event.message;

    const pending = session.currentTurn.llmCalls.shift() ?? {
      startedAt: Date.now(),
      input: [{ role: "user", content: session.currentTurn.prompt }],
    };

    const modelName = safeModelName(message) ?? message.model;
    const endedAt = message.timestamp ?? Date.now();
    const normalizedOutput = normalizeAssistantMessage(message);
    const error =
      message.stopReason === "error" || message.stopReason === "aborted"
        ? extractErrorText(message, message.errorMessage)
        : undefined;

    session.currentTurn.llmCallCount += 1;
    session.currentTurn.lastAssistantMessage = message;
    session.currentTurn.lastOutput = normalizedOutput;
    if (error) session.currentTurn.error = error;

    const llmSpanId = generateUuid();
    const llmSpan = client.startSpan({
      spanId: llmSpanId,
      rootSpanId: session.traceRootSpanId,
      parentSpanId: session.currentTurn.spanId,
      startedAt: pending.startedAt,
      input: pending.input,
      metadata: {
        api: message.api,
        provider: message.provider,
        model: modelName,
        stop_reason: message.stopReason,
        cache_read_tokens: message.usage?.cacheRead,
        cache_write_tokens: message.usage?.cacheWrite,
      },
      name: modelName || "llm",
      type: "llm",
    });

    for (const part of message.content ?? []) {
      if (!isPlainObject(part) || part.type !== "toolCall" || typeof part.id !== "string") {
        continue;
      }
      session.currentTurn.toolParentSpanIds.set(part.id, llmSpanId);
    }

    client.logSpan(llmSpan, {
      output: [normalizedOutput],
      error,
      metrics: {
        prompt_tokens: message.usage?.input,
        completion_tokens: message.usage?.output,
        tokens: message.usage?.totalTokens,
      },
    });
    client.endSpan(llmSpan, endedAt);
  });

  pi.on("tool_execution_start", async (event) => {
    if (!activeSession?.currentTurn) return;
    activeSession.currentTurn.toolStarts.set(event.toolCallId, {
      startedAt: Date.now(),
      args: event.args,
      toolName: event.toolName,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    const session = activeSession;
    if (!session?.currentTurn || !client || !hasSessionRoot(session)) return;

    const tracked = session.currentTurn.toolStarts.get(event.toolCallId) ?? {
      startedAt: Date.now(),
      args: undefined,
      toolName: event.toolName,
    };
    session.currentTurn.toolStarts.delete(event.toolCallId);
    const parentLlmSpanId = session.currentTurn.toolParentSpanIds.get(event.toolCallId);
    session.currentTurn.toolParentSpanIds.delete(event.toolCallId);

    const endedAt = Date.now();
    session.totalToolCalls += 1;
    session.currentTurn.toolCallCount += 1;

    const output = normalizeToolResult(event.result);
    const error = event.isError
      ? extractErrorText(event.result, `${event.toolName} failed`)
      : undefined;

    if (error && !session.currentTurn.error) {
      session.currentTurn.error = error;
    }

    const toolSpan = client.startSpan({
      spanId: generateUuid(),
      rootSpanId: session.traceRootSpanId,
      parentSpanId: parentLlmSpanId ?? session.currentTurn.spanId,
      startedAt: tracked.startedAt,
      input: tracked.args,
      metadata: {
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        is_error: event.isError,
        parent_llm_span_id: parentLlmSpanId,
      },
      name: formatToolSpanName(event.toolName, tracked.args),
      type: "tool",
    });

    client.logSpan(toolSpan, {
      output,
      error,
    });
    client.endSpan(toolSpan, endedAt);

    store.patch(session.sessionKey, {
      totalTurns: session.totalTurns,
      totalToolCalls: session.totalToolCalls,
      lastSeenAt: endedAt,
    });
  });

  pi.on("agent_end", async (event) => {
    if (!activeSession?.currentTurn) return;
    const finalAssistant = findLastAssistant(event.messages);
    await finishTurn("agent_end", Date.now(), finalAssistant);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(TRACING_STATUS_KEY, undefined);
      ctx.ui.setWidget(TRACING_WIDGET_KEY, undefined);
    }
    if (client && !clientInitializationError) {
      await finalizeSession("session_shutdown");
      await client.flush();
    }
    activeSession = undefined;
    await store.flush();
    await logger.flush();
  });

  for (const configIssue of config.configIssues) {
    if (configIssue.severity === "error") {
      logger.error("Braintrust config issue", configIssue);
    } else {
      logger.warn("Braintrust config issue", configIssue);
    }
  }

  logger.debug("Braintrust pi tracing extension loaded", {
    enabled: config.enabled,
    project: config.projectName,
    hasApiKey: Boolean(config.apiKey),
    logFile: logger.filePath,
    configIssues: config.configIssues,
    configHash: shortHash(
      JSON.stringify({
        enabled: config.enabled,
        project: config.projectName,
        debug: config.debug,
        stateDir: config.stateDir,
      }),
    ),
  });
}
