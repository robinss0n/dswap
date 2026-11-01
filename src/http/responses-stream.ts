import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { parseResponsesRequest, TOOL_SEARCH_NAME, wireCallId } from "../protocol/responses.js";
import { BridgeError, type ContentBlock, type Json, type MessagesRequest, type MessagesResponse, type Usage } from "../types.js";
import { writeSseHeaders } from "./sse.js";
import { PING_INTERVAL_MS } from "./sse-stream.js";

/** What app.ts needs from a live stream writer, whichever API it speaks. */
export interface TurnWriter {
  textDelta(text: string): void;
  toolTrace(name: string, detail: string): void;
  reasoningDelta?(text: string, item: string, part: number): void;
  completeContent(message: MessagesResponse): ContentBlock[];
  finish(message: MessagesResponse): ContentBlock[];
  fail(error: unknown): void;
  dispose(): void;
}

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

function itemId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function responseId(): string {
  return itemId("resp");
}

/** Responses usage counts cached input inside input_tokens; Messages usage keeps it apart. */
export function responsesUsage(usage: Usage): Record<string, Json> {
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: usage.output_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output_tokens,
  };
}

function freeformInput(input: Json): string {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, Json>).input : undefined;
  return typeof value === "string" ? value : JSON.stringify(input ?? {});
}

/** A runtime tool call as the Responses output item Droid expects for that tool. */
export function toolItem(block: ToolUse, request: MessagesRequest, status: "in_progress" | "completed"): Record<string, Json> {
  const callId = wireCallId(block.id);
  const options = request.responses;
  if (options?.toolSearch && block.name === TOOL_SEARCH_NAME) {
    return { type: "tool_search_call", id: itemId("tsc"), call_id: callId, execution: "client", arguments: block.input ?? {}, status };
  }
  if (options?.customTools.includes(block.name)) {
    return { type: "custom_tool_call", id: itemId("ctc"), call_id: callId, name: block.name, input: status === "completed" ? freeformInput(block.input) : "", status };
  }
  return { type: "function_call", id: itemId("fc"), call_id: callId, name: block.name, arguments: status === "completed" ? JSON.stringify(block.input ?? {}) : "", status };
}

function messageItem(id: string, text: string, status: "in_progress" | "completed"): Record<string, Json> {
  return { type: "message", id, status, role: "assistant", content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [] };
}

function responseObject(id: string, model: string, status: string, output: Json[], usage?: Usage, extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model, output,
    ...(usage ? { usage: responsesUsage(usage) } : {}),
    ...extra,
  };
}

/** A finished turn as a non-streaming Responses body. */
export function responsesJson(message: MessagesResponse, request: MessagesRequest): Record<string, Json> {
  const output: Json[] = message.content.flatMap((block): Json[] => {
    if (block.type === "text" && typeof block.text === "string") return block.text ? [messageItem(itemId("msg"), block.text, "completed")] : [];
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") return [toolItem(block as ToolUse, request, "completed")];
    return [];
  });
  const incomplete = message.stop_reason === "max_tokens";
  return responseObject(responseId(), request.model, incomplete ? "incomplete" : "completed", output, message.usage,
    incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {});
}

/**
 * OpenAI error codes Droid acts on: rate_limit_exceeded is throttling,
 * server_is_overloaded and server_error are retried, anything else is final.
 */
function errorBody(error: unknown): { status: number; error: Record<string, Json> } {
  if (!(error instanceof BridgeError)) {
    return { status: 500, error: { message: error instanceof Error ? error.message : String(error), type: "server_error", code: "server_error", param: null } };
  }
  const code = error.status === 429 ? "rate_limit_exceeded"
    : error.status === 529 || error.status === 503 ? "server_is_overloaded"
      : error.status >= 500 ? "server_error"
        : error.code;
  const type = error.status === 429 ? "rate_limit_error" : error.status >= 500 ? "server_error" : "invalid_request_error";
  return { status: error.status, error: { message: error.message, type, code, param: null, bridge_code: error.code, ...error.extra } };
}

export function writeResponsesError(res: ServerResponse, error: unknown): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const { status, error: body } = errorBody(error);
  if (error instanceof BridgeError && typeof error.extra?.retry_after === "number") res.setHeader("retry-after", String(error.extra.retry_after));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: body }));
}

interface OpenText { id: string; index: number; text: string }
interface OpenReasoning { id: string; index: number; key: string; part: number; parts: string[] }

/**
 * Live OpenAI Responses SSE writer. Droid builds its message from the deltas,
 * so text and reasoning stream as they arrive; tool calls follow when the
 * runtime hands the turn back, as on the Messages path.
 */
export class ResponsesWriter implements TurnWriter {
  private readonly id = responseId();
  private started = false;
  private finished = false;
  private contentComplete = false;
  private streamedText = false;
  private sequence = 0;
  private nextIndex = 0;
  private text?: OpenText;
  private reasoning?: OpenReasoning;
  private readonly output: Json[] = [];
  private readonly wireContent: ContentBlock[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly res: ServerResponse, private readonly request: MessagesRequest, private readonly pingMs = PING_INTERVAL_MS) {}

  private send(type: string, data: Record<string, Json>): void {
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`);
  }

  private live(): boolean {
    return !this.finished && !this.contentComplete && !this.res.destroyed;
  }

  private start(): void {
    if (this.started || this.finished || this.res.destroyed) return;
    writeSseHeaders(this.res);
    this.started = true;
    const response = responseObject(this.id, this.request.model, "in_progress", []);
    this.send("response.created", { response });
    this.send("response.in_progress", { response });
    this.res.once("close", this.dispose);
    // SSE comments keep proxies from closing an idle stream; Responses clients ignore them.
    this.pingTimer = setInterval(() => {
      if (this.finished || this.res.destroyed || this.res.writableEnded) { this.dispose(); return; }
      this.res.write(": keepalive\n\n");
    }, this.pingMs);
    this.pingTimer.unref();
  }

  dispose = (): void => {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.res.off("close", this.dispose);
  };

  reasoningDelta(text: string, item: string, part: number): void {
    if (!text || !this.live()) return;
    this.start();
    this.closeText();
    if (this.reasoning && this.reasoning.key !== item) this.closeReasoning();
    if (!this.reasoning) {
      this.reasoning = { id: itemId("rs"), index: this.nextIndex++, key: item, part, parts: [""] };
      this.send("response.output_item.added", { output_index: this.reasoning.index, item: { type: "reasoning", id: this.reasoning.id, summary: [] } });
      this.openPart();
    } else if (part !== this.reasoning.part) {
      this.closePart();
      this.reasoning.part = part;
      this.reasoning.parts.push("");
      this.openPart();
    }
    const open = this.reasoning;
    open.parts[open.parts.length - 1] += text;
    this.send("response.reasoning_summary_text.delta", { item_id: open.id, output_index: open.index, summary_index: open.parts.length - 1, delta: text });
  }

  private openPart(): void {
    const open = this.reasoning!;
    this.send("response.reasoning_summary_part.added", { item_id: open.id, output_index: open.index, summary_index: open.parts.length - 1, part: { type: "summary_text", text: "" } });
  }

  private closePart(): void {
    const open = this.reasoning!;
    const summaryIndex = open.parts.length - 1;
    const text = open.parts[summaryIndex]!;
    this.send("response.reasoning_summary_text.done", { item_id: open.id, output_index: open.index, summary_index: summaryIndex, text });
    this.send("response.reasoning_summary_part.done", { item_id: open.id, output_index: open.index, summary_index: summaryIndex, part: { type: "summary_text", text } });
  }

  private closeReasoning(): void {
    const open = this.reasoning;
    if (!open || this.finished || this.res.destroyed) return;
    this.closePart();
    // No encrypted_content: the native thread keeps its own reasoning, so Droid has nothing to replay.
    const item = { type: "reasoning", id: open.id, summary: open.parts.map((text) => ({ type: "summary_text", text })) };
    this.send("response.output_item.done", { output_index: open.index, item });
    this.output.push(item);
    this.reasoning = undefined;
  }

  textDelta(text: string): void {
    this.writeText(text, true);
  }

  toolTrace(name: string, detail: string): void {
    this.writeText(`\n[${name}] ${detail}\n`, false);
  }

  private writeText(text: string, modelText: boolean): void {
    if (!text || !this.live()) return;
    this.start();
    this.closeReasoning();
    if (!this.text) {
      this.text = { id: itemId("msg"), index: this.nextIndex++, text: "" };
      // Droid drops unencrypted reasoning and joins text until a tool boundary.
      if (this.wireContent.at(-1)?.type !== "text") this.wireContent.push({ type: "text", text: "" });
      this.send("response.output_item.added", { output_index: this.text.index, item: messageItem(this.text.id, "", "in_progress") });
      this.send("response.content_part.added", { item_id: this.text.id, output_index: this.text.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    this.text.text += text;
    (this.wireContent.at(-1) as { type: "text"; text: string }).text += text;
    this.send("response.output_text.delta", { item_id: this.text.id, output_index: this.text.index, content_index: 0, delta: text, logprobs: [] });
    if (modelText) this.streamedText = true;
  }

  private closeText(): void {
    const open = this.text;
    if (!open || this.finished || this.res.destroyed) return;
    this.send("response.output_text.done", { item_id: open.id, output_index: open.index, content_index: 0, text: open.text, logprobs: [] });
    this.send("response.content_part.done", { item_id: open.id, output_index: open.index, content_index: 0, part: { type: "output_text", text: open.text, annotations: [] } });
    const item = messageItem(open.id, open.text, "completed");
    this.send("response.output_item.done", { output_index: open.index, item });
    this.output.push(item);
    this.text = undefined;
  }

  private toolUse(block: ToolUse): void {
    if (!this.live()) return;
    this.start();
    this.closeReasoning();
    this.closeText();
    const index = this.nextIndex++;
    const added = toolItem(block, this.request, "in_progress");
    const done: Record<string, Json> = { ...toolItem(block, this.request, "completed"), id: added.id! };
    this.send("response.output_item.added", { output_index: index, item: added });
    if (done.type === "function_call") {
      this.send("response.function_call_arguments.delta", { item_id: done.id, output_index: index, delta: done.arguments! });
      this.send("response.function_call_arguments.done", { item_id: done.id, output_index: index, arguments: done.arguments! });
    } else if (done.type === "custom_tool_call") {
      this.send("response.custom_tool_call_input.delta", { item_id: done.id, output_index: index, delta: done.input! });
      this.send("response.custom_tool_call_input.done", { item_id: done.id, output_index: index, input: done.input! });
    }
    this.send("response.output_item.done", { output_index: index, item: done });
    this.output.push(done);
    // Custom tools replay only their raw input, not extra fields on the native call.
    const replay = parseResponsesRequest({ model: this.request.model, input: [done] });
    this.wireContent.push(...structuredClone(replay.messages[0]!.content as ContentBlock[]));
  }

  /**
   * Flush the turn and return the Messages-shaped content Droid will send back
   * once it replays these items, which is what session matching compares.
   */
  completeContent(message: MessagesResponse): ContentBlock[] {
    if (!this.live()) return structuredClone(this.wireContent);
    this.start();
    const hadModelText = this.streamedText;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        if (hadModelText) continue;
        this.closeText();
        this.closeReasoning();
        this.writeText(block.text, true);
        this.closeText();
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.toolUse({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    this.closeReasoning();
    this.closeText();
    this.contentComplete = true;
    return structuredClone(this.wireContent);
  }

  finish(message: MessagesResponse): ContentBlock[] {
    const content = this.completeContent(message);
    if (this.finished || this.res.destroyed) return content;
    const incomplete = message.stop_reason === "max_tokens";
    const status = incomplete ? "incomplete" : "completed";
    this.send(`response.${status}`, {
      response: responseObject(this.id, this.request.model, status, this.output, message.usage,
        incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    });
    this.res.end();
    this.finished = true;
    this.dispose();
    return content;
  }

  fail(error: unknown): void {
    if (this.finished || this.res.destroyed) return;
    if (!this.started) {
      writeResponsesError(this.res, error);
      this.finished = true;
      this.dispose();
      return;
    }
    const { error: body } = errorBody(error);
    this.send("response.failed", { response: responseObject(this.id, this.request.model, "failed", this.output, undefined, { error: { code: body.code!, message: body.message! } }) });
    this.finished = true;
    this.res.end();
    this.dispose();
  }
}
