import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompactionLimits } from "../../src/sessions/compaction-limits.js";
import { MESSAGE_BOUNDARY } from "../../src/sessions/presummary-transcript.js";
import type { ContentBlock, MessagesRequest } from "../../src/types.js";

const DEFAULTS = { chat: 1000, orchestrator: 2000 };
const turn = (first: string, system?: string): MessagesRequest => ({ model: "opus", max_tokens: 64, ...(system ? { system } : {}), messages: [{ role: "user", content: first }] });
const read = (path: string): ContentBlock[] => [{ type: "text", text: "reading" }, { type: "tool_use", id: "t1", name: "Read", input: { path } }];
const summary = (transcript: string): MessagesRequest => ({ model: "opus", max_tokens: 64, system: "Wrap it in <summary> tags.",
  messages: [{ role: "user", content: `Please summarize the following conversation:\n\`\`\`\n${transcript}\n\`\`\`\n` }] });
const answered = (first: string, path: string) => summary(`USER: ${first}${MESSAGE_BOUNDARY}ASSISTANT: reading\nTOOL_CALL: Read input={"path":"${path}"}${MESSAGE_BOUNDARY}USER: TOOL_RESULT: contents`);

describe("learned compaction limits", () => {
  it("starts from the defaults and gives a Missions orchestrator its own", () => {
    const limits = new CompactionLimits(DEFAULTS, { info: vi.fn() });
    expect(limits.observeTurn("a", turn("hi"), 10, [])).toEqual({ limit: 1000, role: "chat" });
    expect(limits.observeTurn("b", turn("hi", "You are Droid.\n\n# Workstream orchestrator\n\nMission"), 10, [])).toEqual({ limit: 2000, role: "orchestrator" });
  });

  it("raises the limit when a conversation goes on past it, and keeps it across restarts", () => {
    const file = join(mkdtempSync(join(tmpdir(), "limits-")), "compaction-limits.json");
    const info = vi.fn();
    const limits = new CompactionLimits(DEFAULTS, { info }, file);
    limits.observeTurn("a", turn("hi"), 1500, []);
    expect(limits.limit("opus", "chat")).toBe(1000);
    limits.observeRequest("a");
    expect(limits.limit("opus", "chat")).toBe(1500);
    expect(limits.limit("opus", "orchestrator")).toBe(2000);
    expect(limits.limit("sonnet", "chat")).toBe(1000);
    expect(info).toHaveBeenCalledWith("compaction_limit_learned", { model: "opus", role: "chat", from: 1000, to: 1500, source: "raised", tokens: 1500 });
    expect(JSON.parse(readFileSync(file, "utf8")).limits["opus\0chat"].limit).toBe(1500);
    expect(new CompactionLimits(DEFAULTS, { info }, file).limit("opus", "chat")).toBe(1500);
  });

  it("links a threshold compaction by the last tool call and keeps a limit it confirms", () => {
    const limits = new CompactionLimits(DEFAULTS, { info: vi.fn() });
    limits.observeTurn("a", turn("hi"), 900, read("/x"));
    limits.observeTurn("a", turn("hi"), 1100, read("/y"));
    expect(limits.observeCompaction(answered("other start", "/y"))).toEqual({ linked: true, model: "opus", role: "chat", tokens: 1100, limit: 1000 });
    expect(limits.limit("opus", "chat")).toBe(1000);
    expect(limits.observeCompaction(answered("other start", "/y"))).toEqual({ linked: false, candidates: 0 });
  });

  it("links by the first message when the last turn called no tool", () => {
    const limits = new CompactionLimits(DEFAULTS, { info: vi.fn() });
    limits.observeTurn("a", turn("plan the build"), 1100, [{ type: "text", text: "done" }]);
    limits.observeTurn("b", turn("plan the build later"), 1100, [{ type: "text", text: "done" }]);
    expect(limits.observeCompaction(summary(`USER: plan the build${MESSAGE_BOUNDARY}ASSISTANT: done`))).toMatchObject({ linked: true, tokens: 1100 });
  });

  it("learns nothing from an ambiguous or foreign compaction", () => {
    const limits = new CompactionLimits(DEFAULTS, { info: vi.fn() });
    limits.observeTurn("a", turn("one"), 500, read("/same"));
    limits.observeTurn("b", turn("two"), 500, read("/same"));
    expect(limits.observeCompaction(answered("three", "/same"))).toEqual({ linked: false, candidates: 2 });
    expect(limits.observeCompaction({ ...answered("one", "/same"), model: "sonnet" })).toEqual({ linked: false, candidates: 0 });
  });

  it("lowers only after two compactions below the limit agree", () => {
    const info = vi.fn();
    const limits = new CompactionLimits(DEFAULTS, { info });
    const compactAt = (key: string, previous: number, tokens: number) => {
      limits.observeTurn(key, turn(key), previous, read(`/${key}0`));
      limits.observeTurn(key, turn(key), tokens, read(`/${key}`));
      return limits.observeCompaction(answered(key, `/${key}`));
    };
    expect(compactAt("manual", 300, 400)).toMatchObject({ pending: true });
    expect(compactAt("threshold", 900, 1050)).not.toHaveProperty("pending");
    expect(compactAt("first", 560, 610)).toMatchObject({ pending: true });
    expect(limits.limit("opus", "chat")).toBe(1000);
    expect(compactAt("second", 580, 640)).toMatchObject({ lowered: 580 });
    expect(limits.limit("opus", "chat")).toBe(580);
    expect(info).toHaveBeenCalledWith("compaction_limit_learned", expect.objectContaining({ from: 1000, to: 580, source: "lowered" }));
  });
});
