import { describe, expect, it } from "vitest";
import { extractPiRuntimeEvents, parsePiJsonl, isPiUnknownSessionError } from "./parse.js";

describe("extractPiRuntimeEvents", () => {
  it("normalizes text, tool lifecycle, usage, final, and settled events", () => {
    const toolCallId = "call-preserve-this-exact-id";
    const lines = [
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Working" },
      },
      {
        type: "tool_execution_start",
        toolCallId,
        toolName: "read",
        args: { path: "README.md" },
      },
      {
        type: "tool_execution_update",
        toolCallId,
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { content: "partial" },
      },
      {
        type: "tool_execution_end",
        toolCallId,
        toolName: "read",
        result: { content: "complete" },
        isError: false,
      },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Finished" }],
          stopReason: "stop",
          usage: { input: 12, output: 4, cacheRead: 2, cost: { total: 0.003 } },
        },
      },
      { type: "agent_settled" },
    ];

    const events = lines.flatMap((line) => extractPiRuntimeEvents(JSON.stringify(line)));

    expect(events.map((event) => event.eventType)).toEqual([
      "assistant_delta",
      "tool_call",
      "tool_update",
      "tool_result",
      "assistant_final",
      "usage",
      "agent_settled",
    ]);
    expect(events.filter((event) => event.eventType.startsWith("tool")).map((event) => event.payload?.toolCallId))
      .toEqual([toolCallId, toolCallId, toolCallId]);
    expect(events.find((event) => event.eventType === "usage")?.payload).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 2,
      costUsd: 0.003,
    });
    expect(events.at(-1)).toMatchObject({
      eventType: "agent_settled",
      stream: "system",
      payload: { settled: true },
    });
  });

  it("normalizes direct, RPC, retry, and provider errors", () => {
    const events = [
      { type: "error", message: "socket closed" },
      { type: "response", id: "request-1", command: "prompt", success: false, error: "busy" },
      { type: "auto_retry_end", success: false, finalError: "quota exhausted" },
      {
        type: "turn_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
      },
    ].flatMap((line) => extractPiRuntimeEvents(JSON.stringify(line)));

    expect(events.map((event) => event.message)).toEqual([
      "socket closed",
      "prompt: busy",
      "quota exhausted",
      "provider failed",
    ]);
    expect(events.every((event) => event.eventType === "error" && event.level === "error")).toBe(true);
    expect(events[1]?.payload).toMatchObject({ source: "rpc", command: "prompt", requestId: "request-1" });
  });

  it("ignores malformed and non-actionable protocol lines", () => {
    expect(extractPiRuntimeEvents("not json")).toEqual([]);
    expect(extractPiRuntimeEvents(JSON.stringify({ type: "response", command: "prompt", success: true }))).toEqual([]);
    expect(extractPiRuntimeEvents(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }))).toEqual([]);
  });
});

describe("parsePiJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Pi" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello from Pi");
    expect(parsed.finalMessage).toBe("Hello from Pi");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello World",
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello World");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("handles standalone usage events with Pi format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cost: { total: 0.005 },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.costUsd).toBe(0.005);
  });

  it("handles standalone usage events with generic format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cachedInputTokens: 25,
          costUsd: 0.003,
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(75);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.costUsd).toBe(0.003);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to model provider lost",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to model provider lost"]);
  });

  it("ignores error events with empty messages", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces failed RPC command responses", () => {
    const parsed = parsePiJsonl(JSON.stringify({
      type: "response",
      command: "prompt",
      success: false,
      error: "agent is already streaming",
    }));

    expect(parsed.errors).toEqual(["prompt: agent is already streaming"]);
  });

  it("does not double-count usage repeated in message_end and turn_end", () => {
    const message = {
      role: "assistant",
      content: "Done",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cost: { total: 0.0042 },
      },
    };
    const parsed = parsePiJsonl([
      JSON.stringify({ type: "message_end", message }),
      JSON.stringify({ type: "turn_end", message, toolResults: [] }),
    ].join("\n"));

    expect(parsed.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      costUsd: 0.0042,
    });
  });
});

describe("isPiUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isPiUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isPiUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isPiUnknownSessionError("", "no session available")).toBe(true);
    expect(isPiUnknownSessionError("all good", "")).toBe(false);
    expect(isPiUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});


describe("terminal provider failures", () => {
  it("surfaces and deduplicates errors from Pi assistant messages", () => {
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Context limit exceeded" };
    const parsed = parsePiJsonl([
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_end", messages: [message] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["400 Context limit exceeded"]);
  });
  it("reports an error even when the provider omitted its message", () => {
    expect(parsePiJsonl(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } })).errors)
      .toEqual(["Pi provider request failed."]);
  });
});


describe("token-limited Pi completion", () => {
  it("does not report a thinking-only length stop as successful", () => {
    const line = JSON.stringify({ type: "message_end", message: {
      role: "assistant", stopReason: "length", content: [{ type: "thinking", thinking: "unfinished work" }],
    } });
    expect(parsePiJsonl(line).errors).toEqual(["Pi response was truncated by the model token limit before completion."]);
    expect(extractPiRuntimeEvents(line.replace("message_end", "turn_end"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "error", level: "error", message: expect.stringContaining("token limit") }),
    ]));
  });
  it("recognizes a length stop delivered only in the agent-end envelope", () => {
    const line = JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "length", content: [] }] });
    expect(parsePiJsonl(line).errors).toHaveLength(1);
  });
});
