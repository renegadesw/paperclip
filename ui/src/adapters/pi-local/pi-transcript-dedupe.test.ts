import { describe, expect, it } from "vitest";
import { buildTranscript, type RunLogChunk } from "../transcript";
import { piLocalUIAdapter } from "./index";

// The exact Pi RPC event sequence of a board-chat turn with one tool call
// (live run 20ad09ed, 2026-09-28): every assistant block streams as deltas and
// is then repeated whole in *_end, message_end, turn_end, and agent_end.
function piRpcTurn(): RunLogChunk[] {
  const ts = "2026-09-28T23:12:00.000Z";
  const thinking1 = "The user is casual. A quick memory check helps.";
  const thinking2 = "Memory search failed. Keep it short.";
  const answer = "Not much, ready to go. Got a ticket?";
  const toolCall = { type: "toolCall", id: "call_1", name: "memory_search", arguments: { query: "priorities" } };
  const firstAssistant = {
    role: "assistant",
    content: [{ type: "thinking", thinking: thinking1 }, toolCall],
    responseId: "msg_1",
    timestamp: 1,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "memory_search",
    content: [{ type: "text", text: "Vector tool memory_search failed with status 401" }],
    isError: true,
    timestamp: 2,
  };
  const finalAssistant = {
    role: "assistant",
    content: [{ type: "thinking", thinking: thinking2 }, { type: "text", text: answer }],
    responseId: "msg_2",
    timestamp: 3,
    usage: { input: 10, output: 90, cacheRead: 0, cost: { total: 0 } },
  };
  const user = { role: "user", content: [{ type: "text", text: "waddup" }], timestamp: 0 };
  const update = (event: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: event });
  const deltas = (kind: "thinking" | "text", text: string) =>
    text.match(/.{1,12}/g)!.map((delta) => update({ type: `${kind}_delta`, contentIndex: 0, delta }));
  const lines = [
    { id: "paperclip-run", type: "response", command: "prompt", success: true },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: user },
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    ...deltas("thinking", thinking1),
    update({ type: "thinking_end", contentIndex: 0, content: thinking1 }),
    update({ type: "toolcall_start", contentIndex: 1 }),
    update({ type: "toolcall_end", contentIndex: 1 }),
    { type: "message_end", message: firstAssistant },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "memory_search", args: { query: "priorities" } },
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "memory_search", result: { content: toolResult.content }, isError: true },
    { type: "message_start", message: toolResult },
    { type: "message_end", message: toolResult },
    { type: "turn_end", message: firstAssistant, toolResults: [toolResult] },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    ...deltas("thinking", thinking2),
    update({ type: "thinking_end", contentIndex: 0, content: thinking2 }),
    update({ type: "text_start", contentIndex: 1 }),
    ...deltas("text", answer),
    update({ type: "text_end", contentIndex: 1, content: answer }),
    { type: "message_end", message: finalAssistant },
    { type: "turn_end", message: finalAssistant, toolResults: [] },
    { type: "agent_end", messages: [user, firstAssistant, toolResult, finalAssistant] },
    { type: "response", command: "get_state", success: true },
  ];
  return lines.map((line, index) => ({
    ts,
    stream: "stdout" as const,
    chunk: `${JSON.stringify(line)}\n`,
    seq: index + 1,
  }));
}

describe("Pi transcript", () => {
  it("renders each thought, tool result, and the final answer exactly once", () => {
    const entries = buildTranscript(piRpcTurn(), piLocalUIAdapter);

    expect(entries.filter((entry) => entry.kind === "thinking").map((entry) => entry.text)).toEqual([
      "The user is casual. A quick memory check helps.",
      "Memory search failed. Keep it short.",
    ]);
    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text)).toEqual([
      "Not much, ready to go. Got a ticket?",
    ]);
    expect(entries.filter((entry) => entry.kind === "tool_call")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "tool_result")).toHaveLength(1);
    // Usage still comes from agent_end.
    expect(entries.filter((entry) => entry.kind === "result")).toMatchObject([
      { inputTokens: 10, outputTokens: 90 },
    ]);
  });

  it("is stable across repeated live rebuilds of the same log", () => {
    const chunks = piRpcTurn();
    const first = buildTranscript(chunks, piLocalUIAdapter);
    const second = buildTranscript(chunks, piLocalUIAdapter);
    expect(second).toEqual(first);
    // The shared stateless entry point gives the same result on a rebuild.
    const viaLineParser = buildTranscript(chunks, piLocalUIAdapter.parseStdoutLine);
    expect(buildTranscript(chunks, piLocalUIAdapter.parseStdoutLine)).toEqual(viaLineParser);
    expect(viaLineParser.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });

  it("still renders a message whose provider sent no deltas", () => {
    const ts = "2026-09-28T23:12:00.000Z";
    const message = { role: "assistant", content: [{ type: "text", text: "Whole reply." }] };
    const chunks: RunLogChunk[] = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message },
      { type: "turn_end", message, toolResults: [] },
      { type: "agent_end", messages: [message] },
    ].map((line) => ({ ts, stream: "stdout" as const, chunk: `${JSON.stringify(line)}\n` }));

    const entries = buildTranscript(chunks, piLocalUIAdapter);
    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text)).toEqual(["Whole reply."]);
  });
});
