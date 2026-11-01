import { BridgeError, type ContentBlock, type Json, type Message, type MessagesRequest, type ResponsesOptions, type ToolDefinition } from "../types.js";
import { isUserCancellation } from "../runtime/cancellation.js";
import { parseMessagesRequest } from "./validate.js";

/**
 * OpenAI Responses front end. Droid uses this API for its GPT models (a BYOK
 * entry with `provider: "openai"`): named reasoning effort, verbosity, freeform
 * ApplyPatch and Script, and native client-side tool search. The request is
 * translated into the Messages-shaped request every runtime takes, and the
 * Responses-only settings ride along in `responses`.
 */

/** Droid's ToolSearch, which a Responses request sends as a `tool_search` tool. */
export const TOOL_SEARCH_NAME = "ToolSearch";

/** Responses requests may omit max_output_tokens; the runtimes need a positive cap. */
const DEFAULT_MAX_TOKENS = 32_000;

/**
 * Droid keeps a call id that starts with `call_` (except `call_<digits>`) and
 * replaces any other with a synthetic one, which would orphan the result. Ids
 * that would not survive are sent with this prefix and stripped on the way back.
 */
const CALL_ID_PREFIX = "call_bx_";

export function wireCallId(id: string): string {
  return id.startsWith("call_") && !id.startsWith(CALL_ID_PREFIX) && !/^call_\d+$/.test(id) ? id : `${CALL_ID_PREFIX}${id}`;
}

export function internalCallId(callId: string): string {
  return callId.startsWith(CALL_ID_PREFIX) ? callId.slice(CALL_ID_PREFIX.length) : callId;
}

type Item = Record<string, unknown>;

function record(value: unknown): Item | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;
}

function invalid(message: string, status = 400, code = "invalid_request_error"): BridgeError {
  return new BridgeError(status, code, message);
}

function stringField(item: Item, key: string): string {
  const value = item[key];
  if (typeof value !== "string") throw invalid(`${String(item.type ?? "item")}.${key} must be a string`);
  return value;
}

/** Custom tools take raw text. Codex sees them as a function with one string argument. */
function freeformInputSchema(): Record<string, Json> {
  return {
    type: "object",
    properties: { input: { type: "string", description: "The raw tool input as plain text, not JSON." } },
    required: ["input"],
    additionalProperties: false,
  };
}

function customToolDescription(tool: Item): string {
  const description = typeof tool.description === "string" ? tool.description : "";
  const format = record(tool.format);
  if (format?.type !== "grammar" || typeof format.definition !== "string") return description;
  const syntax = typeof format.syntax === "string" ? format.syntax : "lark";
  return `${description}\n\nPut the raw text in \`input\`. It must match this ${syntax} grammar:\n${format.definition}`.trim();
}

interface ParsedTools {
  advertised: ToolDefinition[];
  deferred: ToolDefinition[];
  customTools: string[];
  toolSearch?: string;
}

function parseTools(value: unknown): ParsedTools {
  const parsed: ParsedTools = { advertised: [], deferred: [], customTools: [] };
  if (value === undefined || value === null) return parsed;
  if (!Array.isArray(value)) throw invalid("tools must be an array");
  for (const entry of value) {
    const tool = record(entry);
    if (!tool) throw invalid("each tool must be an object");
    if (tool.type === "function") {
      const definition: ToolDefinition = {
        name: stringField(tool, "name"),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        input_schema: (record(tool.parameters) ?? { type: "object", properties: {} }) as Record<string, Json>,
      };
      (tool.defer_loading === true ? parsed.deferred : parsed.advertised).push(definition);
    } else if (tool.type === "custom") {
      const name = stringField(tool, "name");
      parsed.customTools.push(name);
      parsed.advertised.push({ name, description: customToolDescription(tool), input_schema: freeformInputSchema() });
    } else if (tool.type === "tool_search") {
      if (tool.execution !== undefined && tool.execution !== "client") throw invalid("Only client-executed tool_search is supported", 422, "unsupported_tool");
      parsed.toolSearch = TOOL_SEARCH_NAME;
      parsed.advertised.push({
        name: TOOL_SEARCH_NAME,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        input_schema: (record(tool.parameters) ?? { type: "object", properties: {} }) as Record<string, Json>,
      });
    } else {
      throw invalid(`Tool type ${String(tool.type)} is not supported by this bridge`, 422, "unsupported_tool");
    }
  }
  return parsed;
}

function dataUrl(url: string): { media_type: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { media_type: match[1]!, data: match[2]! } : undefined;
}

/** One Responses content part as a Messages block. */
function contentPart(part: unknown): ContentBlock[] {
  if (typeof part === "string") return [{ type: "text", text: part }];
  const item = record(part);
  if (!item) throw invalid("content parts must be objects");
  switch (item.type) {
    case "input_text": case "output_text": case "text":
      return [{ type: "text", text: stringField(item, "text") }];
    case "refusal":
      return [{ type: "text", text: stringField(item, "refusal") }];
    case "input_image": {
      const url = typeof item.image_url === "string" ? item.image_url : undefined;
      if (!url) throw invalid("input_image needs image_url; file_id is not supported", 422, "unsupported_content");
      const data = dataUrl(url);
      return [data ? { type: "image", source: { type: "base64", ...data } } : { type: "image", source: { type: "url", url } }];
    }
    case "input_file": {
      const data = typeof item.file_data === "string" ? dataUrl(item.file_data) : undefined;
      if (!data) throw invalid("input_file needs base64 file_data; file_id and file_url are not supported", 422, "unsupported_content");
      return [{ type: "document", source: { type: "base64", ...data }, ...(typeof item.filename === "string" ? { title: item.filename } : {}) }];
    }
    default:
      throw invalid(`Content type ${String(item.type)} is not supported by this bridge`, 422, "unsupported_content");
  }
}

function messageContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw invalid("message content must be a string or an array");
  return content.flatMap(contentPart);
}

function parseArguments(value: unknown): Json {
  if (record(value)) return value as Json;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Json;
    return record(parsed) ? parsed : { value: parsed };
  } catch {
    // Kept verbatim so the model's malformed call reaches the tool's own validation.
    return { arguments: value };
  }
}

function toolResult(callId: string, content: ContentBlock[]): ContentBlock {
  const text = content.every((block) => block.type === "text") ? content.map((block) => block.type === "text" ? String(block.text ?? "") : "").join("") : undefined;
  return {
    type: "tool_result",
    tool_use_id: internalCallId(callId),
    content: text ?? content,
    // Responses carries no error flag. A user cancellation must still read as one,
    // so the runtime stops the native turn instead of carrying on.
    ...(text !== undefined && isUserCancellation(text, true) ? { is_error: true } : {}),
  };
}

/** Droid sends a tool result's media as a user message right after the outputs. */
const TOOL_MEDIA_HEADER = /^(Image content from .+|PDF document from .+):$/s;

interface Conversation {
  messages: Message[];
  loaded: Set<string>;
}

function parseInput(input: unknown): Conversation {
  const loaded = new Set<string>();
  if (typeof input === "string") return { messages: [{ role: "user", content: input }], loaded };
  if (!Array.isArray(input)) throw invalid("input must be a string or an array");
  const messages: Message[] = [];
  let role: Message["role"] | undefined;
  let blocks: ContentBlock[] = [];
  let lastWasOutput = false;
  const flush = (): void => {
    if (!role || !blocks.length) return;
    // Messages requires a user turn's tool results before its other content.
    const ordered = role === "user"
      ? [...blocks.filter((block) => block.type === "tool_result"), ...blocks.filter((block) => block.type !== "tool_result")]
      : blocks;
    messages.push({ role, content: ordered });
    blocks = [];
  };
  const add = (next: Message["role"], added: ContentBlock[]): void => {
    if (next !== role) { flush(); role = next; }
    blocks.push(...added);
  };
  for (const entry of input) {
    const item = record(entry);
    if (!item) throw invalid("input items must be objects");
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    const wasOutput = lastWasOutput;
    lastWasOutput = false;
    switch (type) {
      case "message": {
        const content = messageContent(item.content);
        if (item.role === "assistant") { add("assistant", content); break; }
        if (!["user", "system", "developer"].includes(String(item.role))) throw invalid(`Unknown message role ${String(item.role)}`);
        const header = content[0]?.type === "text" && typeof content[0].text === "string" ? content[0].text : "";
        const last = blocks.at(-1);
        if (wasOutput && role === "user" && last?.type === "tool_result" && TOOL_MEDIA_HEADER.test(header)) {
          // Give the media back to the result it came from, as Codex takes images in tool output.
          const previous = last.content;
          last.content = [...(typeof previous === "string" ? (previous ? [{ type: "text", text: previous }] : []) : (previous as ContentBlock[] | undefined) ?? []), ...content.slice(1)];
          lastWasOutput = true;
          break;
        }
        // Keep host message boundaries: Droid can send an error or tool result
        // before a separate environment-reminder message. Merging those user
        // messages hides the leading reminder from workspace resolution (and
        // would require trusting reminders embedded after arbitrary user text).
        flush();
        add("user", content);
        break;
      }
      case "reasoning":
        // The native thread keeps its own reasoning; replayed summaries are display only.
        break;
      case "function_call":
        add("assistant", [{ type: "tool_use", id: internalCallId(stringField(item, "call_id")), name: stringField(item, "name"), input: parseArguments(item.arguments) }]);
        break;
      case "custom_tool_call":
        add("assistant", [{ type: "tool_use", id: internalCallId(stringField(item, "call_id")), name: stringField(item, "name"), input: { input: typeof item.input === "string" ? item.input : "" } }]);
        break;
      case "tool_search_call":
        add("assistant", [{ type: "tool_use", id: internalCallId(stringField(item, "call_id")), name: TOOL_SEARCH_NAME, input: parseArguments(item.arguments) }]);
        break;
      case "function_call_output": case "custom_tool_call_output": {
        const output = item.output;
        const content = typeof output === "string" ? [{ type: "text", text: output } as ContentBlock] : messageContent(output ?? "");
        add("user", [toolResult(stringField(item, "call_id"), content)]);
        lastWasOutput = true;
        break;
      }
      case "tool_search_output": {
        const names = (Array.isArray(item.tools) ? item.tools : []).flatMap((tool) => typeof record(tool)?.name === "string" ? [String(record(tool)!.name)] : []);
        names.forEach((name) => loaded.add(name));
        add("user", [toolResult(stringField(item, "call_id"), [{ type: "text", text: names.length ? `Loaded tools: ${names.join(", ")}.` : "No tools were loaded." }])]);
        lastWasOutput = true;
        break;
      }
      case "additional_tools":
        for (const tool of Array.isArray(item.tools) ? item.tools : []) {
          const name = record(tool)?.name;
          if (typeof name === "string") loaded.add(name);
        }
        break;
      default:
        throw invalid(`Input item type ${String(type)} is not supported by this bridge`, 422, "unsupported_input");
    }
  }
  flush();
  return { messages, loaded };
}

function toolChoice(value: unknown): Json | undefined {
  if (value === undefined || value === null || value === "auto") return { type: "auto" };
  if (value === "none") return { type: "none" };
  throw invalid("tool_choice must be auto or none: the native agent cannot be forced to call a tool", 422, "unsupported_tool_choice");
}

/** A Responses request as the Messages-shaped request the runtimes take. */
export function parseResponsesRequest(body: unknown): MessagesRequest {
  const raw = record(body);
  if (!raw) throw invalid("request body must be a JSON object");
  // The bridge keeps conversations, not stored responses: every request must carry its history.
  for (const key of ["previous_response_id", "conversation"]) {
    if (raw[key] !== undefined && raw[key] !== null) throw invalid(`${key} is not supported; send the whole conversation in input with store: false`, 422, "unsupported_parameter");
  }
  if (raw.background === true) throw invalid("background responses are not supported", 422, "unsupported_parameter");
  if (raw.parallel_tool_calls === false) throw invalid("parallel_tool_calls: false is not supported by the native agent", 422, "unsupported_parameter");
  const text = record(raw.text);
  const format = record(text?.format);
  if (format && format.type !== "text") throw invalid("Structured output (text.format) is not supported by this bridge", 422, "unsupported_parameter");
  if (typeof raw.model !== "string" || !raw.model) throw invalid("model is required");
  const tools = parseTools(raw.tools);
  const { messages, loaded } = parseInput(raw.input);
  const deferred = tools.deferred.filter((tool) => !loaded.has(tool.name));
  const advertised = [...tools.advertised, ...tools.deferred.filter((tool) => loaded.has(tool.name))];
  const reasoning = record(raw.reasoning);
  if (raw.max_output_tokens !== undefined && (typeof raw.max_output_tokens !== "number" || !Number.isSafeInteger(raw.max_output_tokens) || raw.max_output_tokens <= 0)) {
    throw invalid("max_output_tokens must be a positive integer");
  }
  const maxTokens = raw.max_output_tokens === undefined ? DEFAULT_MAX_TOKENS : raw.max_output_tokens;
  const responses: ResponsesOptions = {
    customTools: tools.customTools,
    ...(tools.toolSearch ? { toolSearch: tools.toolSearch } : {}),
    deferredTools: deferred,
    ...(typeof text?.verbosity === "string" ? { verbosity: text.verbosity } : {}),
    ...(typeof reasoning?.summary === "string" ? { reasoningSummary: reasoning.summary } : {}),
  };
  const request = parseMessagesRequest({
    model: raw.model,
    messages,
    max_tokens: maxTokens,
    ...(typeof raw.instructions === "string" && raw.instructions ? { system: raw.instructions } : {}),
    ...(advertised.length ? { tools: advertised } : {}),
    tool_choice: toolChoice(raw.tool_choice),
    stream: raw.stream === true,
    ...(typeof raw.temperature === "number" ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === "number" ? { top_p: raw.top_p } : {}),
    ...(typeof reasoning?.effort === "string" ? { reasoning_effort: reasoning.effort } : {}),
  });
  return { ...request, responses };
}
