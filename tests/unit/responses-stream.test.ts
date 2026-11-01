import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { ResponsesWriter, responsesJson, responsesUsage, writeResponsesError } from "../../src/http/responses-stream.js";
import { parseResponsesRequest } from "../../src/protocol/responses.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { historyMessageHashes } from "../../src/sessions/correlate.js";
import { BridgeError, type ContentBlock } from "../../src/types.js";

function collect() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const res = stream as unknown as ServerResponse;
  res.writeHead = ((status: number, headers: unknown) => { stream.write(JSON.stringify({ status, headers }) + "\n"); return res; }) as ServerResponse["writeHead"];
  res.setHeader = (() => res) as ServerResponse["setHeader"];
  const text = () => Buffer.concat(chunks).toString();
  const events = () => text().split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  return { res, text, events };
}
const request = () => parseResponsesRequest({ model: "codex:test", input: "hello", tools: [
  { type: "custom", name: "ApplyPatch" }, { type: "tool_search", execution: "client" },
] });

describe("Responses writer", () => {
  it("uses JSON errors before streaming begins", () => {
    const c = collect(), writer = new ResponsesWriter(c.res, request());
    writer.fail(new Error("unexpected"));
    expect(c.text()).toContain('"status":500');
    expect(c.text()).toContain('"code":"server_error"');
    expect(c.events()).toEqual([]);
  });
  it("sends comment keepalives and stops them after finish", () => {
    vi.useFakeTimers();
    try {
      const c = collect(), writer = new ResponsesWriter(c.res, request(), 10);
      writer.reasoningDelta("thinking", "r", 0);
      vi.advanceTimersByTime(20);
      expect(c.text().match(/: keepalive/g)).toHaveLength(2);
      writer.finish(assistantMessage("codex:test", [], "end_turn"));
      const finished = c.text();
      vi.advanceTimersByTime(100);
      expect(c.text()).toBe(finished);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("roundtrips exact streamed history, custom/native tools and reasoning through Droid replay", () => {
    const c = collect(), req = request(), writer = new ResponsesWriter(c.res, req);
    writer.toolTrace("Read", "file");
    writer.textDelta(" first ");
    writer.reasoningDelta("think", "r1", 0);
    writer.reasoningDelta(" more", "r1", 0);
    writer.reasoningDelta("second", "r1", 1);
    writer.reasoningDelta("third", "r2", 0);
    writer.textDelta("\nanswer\n");
    const tools: ContentBlock[] = [
      { type: "tool_use", id: "call_bx_collision", name: "Read", input: { path: "a" } },
      { type: "tool_use", id: "123", name: "ApplyPatch", input: { input: "*** patch", ignored: true } },
      { type: "tool_use", id: "call_123", name: "ToolSearch", input: { query: "select:Read" } },
    ];
    const msg = assistantMessage(req.model, [{ type: "text", text: "normalized" }, ...tools], "tool_use");
    const content = writer.completeContent(msg);
    writer.textDelta("late");
    expect(writer.finish(msg)).toEqual(content);
    writer.finish(msg);
    const events = c.events();
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.filter(e => e.type === "response.completed")).toHaveLength(1);
    const output = events.find(e => e.type === "response.completed").response.output;
    const replay = parseResponsesRequest({ model: req.model, input: output }).messages;
    expect(replay).toEqual([{ role: "assistant", content }]);
    expect(historyMessageHashes(replay)).toEqual(historyMessageHashes([{ role: "assistant", content }]));
    expect(output.filter((i: any) => i.type === "reasoning").map((i: any) => i.summary.map((s: any) => s.text))).toEqual([["think more", "second"], ["third"]]);
    expect(c.text()).not.toContain("late");
    expect(events.filter(e => e.type === "response.custom_tool_call_input.delta")[0].delta).toBe("*** patch");
    expect(events.filter(e => e.type === "response.function_call_arguments.delta")).toHaveLength(1);
  });
  it("keeps trace and fallback text blocks separate", () => {
    const c = collect(), writer = new ResponsesWriter(c.res, request());
    writer.toolTrace("Read", "file");
    const msg = assistantMessage("codex:test", [{ type: "text", text: "one" }, { type: "text", text: "two" }], "end_turn");
    expect(writer.finish(msg)).toEqual([{ type: "text", text: "\n[Read] file\n" }, ...msg.content]);
  });
  it("emits incomplete and counts cached usage", () => {
    const c = collect(), req = request(), writer = new ResponsesWriter(c.res, req);
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    const msg = assistantMessage(req.model, [{ type: "text", text: "cut" }], "max_tokens", usage);
    writer.finish(msg);
    const final = c.events().at(-1);
    expect(final.type).toBe("response.incomplete");
    expect(final.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(final.response.usage).toEqual(responsesUsage(usage));
    expect(final.response.usage).toMatchObject({ input_tokens: 8, total_tokens: 10 });
    expect(responsesJson(msg, req)).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  });
  it.each([[429, "rate_limit_exceeded"], [503, "server_is_overloaded"], [529, "server_is_overloaded"], [500, "server_error"], [400, "bad_input"]])("maps HTTP and streaming error %s", (status, code) => {
    const error = new BridgeError(status as number, "bad_input", "failed");
    const c = collect();
    writeResponsesError(c.res, error);
    expect(c.text()).toContain('"code":"' + code + '"');
    const s = collect(), writer = new ResponsesWriter(s.res, request());
    writer.textDelta("partial");
    writer.fail(error);
    writer.finish(assistantMessage("codex:test", [], "end_turn"));
    expect(s.events().at(-1)).toMatchObject({ type: "response.failed", response: { error: { code, message: "failed" } } });
    expect(s.text()).not.toContain("response.completed");
  });
});
