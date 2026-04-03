import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTurnInput,
  extractErrorText,
  formatToolSpanName,
  normalizeAssistantMessage,
  normalizeContextMessages,
  normalizeToolResult,
  repoSlugForCwd,
  rootSpanName,
} from "./utils.ts";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

  it("prefers owner/repo from git origin for the root span name", () => {
    const repoDir = makeTempDir("trace-pi-git-");
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:braintrustdata/braintrust-pi-extension.git"],
      { cwd: repoDir, stdio: "ignore" },
    );

    expect(repoSlugForCwd(repoDir)).toBe("braintrustdata/braintrust-pi-extension");
    expect(rootSpanName(repoDir)).toBe("pi: braintrustdata/braintrust-pi-extension");
  });

  it("falls back to the cwd basename when no git origin is available", () => {
    const dir = makeTempDir("trace-pi-no-git-");

    expect(repoSlugForCwd(dir)).toBeUndefined();
    expect(rootSpanName(dir)).toBe(`pi: ${dir.split("/").at(-1)}`);
  });
});
