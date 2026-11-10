import { describe, expect, it } from "vitest";
import { MESSAGE_BOUNDARY, rewriteFirstSummary, serializeTranscript, transcriptRemainder } from "../../src/sessions/presummary-transcript.js";
import type { MessagesRequest } from "../../src/types.js";

describe("pre-summary transcript primitives", () => {
  it("encodes text, calls, results, images and thinking with Droid labels", () => {
    expect(serializeTranscript([
      { role: "user", content: "keep PORT 8123" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: "check" },
        { type: "tool_use", id: "a", name: "Read", input: { path: "é" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "url", url: "https://example.invalid" } }] },
        { type: "redacted_thinking" },
        { type: "image", source: { type: "url", url: "https://example.invalid" } },
      ] },
    ])).toBe('USER: keep PORT 8123' + MESSAGE_BOUNDARY + 'ASSISTANT: [Thinking: check]\nTOOL_CALL: Read input={"path":"é"}' + MESSAGE_BOUNDARY + 'USER: TOOL_RESULT: ok\n[Image]\n[Redacted thinking]\n[Image attached]');
  });

  it("truncates thinking and honors model-rendered results", () => {
    expect(serializeTranscript([{ role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(501) }] }])).toBe(`ASSISTANT: [Thinking: ${"a".repeat(500)}...]`);
    expect(serializeTranscript([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", model_content: "rendered", content: "raw" }] }])).toBe("USER: TOOL_RESULT: rendered");
  });

  it("requires a complete message boundary, preserving significant whitespace", () => {
    expect(transcriptRemainder("USER: hi" + MESSAGE_BOUNDARY + "ASSISTANT: ok", "USER: hi")).toBe("ASSISTANT: ok");
    expect(transcriptRemainder("USER: higher", "USER: hi")).toBeUndefined();
    expect(transcriptRemainder("USER: hi ", "USER: hi")).toBeUndefined();
    expect(transcriptRemainder("USER: hi", "")).toBeUndefined();
    expect(transcriptRemainder("USER: hi\r\nthere", "USER: hi\nthere")).toBe("");
  });

  const request = (text: string): MessagesRequest => ({ model: "sonnet", max_tokens: 123, messages: [{ role: "user", content: text }] });
  const first = request("Please summarize the following conversation:\n```\nUSER: hi" + MESSAGE_BOUNDARY + "ASSISTANT: ok\n```\nWrap in <summary> tags.");
  it("rewrites only the matched prefix and preserves request settings and suffix", () => {
    const result = rewriteFirstSummary(first, "USER: hi", "<summary>checked</summary>");
    expect(result).toEqual({ ...first, messages: [{ role: "user", content: "Previous summary:\n```\n<summary>checked</summary>\n```\n\nThese messages were sent since the previous summary:\n```\nASSISTANT: ok\n```\nWrap in <summary> tags." }] });
    expect(first.messages[0]?.content).toMatch(/^Please summarize/);
  });
  it("falls back on mismatches, update forms, and ambiguous fences", () => {
    expect(rewriteFirstSummary(first, "USER: hi", "  \n")).toBeUndefined();
    expect(rewriteFirstSummary(first, "USER: bye", "checked")).toBeUndefined();
    expect(rewriteFirstSummary(request("Previous summary:\n```\nold\n```"), "USER: hi", "checked")).toBeUndefined();
    expect(rewriteFirstSummary(first, "USER: hi", "```")).toBeUndefined();
    expect(rewriteFirstSummary(request("Please summarize the following conversation:\n```\nUSER: hi\n```\nextra\n```"), "USER: hi", "checked")).toBeUndefined();
  });
  it.each(["USER: inline ``` fence", "USER: hi\n```not a closing fence"])("rejects ambiguous transcript %s", (transcript) => {
    const envelope = request(`Please summarize the following conversation:\n\`\`\`\n${transcript}\n\`\`\``);
    expect(rewriteFirstSummary(envelope, transcript, "checked")).toBeUndefined();
  });
  it("rejects a closing fence with trailing non-newline text", () => {
    const envelope = request("Please summarize the following conversation:\n```\nUSER: hi\n```suffix");
    expect(rewriteFirstSummary(envelope, "USER: hi", "checked")).toBeUndefined();
  });
});
