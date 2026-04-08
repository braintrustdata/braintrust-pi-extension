import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  startSpans: [] as Array<Record<string, unknown>>,
  logSpans: [] as Array<Record<string, unknown>>,
  endSpans: [] as Array<Record<string, unknown>>,
  updateSpans: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ key: string; text: string | undefined }>,
  widgets: [] as Array<{ key: string; content: string[] | undefined }>,
  initializeCalls: 0,
  flushCalls: 0,
  config: {
    enabled: true,
    apiKey: "test-key",
    apiUrl: undefined,
    appUrl: "https://www.braintrust.dev",
    orgName: undefined,
    projectName: "pi",
    debug: false,
    logFile: undefined,
    stateDir: "/tmp/braintrust-pi-extension-test",
    additionalMetadata: {},
    parentSpanId: undefined,
    rootSpanId: undefined,
    configIssues: [] as Array<{ path: string; message: string; severity: "error" | "warning" }>,
  },
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

    getSpanLink(span: Record<string, unknown> | undefined): string | undefined {
      if (!span) return undefined;
      return "https://www.braintrust.dev/app/test-org/p/pi/logs?oid=trace-row-1";
    }

    async getSpanPermalink(span: Record<string, unknown> | undefined): Promise<string | undefined> {
      return this.getSpanLink(span);
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
  loadConfig: () => ({ ...mockState.config }),
  createLogger: () => ({
    filePath: "/tmp/braintrust-pi-extension-test.log",
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
  }),
}));

vi.mock("./state.ts", () => ({
  createStateStore: () => ({
    get: () => undefined,
    set: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
    schedulePersist: () => undefined,
    flush: async () => {},
  }),
}));

beforeEach(() => {
  mockState.startSpans.length = 0;
  mockState.logSpans.length = 0;
  mockState.endSpans.length = 0;
  mockState.updateSpans.length = 0;
  mockState.statuses.length = 0;
  mockState.widgets.length = 0;
  mockState.initializeCalls = 0;
  mockState.flushCalls = 0;
  mockState.config = {
    enabled: true,
    apiKey: "test-key",
    apiUrl: undefined,
    appUrl: "https://www.braintrust.dev",
    orgName: undefined,
    projectName: "pi",
    debug: false,
    logFile: undefined,
    stateDir: "/tmp/braintrust-pi-extension-test",
    additionalMetadata: {},
    parentSpanId: undefined,
    rootSpanId: undefined,
    configIssues: [],
  };
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
    hasUI: true,
    model: "anthropic/claude-sonnet-4",
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        underline: (text: string) => text,
      },
      setStatus: (key: string, text: string | undefined) => {
        mockState.statuses.push({ key, text });
      },
      setWidget: (key: string, content: string[] | undefined, _options?: unknown) => {
        mockState.widgets.push({ key, content });
      },
    },
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
  it("shows a trace url only after the session produces a turn", async () => {
    const { emit } = await createHarness();

    await emit("session_start");

    expect(mockState.statuses[0]).toEqual({
      key: "braintrust-tracing",
      text: "Braintrust tracing pi",
    });
    expect(mockState.startSpans).toEqual([]);
    expect(mockState.widgets.at(-1)).toEqual({
      key: "braintrust-trace-link",
      content: undefined,
    });

    await emit("before_agent_start", {
      prompt: "Inspect the package",
      images: [],
    });

    expect(mockState.widgets.at(-1)?.key).toBe("braintrust-trace-link");
    expect(mockState.widgets.at(-1)?.content?.[0]).toContain("Braintrust trace ↗");
    expect(mockState.widgets.at(-1)?.content?.[1]).toBe(
      "braintrust.dev/app/test-org/p/pi/logs?oid=trace-row-1",
    );

    await emit("session_shutdown");

    expect(mockState.statuses.at(-1)).toEqual({
      key: "braintrust-tracing",
      text: undefined,
    });
    expect(mockState.widgets.at(-1)).toEqual({
      key: "braintrust-trace-link",
      content: undefined,
    });
  });

  it("surfaces malformed Braintrust config in the UI", async () => {
    mockState.config.configIssues = [
      {
        path: "/Users/test/.pi/agent/braintrust.json",
        message: "Expected double-quoted property name in JSON at position 42",
        severity: "error",
      },
    ];

    const { emit } = await createHarness();

    await emit("session_start");

    expect(mockState.statuses[0]).toEqual({
      key: "braintrust-tracing",
      text: "Braintrust tracing pi (config warning)",
    });
    expect(mockState.widgets.at(-1)?.key).toBe("braintrust-trace-link");
    expect(mockState.widgets.at(-1)?.content).toContain("Braintrust config error");
    expect(mockState.widgets.at(-1)?.content?.[1]).toContain(".pi/agent/braintrust.json");
  });

  it("does not create a root span for an idle session", async () => {
    const { emit } = await createHarness();

    await emit("session_start");
    await emit("session_shutdown");

    expect(mockState.startSpans).toEqual([]);
    expect(mockState.endSpans).toEqual([]);
    expect(mockState.updateSpans).toEqual([]);
  });

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
        content: [{ type: "text", text: '{"name":"@braintrust/pi-extension"}' }],
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

  it("preserves fork metadata when the root span is created lazily", async () => {
    const { emit } = await createHarness();

    await emit("session_start", {
      reason: "fork",
      previousSessionFile: "/tmp/parent-session.json",
    });
    await emit("before_agent_start", {
      prompt: "Continue from the fork",
      images: [],
    });

    expect(mockState.startSpans[0]).toMatchObject({
      type: "task",
      metadata: {
        opened_via: "session_fork",
        parent_session_file: "/tmp/parent-session.json",
      },
    });
  });

  it("adds the git repo slug to root span metadata when available", async () => {
    const { default: braintrustPiExtension } = await import("./index.ts");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();

    braintrustPiExtension({
      on(eventName: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(eventName, handler);
      },
    } as never);

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      model: "anthropic/claude-sonnet-4",
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          underline: (text: string) => text,
        },
        setStatus: (key: string, text: string | undefined) => {
          mockState.statuses.push({ key, text });
        },
        setWidget: (key: string, content: string[] | undefined, _options?: unknown) => {
          mockState.widgets.push({ key, content });
        },
      },
      sessionManager: {
        getSessionFile: () => "/tmp/session.json",
        getSessionId: () => "session-1",
      },
    };

    const emit = async (eventName: string, event: Record<string, unknown> = {}): Promise<void> => {
      const handler = handlers.get(eventName);
      if (!handler) throw new Error(`No handler registered for ${eventName}`);
      await handler(event, ctx);
    };

    await emit("before_agent_start", {
      prompt: "Inspect the package",
      images: [],
    });

    expect(mockState.startSpans[0]).toMatchObject({
      type: "task",
      metadata: {
        repo: "braintrustdata/braintrust-pi-extension",
      },
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
