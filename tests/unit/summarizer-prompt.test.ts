import { describe, expect, it } from "vitest";
import { droidSummarizerInstructions } from "../../src/sessions/compaction.js";
import { buildDynamicUserContent, buildHostContext, buildPresetSystemPrompt, PRESET_REMOTE_WORKSPACE_NOTE, STABLE_DROID_APPEND } from "../../src/runtime/system-prompt.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { MessagesRequest } from "../../src/types.js";

// Shapes of Droid's summarizer request (Droid 1.1.0-1.6.0): one system text block,
// one user text message, no tools.
const ADAPTIVE = "You are Droid, an AI software engineering agent built by Factory.\n\nSummarize this conversation or agent trajectory so the assistant can continue effectively after compaction.\n\nFavor a thorough, complete summary.\n\nReturn the summary inside <summary> tags.";
const FIXED = "You are Droid, an AI software engineering agent built by Factory. You excel at creating and maintaining summaries.\n\nReturn your final summary with the following wrapped in <summary> tags.\n\n<summary>\n1. Chronological Play-by-Play\n</summary>";
const FIRST = "Please summarize the following conversation:\n```\nUSER: keep PORT 8123\n\n---\n\nASSISTANT: noted\n```\n\nRemember to wrap your final summary in <summary> tags.";
const UPDATE = "Previous summary:\n```\nPORT 8123\n```\n\nThese messages were sent since the previous summary:\n```\nUSER: also HOST alpha\n```\n\nPlease incorporate the new messages into the existing summary, preserving important details from both. Remember to wrap your final summary in <summary> tags.";

function summarizer(patch: Partial<MessagesRequest> = {}): MessagesRequest {
  return { model: "opus", max_tokens: 16000, system: [{ type: "text", text: ADAPTIVE }], messages: [{ role: "user", content: [{ type: "text", text: FIRST }] }], ...patch };
}
function runtimeInput(request: MessagesRequest, patch: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return { request, role: "chat", headers: {}, session: {} as RuntimeRequest["session"], ...patch };
}

describe("Droid summarizer detection", () => {
  it.each([
    ["adaptive first summary", ADAPTIVE, FIRST],
    ["adaptive update", ADAPTIVE, UPDATE],
    ["fixed first summary", FIXED, FIRST],
    ["fixed update", FIXED, UPDATE],
  ])("recognizes the %s", (_name, system, text) => {
    expect(droidSummarizerInstructions(summarizer({ system, messages: [{ role: "user", content: text }] }))).toBe(system);
  });

  it("accepts an explicitly empty tool list", () => {
    expect(droidSummarizerInstructions(summarizer({ tools: [] }))).toBe(ADAPTIVE);
  });

  it.each([
    ["a request that allows tools", summarizer({ tools: [{ name: "Read", input_schema: { type: "object" } }] })],
    ["a longer conversation", summarizer({ messages: [{ role: "user", content: FIRST }, { role: "assistant", content: "ok" }, { role: "user", content: FIRST }] })],
    ["a user who pastes the opening mid-message", summarizer({ messages: [{ role: "user", content: `Look: ${FIRST}` }] })],
    ["instructions without <summary>", summarizer({ system: "Return a concise title for this coding session." })],
    ["no system prompt", summarizer({ system: undefined })],
    ["a title helper", summarizer({ system: "Return a concise title for this coding session. Return only the title.", messages: [{ role: "user", content: "Fix the filter" }] })],
  ])("ignores %s", (_name, request) => {
    expect(droidSummarizerInstructions(request)).toBeUndefined();
  });
});

describe("summarizer instructions in the preset append", () => {
  it("leaves every other append byte-stable", () => {
    expect(buildPresetSystemPrompt().append).toBe(STABLE_DROID_APPEND);
    expect(buildPresetSystemPrompt(false, false, undefined).append).toBe(STABLE_DROID_APPEND);
  });

  it("puts the instructions after the stable append and the remote workspace note", () => {
    const prompt = buildPresetSystemPrompt(true, true, ADAPTIVE);
    expect(prompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(prompt.append.startsWith(STABLE_DROID_APPEND)).toBe(true);
    expect(prompt.append.endsWith(`${PRESET_REMOTE_WORKSPACE_NOTE}\n\n${ADAPTIVE}`)).toBe(true);
  });

  it("does not repeat the instructions as host context in the user message", () => {
    const input = runtimeInput(summarizer(), { summarizerInstructions: ADAPTIVE });
    const context = buildHostContext(input, "/work");
    expect(context).not.toContain("Host context (dynamic)");
    expect(context).not.toContain("Favor a thorough");
    expect(context).toContain("Allowed native tool equivalents for this host request: none.");
    expect(context).toContain("Working directory (Claude Code cwd): /work");
    const content = buildDynamicUserContent(input, "/work");
    expect(content[0]).toEqual({ type: "text", text: FIRST });
    expect(JSON.stringify(content)).not.toContain("Favor a thorough");
  });

  it("keeps the host context for the same request when it was not marked", () => {
    expect(buildHostContext(runtimeInput(summarizer()), "/work")).toContain(`Host context (dynamic):\n${ADAPTIVE}`);
  });
});
