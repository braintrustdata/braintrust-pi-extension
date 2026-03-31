import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  startSpans: [] as Array<Record<string, unknown>>,
  logSpans: [] as Array<Record<string, unknown>>,
  endSpans: [] as Array<Record<string, unknown>>,
  updateSpans: [] as Array<Record<string, unknown>>,
  initializeCalls: 0,
  flushCalls: 0,
}));

vi.mock("./client.ts", () => {
  class MockBraintrustClient {
    async initialize(): Promise<void> {
      mockState.initializeCalls += 1;
    }

    startSpan(args: Record<string, unknown>): Record<string, unknown> {
      mockState.startSpans.push(args);
      return {
        id: `record-${String(args.spanId)}`,
        spanId: args.spanId,
        rootSpanId: args.rootSpanId,
      };
    }

    logSpan(span: Record<string, unknown> | undefined, event: Record<string, unknown>): void {
      mockState.logSpans.push({ span, event });
    }

    endSpan(span: Record<string, unknown> | undefined, endedAt?: number): void {
      mockState.endSpans.push({ span, endedAt });
    }

    updateSpan(args: Record<string, unknown>): void {
      mockState.updateSpans.push(args);
    }

    async flush(): Promise<void> {
      mockState.flushCalls += 1;
    }
  }

  return {
    BraintrustClient: MockBraintrustClient,
  };
});

vi.mock("./config.ts", () => ({
  loadConfig: () => ({
    enabled: true,
    apiKey: "test-key",
    apiUrl: undefined,
    appUrl: "https://www.braintrust.dev",
    orgName: undefined,
    projectName: "pi",
    debug: false,
    logFile: undefined,
    stateDir: "/tmp/braintrust-trace-pi-test",
    additionalMetadata: {},
    parentSpanId: undefined,
    rootSpanId: undefined,
  }),
  createLogger: () => ({
    filePath: "/tmp/braintrust-trace-pi-test.log",
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("./state.ts", () => ({
  createStateStore: () => ({
    get: () => undefined,
    set: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
  }),
}));

beforeEach(() => {
  mockState.startSpans.length = 0;
  mockState.logSpans.length = 0;
  mockState.endSpans.length = 0;
  mockState.updateSpans.length = 0;
  mockState.initializeCalls = 0;
  mockState.flushCalls = 0;
  vi.resetModules();
});

async function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const { default: braintrustPiExtension } = await import("./index.ts");

  braintrustPiExtension({
    on(eventName: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(eventName, handler);
    },
  } as never);

  const ctx = {
    cwd: "/tmp/workspace",
    model: "anthropic/claude-sonnet-4",
    sessionManager: {
      getSessionFile: () => "/tmp/session.json",
      getSessionId: () => "session-1",
    },
  };

  async function emit(eventName: string, event: Record<string, unknown> = {}): Promise<void> {
    const handler = handlers.get(eventName);
    if (!handler) throw new Error(`No handler registered for ${eventName}`);
    await handler(event, ctx);
  }

  return { emit };
}

describe("braintrustPiExtension", () => {
  it("parents tool spans under the llm span that emitted the matching tool call", async () => {
    const { emit } = await createHarness();

    await emit("session_start");
    await emit("before_agent_start", {
      prompt: "Inspect the package",
      images: [],
    });
    await emit("message_end", {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4",
        timestamp: 1_700_000_000_000,
        content: [
          { type: "text", text: "I'll inspect package.json." },
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
    });
    await emit("tool_execution_start", {
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "package.json" },
    });
    await emit("tool_execution_end", {
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      result: {
        content: [{ type: "text", text: '{"name":"@braintrust/trace-pi"}' }],
      },
    });

    const llmSpan = mockState.startSpans.find((span) => span.type === "llm");
    const toolSpan = mockState.startSpans.find((span) => span.type === "tool");

    expect(llmSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.parentSpanId).toBe(llmSpan?.spanId);
    expect(toolSpan?.metadata).toMatchObject({
      tool_name: "read",
      tool_call_id: "tool-1",
      parent_llm_span_id: llmSpan?.spanId,
    });
  });

  it("falls back to the turn span when no matching tool call was emitted by the llm", async () => {
    const { emit } = await createHarness();

    await emit("session_start");
    await emit("before_agent_start", {
      prompt: "Run the test suite",
      images: [],
    });
    await emit("message_end", {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4",
        timestamp: 1_700_000_000_001,
        content: [{ type: "text", text: "Running the test suite." }],
      },
    });
    await emit("tool_execution_start", {
      toolCallId: "tool-missing",
      toolName: "bash",
      args: { command: "npm test" },
    });
    await emit("tool_execution_end", {
      toolCallId: "tool-missing",
      toolName: "bash",
      isError: false,
      result: {
        content: [{ type: "text", text: "tests passed" }],
      },
    });

    const turnSpan = mockState.startSpans.find(
      (span) => span.type === "task" && span.name === "Turn 1",
    );
    const toolSpan = mockState.startSpans.find((span) => span.type === "tool");

    expect(turnSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.parentSpanId).toBe(turnSpan?.spanId);
    expect(toolSpan?.metadata).toMatchObject({
      tool_name: "bash",
      tool_call_id: "tool-missing",
    });
    expect((toolSpan?.metadata as Record<string, unknown> | undefined)?.parent_llm_span_id).toBe(
      undefined,
    );
  });
});
