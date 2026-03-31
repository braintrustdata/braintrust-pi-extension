import { basename, resolve } from "node:path";
import { hostname, userInfo } from "node:os";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BraintrustClient, type BraintrustSpanHandle } from "./client.ts";
import { createLogger, loadConfig } from "./config.ts";
import { createStateStore } from "./state.ts";
import type {
  AgentMessageLike,
  AssistantMessageLike,
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
  rootSpanName,
  sessionKeyFor,
  shortHash,
  toUnixSeconds,
} from "./utils.ts";

const EXTENSION_VERSION = "0.1.0";

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
  lastAssistantMessage?: AssistantMessageLike;
  lastOutput?: NormalizedAssistantMessage;
  error?: string;
}

interface ActiveSession {
  sessionKey: string;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  rootSpanId: string;
  rootSpan?: BraintrustSpanHandle;
  rootSpanRecordId?: string;
  traceRootSpanId: string;
  parentSpanId?: string;
  startedAt: number;
  totalTurns: number;
  totalToolCalls: number;
  currentTurn?: ActiveTurn;
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
    hostname: hostname(),
    username: getUsername(),
    os: process.platform,
  };
}

export default function braintrustPiExtension(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  const logger = createLogger(config);
  const store = createStateStore(config.stateDir, logger);

  let client: BraintrustClient | undefined;

  if (config.enabled && config.apiKey) {
    client = new BraintrustClient(config, logger);
    client.initialize().catch((error: unknown) => {
      logger.error("failed to initialize Braintrust client", { error: String(error) });
    });
  } else if (config.enabled && !config.apiKey) {
    logger.warn("TRACE_TO_BRAINTRUST is enabled but BRAINTRUST_API_KEY is missing");
  }

  function tracingEnabled(): boolean {
    return Boolean(config.enabled && client);
  }

  let activeSession: ActiveSession | undefined;

  async function ensureSession(
    ctx: ExtensionContext,
    options: { reason?: string; parentSessionFile?: string | undefined } = {},
  ): Promise<ActiveSession | undefined> {
    if (!tracingEnabled() || !client) return undefined;

    const descriptor = getSessionDescriptor(ctx);
    if (activeSession?.sessionKey === descriptor.sessionKey) return activeSession;

    const persisted = store.get(descriptor.sessionKey);
    if (persisted) {
      activeSession = {
        sessionKey: descriptor.sessionKey,
        sessionFile: descriptor.sessionFile,
        sessionId: descriptor.sessionId,
        rootSpanId: persisted.rootSpanId,
        rootSpan: undefined,
        rootSpanRecordId: persisted.rootSpanRecordId,
        traceRootSpanId: persisted.traceRootSpanId ?? persisted.rootSpanId,
        parentSpanId: persisted.parentSpanId,
        startedAt: persisted.startedAt,
        totalTurns: persisted.totalTurns ?? 0,
        totalToolCalls: persisted.totalToolCalls ?? 0,
        currentTurn: undefined,
      };
      store.patch(descriptor.sessionKey, {
        lastSeenAt: Date.now(),
        sessionFile: descriptor.sessionFile,
      });
      return activeSession;
    }

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
        opened_via: options.reason,
        parent_session_file: options.parentSessionFile,
      },
    });

    activeSession = {
      sessionKey: descriptor.sessionKey,
      sessionFile: descriptor.sessionFile,
      sessionId: descriptor.sessionId,
      rootSpanId,
      rootSpan,
      rootSpanRecordId: rootSpan?.id,
      traceRootSpanId,
      parentSpanId,
      startedAt,
      totalTurns: 0,
      totalToolCalls: 0,
      currentTurn: undefined,
    };

    store.set(descriptor.sessionKey, {
      rootSpanId,
      rootSpanRecordId: rootSpan?.id,
      traceRootSpanId,
      parentSpanId,
      startedAt,
      totalTurns: 0,
      totalToolCalls: 0,
      lastSeenAt: startedAt,
      sessionFile: descriptor.sessionFile,
    });

    return activeSession;
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
  }

  async function finalizeSession(reason: string, endedAt = Date.now()): Promise<void> {
    if (!activeSession || !client) return;

    await finishTurn(reason, endedAt);

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

    await ensureSession(ctx, { reason, parentSessionFile: previousSessionFile });
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureSession(ctx, { reason: "session_start" });
  });

  pi.on("session_switch", async (event, ctx) => {
    await rolloverSession(ctx, "session_switch", event.previousSessionFile);
  });

  pi.on("session_fork", async (event, ctx) => {
    await rolloverSession(ctx, "session_fork", event.previousSessionFile);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const session = await ensureSession(ctx, { reason: "agent_start" });
    if (!session || !client) return;

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
    if (!activeSession?.currentTurn || !isAssistantMessage(event.message) || !client) return;
    const message = event.message;

    const pending = activeSession.currentTurn.llmCalls.shift() ?? {
      startedAt: Date.now(),
      input: [{ role: "user", content: activeSession.currentTurn.prompt }],
    };

    const modelName = safeModelName(message) ?? message.model;
    const endedAt = message.timestamp ?? Date.now();
    const normalizedOutput = normalizeAssistantMessage(message);
    const error =
      message.stopReason === "error" || message.stopReason === "aborted"
        ? extractErrorText(message, message.errorMessage)
        : undefined;

    activeSession.currentTurn.llmCallCount += 1;
    activeSession.currentTurn.lastAssistantMessage = message;
    activeSession.currentTurn.lastOutput = normalizedOutput;
    if (error) activeSession.currentTurn.error = error;

    const llmSpan = client.startSpan({
      spanId: generateUuid(),
      rootSpanId: activeSession.traceRootSpanId,
      parentSpanId: activeSession.currentTurn.spanId,
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
    if (!activeSession?.currentTurn || !client) return;

    const tracked = activeSession.currentTurn.toolStarts.get(event.toolCallId) ?? {
      startedAt: Date.now(),
      args: undefined,
      toolName: event.toolName,
    };
    activeSession.currentTurn.toolStarts.delete(event.toolCallId);

    const endedAt = Date.now();
    activeSession.totalToolCalls += 1;
    activeSession.currentTurn.toolCallCount += 1;

    const output = normalizeToolResult(event.result);
    const error = event.isError
      ? extractErrorText(event.result, `${event.toolName} failed`)
      : undefined;

    if (error && !activeSession.currentTurn.error) {
      activeSession.currentTurn.error = error;
    }

    const toolSpan = client.startSpan({
      spanId: generateUuid(),
      rootSpanId: activeSession.traceRootSpanId,
      parentSpanId: activeSession.currentTurn.spanId,
      startedAt: tracked.startedAt,
      input: tracked.args,
      metadata: {
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        is_error: event.isError,
      },
      name: formatToolSpanName(event.toolName, tracked.args),
      type: "tool",
    });

    client.logSpan(toolSpan, {
      output,
      error,
    });
    client.endSpan(toolSpan, endedAt);

    store.patch(activeSession.sessionKey, {
      totalTurns: activeSession.totalTurns,
      totalToolCalls: activeSession.totalToolCalls,
      lastSeenAt: endedAt,
    });
  });

  pi.on("agent_end", async (event) => {
    if (!activeSession?.currentTurn) return;
    const finalAssistant = findLastAssistant(event.messages);
    await finishTurn("agent_end", Date.now(), finalAssistant);
  });

  pi.on("session_shutdown", async () => {
    if (!client) return;
    await finalizeSession("session_shutdown");
    activeSession = undefined;
    await client.flush();
  });

  logger.debug("Braintrust pi tracing extension loaded", {
    enabled: config.enabled,
    project: config.projectName,
    hasApiKey: Boolean(config.apiKey),
    logFile: logger.filePath,
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
