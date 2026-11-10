import { describe, expect, it, vi } from "vitest";
import { isMissionOrchestrator, Presummaries, promptTokens, summaryText } from "../../src/sessions/presummary.js";
import { MESSAGE_BOUNDARY, serializeTranscript } from "../../src/sessions/presummary-transcript.js";
import type { MessagesRequest } from "../../src/types.js";

const CONFIG = { at: 0.7, limit: 1000, orchestratorLimit: 2000, checkModel: "haiku", checkEffort: "high" as const };
const turn = (text: string): MessagesRequest => ({ model: "opus", max_tokens: 64, messages: [{ role: "user", content: text }, { role: "assistant", content: "ok" }] });
const compaction = (transcript: string): MessagesRequest => ({ model: "opus", max_tokens: 64, system: "x <summary>", messages: [{ role: "user", content: `Please summarize the following conversation:\n\`\`\`\n${transcript}\n\`\`\`\n\nTags.` }] });
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSend(reply: (body: MessagesRequest) => string | Promise<string>) {
  const calls: MessagesRequest[] = [];
  return { calls, send: async (body: MessagesRequest) => { calls.push(body); return reply(body); } };
}
const isCheck = (body: MessagesRequest) => JSON.stringify(body.messages).includes("Summary to check");

describe("background pre-summary", () => {
  it("counts every prompt token Droid compares with its limit and reads <summary> blocks", () => {
    expect(promptTokens({ input_tokens: 2, cache_read_input_tokens: 500, cache_creation_input_tokens: 300, output_tokens: 40 })).toBe(842);
    expect(summaryText("a <summary> body </summary> b")).toBe("body");
    expect(summaryText("no tags")).toBeUndefined();
  });

  it("starts below no threshold, then once per conversation and one at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { calls, send } = fakeSend(async (body) => { await gate; return isCheck(body) ? "<summary>CHECKED</summary>" : "<summary>DRAFT</summary>"; });
    const jobs = new Presummaries(CONFIG, send, logger());
    expect(jobs.consider("a", turn("hi"), 699)).toBe(false);
    expect(jobs.consider("a", turn("hi"), 700)).toBe(true);
    expect(jobs.consider("a", turn("hi"), 900)).toBe(false);
    expect(jobs.consider("b", turn("other"), 900)).toBe(false);
    expect(jobs.describe()).toEqual({ running: 1, ready: 0, failed: 0 });
    release();
    await flush(); await flush();
    expect(jobs.describe()).toEqual({ running: 0, ready: 1, failed: 0 });
    expect(calls.map((body) => body.model)).toEqual(["opus", "haiku"]);
    expect(calls[1]?.output_config).toEqual({ effort: "high" });
  });

  it("rewrites a matching compaction once, and leaves others alone with a reason", async () => {
    const { send } = fakeSend((body) => isCheck(body) ? "<summary>CHECKED</summary>" : "<summary>DRAFT</summary>");
    const jobs = new Presummaries(CONFIG, send, logger());
    const early = turn("keep PORT 8123");
    jobs.consider("a", early, 800);
    expect(jobs.take(compaction(serializeTranscript(early.messages))).reason).toBe("pre-summary still running");
    await flush(); await flush();
    const prefix = serializeTranscript(early.messages);
    expect(jobs.take(compaction("USER: something else"))).toMatchObject({ path: "plain", reason: "no ready pre-summary matches this transcript" });
    const taken = jobs.take(compaction(`${prefix}${MESSAGE_BOUNDARY}USER: later`));
    expect(taken.path).toBe("presummary");
    expect(taken.request.messages[0]?.content).toBe("Previous summary:\n```\nCHECKED\n```\n\nThese messages were sent since the previous summary:\n```\nUSER: later\n```\n\nTags.");
    expect(jobs.take(compaction(`${prefix}${MESSAGE_BOUNDARY}USER: later`))).toMatchObject({ path: "plain", reason: "no pre-summary" });
  });

  it("uses the orchestrator's own limit for a Missions orchestrator", () => {
    const orchestrator = (text: string): MessagesRequest => ({ ...turn(text), system: [{ type: "text", text: "You are Droid." }, { type: "text", text: "# Workstream orchestrator\n\nMission: build it" }] });
    expect(isMissionOrchestrator(orchestrator("x"))).toBe(true);
    expect(isMissionOrchestrator({ ...turn("x"), system: "Notes on the # Workstream orchestrator heading" })).toBe(false);
    const jobs = new Presummaries(CONFIG, fakeSend(() => new Promise<string>(() => {})).send, logger());
    expect(jobs.consider("o", orchestrator("x"), 1399)).toBe(false);
    expect(jobs.consider("o", orchestrator("x"), 1400)).toBe(true);
    const normal = new Presummaries(CONFIG, fakeSend(() => new Promise<string>(() => {})).send, logger());
    expect(normal.consider("n", turn("x"), 700)).toBe(true);
    jobs.close(); normal.close();
  });

  it("keeps the unchecked draft when only the check fails, and records a failed summary", async () => {
    const log = logger();
    const jobs = new Presummaries(CONFIG, fakeSend((body) => { if (isCheck(body)) throw new Error("check down"); return "<summary>DRAFT</summary>"; }).send, log);
    jobs.consider("a", turn("x"), 900);
    await flush(); await flush();
    expect(log.warn).toHaveBeenCalledWith("presummary_check_failed", { error: "check down" });
    expect(log.info).toHaveBeenCalledWith("presummary_ready", expect.objectContaining({ checked: false }));
    const failing = new Presummaries(CONFIG, fakeSend(() => "no tags").send, log);
    failing.consider("a", turn("x"), 900);
    await flush();
    expect(failing.describe()).toEqual({ running: 0, ready: 0, failed: 1 });
    expect(failing.consider("a", turn("x"), 900)).toBe(false);
  });

  it("aborts running jobs on close and on timeout", async () => {
    const seen: AbortSignal[] = [];
    const hang = (_body: MessagesRequest, signal: AbortSignal) => { seen.push(signal); return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); };
    const log = logger();
    const jobs = new Presummaries(CONFIG, hang, log);
    jobs.consider("a", turn("x"), 900);
    jobs.close();
    await flush();
    expect(seen[0]?.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith("presummary_failed", expect.objectContaining({ error: "aborted" }));
    vi.useFakeTimers();
    try {
      const timed = new Presummaries(CONFIG, hang, log, { entries: 8, ageMs: 1000, timeoutMs: 50 });
      timed.consider("b", turn("y"), 900);
      await vi.advanceTimersByTimeAsync(60);
      expect(timed.describe()).toEqual({ running: 0, ready: 0, failed: 1 });
    } finally { vi.useRealTimers(); }
  });

  it("drops old and surplus finished entries", async () => {
    let now = 0;
    const jobs = new Presummaries(CONFIG, fakeSend(() => "<summary>S</summary>").send, logger(), { entries: 2, ageMs: 100, timeoutMs: 1000 }, () => now);
    for (const key of ["a", "b", "c"]) { jobs.consider(key, turn(key), 900); await flush(); await flush(); }
    expect(jobs.describe().ready).toBe(2);
    now = 500;
    jobs.consider("d", turn("d"), 900); await flush(); await flush();
    expect(jobs.describe().ready).toBe(1);
  });
});
