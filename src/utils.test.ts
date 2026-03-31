import { describe, expect, it } from "vitest";
import {
  buildTurnInput,
  extractErrorText,
  formatToolSpanName,
  normalizeAssistantMessage,
  normalizeContextMessages,
  normalizeToolResult,
} from "./utils.ts";

describe("utils", () => {
  it("normalizes assistant messages with text, reasoning, and tool calls", () => {
    const normalized = normalizeAssistantMessage({
      role: "assistant",
      content: [
        { type: "text", text: "First line" },
        { type: "thinking", thinking: "Plan the next step" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "package.json" },
        },
      ],
    });

    expect(normalized).toEqual({
      role: "assistant",
      content: "First line",
      reasoning: [{ id: "thinking", content: "Plan the next step" }],
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "read",
            arguments: '{"path":"package.json"}',
          },
        },
      ],
    });
  });

  it("normalizes mixed context messages into Braintrust-friendly shapes", () => {
    const messages = normalizeContextMessages([
      { role: "user", content: [{ type: "text", text: "Use the docs" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the config" },
          { type: "thinking", redacted: true },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "README contents" }],
      },
      { role: "system", content: "ignored" },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Use the docs" },
      {
        role: "assistant",
        content: "I will inspect the config",
        reasoning: [{ id: "thinking", content: "[thinking redacted]" }],
      },
      {
        role: "tool",
        content: "README contents",
        tool_call_id: "tool-1",
        name: "read",
        is_error: false,
      },
    ]);
  });

  it("normalizes structured tool results and extracts readable error text", () => {
    const result = normalizeToolResult({
      content: [
        { type: "text", text: "command failed" },
        { type: "thinking", redacted: true },
      ],
      details: { exitCode: 1, stderr: "boom" },
      isError: true,
    });

    expect(result).toEqual({
      content: "command failed\n[thinking redacted]",
      details: { exitCode: 1, stderr: "boom" },
      isError: true,
    });

    expect(
      extractErrorText(
        {
          content: [{ type: "text", text: "tool exploded" }],
        },
        "fallback message",
      ),
    ).toBe("tool exploded");
  });

  it("formats tool span names and builds turn inputs", () => {
    expect(formatToolSpanName("read", { path: "/tmp/project/package.json" })).toBe(
      "read: package.json",
    );
    expect(formatToolSpanName("bash", { command: "npm    test   -- --runInBand" })).toBe(
      "bash: npm test -- --runInBand",
    );

    expect(
      buildTurnInput("Summarize these screenshots", [
        { source: { mediaType: "image/png" } },
        { mimeType: "image/jpeg" },
      ]),
    ).toBe("Summarize these screenshots\n[image/png]\n[image/jpeg]");
  });
});
