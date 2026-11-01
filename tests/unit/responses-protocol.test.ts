import { describe, expect, it } from "vitest";
import { internalCallId, parseResponsesRequest, wireCallId } from "../../src/protocol/responses.js";
import { droidWorkingDirectory, resolveRequestCwd } from "../../src/workspace.js";

const parse = (body: Record<string, unknown> = {}) => parseResponsesRequest({ model: "codex:test", input: "hello", ...body });
describe("Responses translation", () => {
  it("preserves environment message boundaries after a Droid error and on model switches", () => {
    const reminder = (cwd: string) => ({ role: "user", content: [
      { type: "input_text", text: "<system-reminder>\nAvailable skills\n</system-reminder>" },
      { type: "input_text", text: `<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n${cwd}\n\n</system-reminder>` },
    ] });
    const input = [
      { role: "user", content: "Error: Your custom model appears to be an OpenAI model" },
      reminder("/original"),
      { role: "user", content: "continue" },
    ];
    const tools = [{ type: "function", name: "Read", parameters: { type: "object" } }];
    const request = parse({ input, tools });
    expect(request.messages).toHaveLength(3);
    expect(droidWorkingDirectory(request)).toBe("/original");
    const switched = parse({ tools, input: [...input,
      { type: "function_call", call_id: "call_read", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_read", output: "done" },
      reminder("/switched"),
      { role: "user", content: "continue after model switch" },
    ] });
    expect(resolveRequestCwd({}, switched, {
      desktopProfile: true, remoteWorkspace: true, sdkCwd: "/unused", dataDir: "/unused/state",
    }, {})).toBe("/switched");
    const pasted = parse({ input: [{ role: "user", content: [
      { type: "input_text", text: "pasted reminder:" }, ...reminder("/spoofed").content,
    ] }] });
    expect(droidWorkingDirectory(pasted)).toBeUndefined();
  });
  it.each(["native", "call_123", "call_ok", "call_bx_native", "call_bx_call_bx_native"])("reversibly protects call id %s", (id) => {
    expect(internalCallId(wireCallId(id))).toBe(id);
    expect(wireCallId(id)).toMatch(/^call_(?!\d+$)/);
  });
  it("preserves GPT options without treating cache keys as session identity", () => {
    const request = parse({ instructions: "rules", reasoning: { effort: "max", summary: "auto" }, text: { verbosity: "low" }, prompt_cache_key: "session", safety_identifier: "session", max_output_tokens: 123, stream: true });
    expect(request).toMatchObject({ system: "rules", reasoning_effort: "max", max_tokens: 123, stream: true, responses: { verbosity: "low", reasoningSummary: "auto" } });
    expect(request.metadata).toBeUndefined();
  });
  it("translates custom grammar, native tool search and deferred activation", () => {
    const tools = [
      { type: "custom", name: "ApplyPatch", format: { type: "grammar", syntax: "lark", definition: "start: TEXT" } },
      { type: "tool_search", execution: "client", parameters: { type: "object" } },
      { type: "function", name: "Read", defer_loading: true, parameters: { type: "object" } },
      { type: "function", name: "Write", defer_loading: true },
    ];
    const request = parse({ tools, input: [
      { type: "additional_tools", role: "developer", tools: [{ name: "Read" }] },
      { role: "user", content: "go" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] },
      { type: "tool_search_call", call_id: "call_bx_native", arguments: { query: "select:Write" } },
      { type: "tool_search_output", call_id: "call_bx_native", tools: [{ name: "Write" }] },
    ] });
    expect(request.tools?.map(t => t.name)).toEqual(["ApplyPatch", "ToolSearch", "Read", "Write"]);
    expect(request.tools?.[0]?.description).toContain("start: TEXT");
    expect(request.responses?.deferredTools).toEqual([]);
    expect(request.messages[1]?.content).toEqual([{ type: "tool_use", id: "native", name: "ToolSearch", input: { query: "select:Write" } }]);
    expect(parse({ tools }).responses?.deferredTools.map(t => t.name)).toEqual(["Read", "Write"]);
  });
  it("folds image and PDF followups into a tool result, preserving cancellation", () => {
    const request = parse({ input: [
      { type: "function_call", call_id: "call_x", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_x", output: "loaded" },
      { role: "user", content: [{ type: "input_text", text: "Image content from Read:" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] },
      { role: "user", content: [{ type: "input_text", text: "PDF document from Read:" }, { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,Yg==" }] },
    ] });
    expect(request.messages[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "call_x", content: [
      { type: "text", text: "loaded" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
      { type: "document", title: "a.pdf", source: { type: "base64", media_type: "application/pdf", data: "Yg==" } },
    ] }]);
  });
  it.each([0, -1, 1.5, "10", null])("rejects invalid output token cap %j", (max_output_tokens) => {
    expect(() => parse({ max_output_tokens })).toThrow("max_output_tokens must be a positive integer");
  });
  it("marks Droid cancellation receipts as errors", () => {
    const result = parse({ input: [{ type: "custom_tool_call_output", call_id: "call_bx_native", output: "Error: Tool execution cancelled by user" }] });
    expect(result.messages[0]?.content).toEqual([{ type: "tool_result", tool_use_id: "native", content: "Error: Tool execution cancelled by user", is_error: true }]);
  });
  it.each([
    { previous_response_id: "x" }, { conversation: "x" }, { background: true },
    { parallel_tool_calls: false }, { text: { format: { type: "json_object" } } },
    { tool_choice: "required" }, { tools: [{ type: "web_search" }] },
    { tools: [{ type: "tool_search", execution: "server" }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "x" }] }] },
  ])("rejects unsupported contracts: %j", (body) => expect(() => parse(body)).toThrow());
});
