import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractTextContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  
  let text = "";
  let thinking = "";
  
  for (const c of content) {
    if (c.type === "text" && c.text) {
      text += c.text;
    }
    if (c.type === "thinking" && c.thinking) {
      thinking += c.thinking;
    }
  }
  
  return { text, thinking };
}

type PiParserState = {
  // Pending tool calls, for toolName on results that omit it.
  pendingToolCalls: Map<string, { toolName: string; args: unknown }>;
  // Tool results already rendered from tool_execution_end.
  renderedToolResults: Set<string>;
  // What the current assistant message has already put on screen. Pi streams
  // each block as *_delta events, then repeats it whole in *_end, again in
  // message_end, again in turn_end, and the last message once more in
  // agent_end. Only the first rendering may reach the transcript; the rest
  // are the same text. Scoped to one message (reset on message_start), so a
  // shared parser never suppresses a message it has not seen.
  renderedText: boolean;
  renderedThinking: boolean;
};

function createState(): PiParserState {
  return { pendingToolCalls: new Map(), renderedToolResults: new Set(), renderedText: false, renderedThinking: false };
}

function resetMessage(state: PiParserState): void {
  state.renderedText = false;
  state.renderedThinking = false;
}

const defaultState = createState();

function resetAll(state: PiParserState): void {
  state.pendingToolCalls.clear();
  state.renderedToolResults.clear();
  resetMessage(state);
}

export function resetParserState(): void {
  resetAll(defaultState);
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineWithState(defaultState, line, ts);
}

/** Per-transcript parser: isolated state, reset between builds. */
export function createPiStdoutParser(): { parseLine: (line: string, ts: string) => TranscriptEntry[]; reset: () => void } {
  const state = createState();
  return {
    parseLine: (line, ts) => parseLineWithState(state, line, ts),
    reset: () => resetAll(state),
  };
}

function parseLineWithState(state: PiParserState, line: string, ts: string): TranscriptEntry[] {
  const pendingToolCalls = state.pendingToolCalls;
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Non-JSON line, treat as raw stdout
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(parsed.type);

  // RPC protocol messages - filter these out (internal implementation detail)
  if (type === "response" || type === "extension_ui_request" || type === "extension_ui_response" || type === "extension_error") {
    return [];
  }

  // Agent lifecycle
  if (type === "agent_start") {
    resetAll(state);
    return [{ kind: "system", ts, text: "🚀 Pi agent started" }];
  }

  if (type === "agent_end") {
    const entries: TranscriptEntry[] = [];
    
    // Extract final message from messages array if available
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        // The last message's thinking and text were already rendered by
        // its message_update/message_end events; agent_end only repeats them.
        // Extract usage
        const usage = asRecord(lastMessage.usage);
        if (usage) {
          const inputTokens = (usage.inputTokens ?? usage.input ?? 0) as number;
          const outputTokens = (usage.outputTokens ?? usage.output ?? 0) as number;
          const cachedTokens = (usage.cacheRead ?? usage.cachedInputTokens ?? 0) as number;
          const costRecord = asRecord(usage.cost);
          const costUsd = (costRecord?.total ?? usage.costUsd ?? 0) as number;
          
          if (inputTokens > 0 || outputTokens > 0) {
            entries.push({
              kind: "result",
              ts,
              text: "Run completed",
              inputTokens,
              outputTokens,
              cachedTokens,
              costUsd,
              subtype: "end",
              isError: false,
              errors: [],
            });
          }
        }
      }
    }
    
    if (entries.length === 0) {
      entries.push({ kind: "system", ts, text: "✅ Pi agent finished" });
    }
    
    return entries;
  }

  // Turn lifecycle
  if (type === "turn_start") {
    return []; // Skip noisy lifecycle events
  }

  if (type === "turn_end") {
    // turn_end repeats the turn's assistant message (already rendered by
    // message_update/message_end) and its tool results (already rendered by
    // tool_execution_end). Only a result that never had its own
    // tool_execution_end is new here.
    const toolResults = parsed.toolResults as Array<Record<string, unknown>> | undefined;
    
    const entries: TranscriptEntry[] = [];
    
    // Process tool results - match with pending tool calls
    if (toolResults) {
      for (const tr of toolResults) {
        const toolCallId = asString(tr.toolCallId, `tool-${Date.now()}`);
        if (state.renderedToolResults.has(toolCallId)) continue;
        state.renderedToolResults.add(toolCallId);
        const content = tr.content;
        const isError = tr.isError === true;
        
        // Extract text from Pi's content array format
        let contentStr: string;
        if (typeof content === "string") {
          contentStr = content;
        } else if (Array.isArray(content)) {
          const extracted = extractTextContent(content as Array<{ type: string; text?: string }>);
          contentStr = extracted.text || JSON.stringify(content);
        } else {
          contentStr = JSON.stringify(content);
        }
        
        // Get tool name from pending calls if available
        const pendingCall = pendingToolCalls.get(toolCallId);
        const toolName = asString(tr.toolName, pendingCall?.toolName || "tool");
        
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName,
          content: contentStr,
          isError,
        });
        
        // Clean up pending call
        pendingToolCalls.delete(toolCallId);
      }
    }
    
    return entries;
  }

  // Message streaming
  if (type === "message_start") {
    resetMessage(state);
    return [];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      
      // Handle thinking deltas
      if (msgType === "thinking_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          state.renderedThinking = true;
          return [{ kind: "thinking", ts, text: delta, delta: true }];
        }
      }
      
      // Handle text deltas
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          state.renderedText = true;
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
      }
      
      // thinking_end/text_end carry the whole block again. Render it only
      // when the block was not streamed (a provider that sends no deltas).
      if (msgType === "thinking_end") {
        const content = asString(assistantEvent.content);
        if (content && !state.renderedThinking) {
          state.renderedThinking = true;
          return [{ kind: "thinking", ts, text: content }];
        }
      }
      
      if (msgType === "text_end") {
        const content = asString(assistantEvent.content);
        if (content && !state.renderedText) {
          state.renderedText = true;
          return [{ kind: "assistant", ts, text: content }];
        }
      }
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    // Only assistant messages are the agent speaking. A user message_end is
    // the prompt (the chat already shows it); a toolResult message_end
    // repeats tool_execution_end. Neither is assistant output.
    if (message && message.role === "assistant") {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      
      const entries: TranscriptEntry[] = [];
      
      // The complete message, rendered only for blocks nothing streamed.
      if (thinking && !state.renderedThinking) {
        entries.push({ kind: "thinking", ts, text: thinking });
      }
      if (text && !state.renderedText) {
        entries.push({ kind: "assistant", ts, text });
      }
      resetMessage(state);
      
      return entries;
    }
    return [];
  }

  // Tool execution
  if (type === "tool_execution_start") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const args = parsed.args;
    
    // Track this tool call for later matching
    pendingToolCalls.set(toolCallId, { toolName, args });
    
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: args,
      toolUseId: toolCallId,
    }];
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const result = parsed.result;
    const isError = parsed.isError === true;
    
    // Extract text from Pi's content array format
    let contentStr: string;
    if (typeof result === "string") {
      contentStr = result;
    } else if (Array.isArray(result)) {
      const extracted = extractTextContent(result as Array<{ type: string; text?: string }>);
      contentStr = extracted.text || JSON.stringify(result);
    } else if (result && typeof result === "object") {
      const resultObj = result as Record<string, unknown>;
      if (Array.isArray(resultObj.content)) {
        const extracted = extractTextContent(resultObj.content as Array<{ type: string; text?: string }>);
        contentStr = extracted.text || JSON.stringify(result);
      } else {
        contentStr = JSON.stringify(result);
      }
    } else {
      contentStr = String(result);
    }
    
    // Clean up pending call
    pendingToolCalls.delete(toolCallId);
    state.renderedToolResults.add(toolCallId);
    
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolCallId,
      toolName,
      content: contentStr,
      isError,
    }];
  }

  // Fallback for unknown event types
  return [{ kind: "stdout", ts, text: line }];
}
