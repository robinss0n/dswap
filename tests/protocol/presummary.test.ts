import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import type { BridgeModel } from "../../src/models.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import { MESSAGE_BOUNDARY } from "../../src/sessions/presummary-transcript.js";

const ADAPTIVE = "You are Droid.\n\nSummarize this conversation so the assistant can continue.\n\nReturn the summary inside <summary> tags.";
const MODELS: BridgeModel[] = [
  { id: "opus", model: "opus", displayName: "Claude Opus" },
  { id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" },
  { id: "haiku", model: "haiku", displayName: "Claude Haiku" },
  { id: "codex:default:gpt-5.5", model: "gpt-5.5", provider: "codex", displayName: "Codex · gpt-5.5" },
];
const PRESUMMARY = { at: 0.7, limit: 1000, orchestratorLimit: 2000, checkModel: "haiku", checkEffort: "high" as const };

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function config(overrides: Partial<BridgeConfig> = {}) {
  return loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "presummary-")), port: 0, clientToken: "client", adminToken: "admin", hookToken: "hook",
    persistSessions: false, models: MODELS, summaryRoute: { model: "sonnet", effort: "high" }, presummary: PRESUMMARY, ...overrides });
}

interface Seen { model: string; internal: boolean; text: string; effort?: unknown }

async function start(overrides: Partial<BridgeConfig> = {}) {
  const seen: Seen[] = [];
  let cacheRead = 898;
  const runtime: BridgeRuntime = {
    kind: "fake",
    async handle(input) {
      const first = input.request.messages[0]?.content;
      const text = typeof first === "string" ? first : JSON.stringify(first);
      seen.push({ model: input.request.model, internal: input.headers["x-bridge-internal"] === "presummary", text, effort: (input.request.output_config as { effort?: unknown } | undefined)?.effort });
      const reply = text.startsWith("Transcript of the conversation") ? "<summary>CHECKED</summary>"
        : text.startsWith("Please summarize") && input.headers["x-bridge-internal"] ? "<summary>DRAFT</summary>"
        : text.startsWith("Please summarize") || text.startsWith("Previous summary") ? "<summary>FINAL</summary>" : "ok";
      return { response: assistantMessage(input.request.model, [{ type: "text", text: reply }], "end_turn", { input_tokens: 2, cache_read_input_tokens: cacheRead, output_tokens: 1 }), pendingToolIds: [] };
    },
    async cancel() {}, async deliverResults() { return []; },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfg = config(overrides);
  const app = createBridgeApp(cfg, logger, "", runtime, { alerts: { alert: vi.fn() } });
  apps.push(app);
  await listen(app, cfg);
  const post = async (body: unknown) => {
    const response = await fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    await response.text();
  };
  const until = async (count: number) => { for (let i = 0; i < 200 && seen.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
  return { app, seen, logger, post, until, setTokens: (tokens: number) => { cacheRead = tokens - 3; } };
}

const droidTurn = (model: string) => ({ model, max_tokens: 64, output_config: { effort: "high" }, messages: [{ role: "user", content: "keep PORT 8123" }] });
const droidCompaction = (transcript: string) => ({ model: "opus", max_tokens: 16000, system: ADAPTIVE, output_config: { effort: "low" },
  messages: [{ role: "user", content: `Please summarize the following conversation:\n\`\`\`\n${transcript}\n\`\`\`\n\nRemember to wrap your final summary in <summary> tags.` }] });

describe("background pre-summary over HTTP", () => {
  it("summarizes and checks in the background, then turns Droid's compaction into an update", async () => {
    const { app, seen, logger, post, until } = await start();
    await post(droidTurn("opus"));
    await until(3);
    expect(seen.map(({ model, internal }) => [model, internal])).toEqual([["opus", false], ["sonnet", true], ["haiku", true]]);
    expect(seen[1]).toMatchObject({ effort: "high" });
    expect(seen[2]).toMatchObject({ effort: "high" });
    for (let i = 0; i < 100 && !logger.info.mock.calls.some(([event]) => event === "presummary_ready"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(app.runtimeStatus()).toMatchObject({ presummary: { ready: 1, running: 0 } });
    await post(droidCompaction(`USER: keep PORT 8123${MESSAGE_BOUNDARY}ASSISTANT: ok`));
    expect(seen[3]).toMatchObject({ model: "sonnet", internal: false, effort: "high",
      text: "Previous summary:\n```\nCHECKED\n```\n\nThese messages were sent since the previous summary:\n```\nASSISTANT: ok\n```\n\nRemember to wrap your final summary in <summary> tags." });
    expect(logger.info).toHaveBeenCalledWith("summary_path", { path: "presummary", reason: "matched" });
    expect(seen).toHaveLength(4);
  });

  it("leaves a compaction it cannot match as Droid sent it", async () => {
    const { seen, logger, post, until } = await start();
    await post(droidTurn("opus"));
    await until(3);
    for (let i = 0; i < 100 && !logger.info.mock.calls.some(([event]) => event === "presummary_ready"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await post(droidCompaction(`USER: a different conversation${MESSAGE_BOUNDARY}ASSISTANT: ok`));
    expect(seen.at(-1)?.text).toMatch(/^Please summarize the following conversation:/);
    expect(seen.at(-1)?.model).toBe("sonnet");
    expect(logger.info).toHaveBeenCalledWith("summary_path", { path: "plain", reason: "no ready pre-summary matches this transcript", matchedChars: 6, transcriptChars: 50 });
  });

  it.each([
    ["a GPT session", {}, "codex:default:gpt-5.5"],
    ["the feature switched off", { presummary: undefined }, "opus"],
  ])("starts nothing for %s", async (_name, overrides, model) => {
    const { seen, post } = await start(overrides as Partial<BridgeConfig>);
    await post(droidTurn(model));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(1);
  });

  it("waits for a Missions orchestrator's own, higher limit", async () => {
    const { seen, post, until } = await start();
    await post({ ...droidTurn("opus"), system: "You are Droid.\n\n# Workstream orchestrator\n\nMission: build it" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(1);
    await post(droidTurn("opus"));
    await until(4);
    expect(seen.map(({ internal }) => internal)).toEqual([false, false, true, true]);
  });

  it("follows a compaction limit raised in Droid", async () => {
    const { app, seen, logger, post, until, setTokens } = await start();
    setTokens(1500);
    await post(droidTurn("opus"));
    await until(3);
    await post({ ...droidTurn("opus"), messages: [...droidTurn("opus").messages, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] });
    expect(logger.info).toHaveBeenCalledWith("compaction_limit_learned", expect.objectContaining({ model: "opus", role: "chat", from: 1000, to: 1500, source: "raised" }));
    expect(app.runtimeStatus()).toMatchObject({ presummary: { compactionLimits: { learned: { "opus chat": { limit: 1500 } } } } });
    setTokens(1000);
    const before = seen.length;
    await post({ ...droidTurn("opus"), messages: [{ role: "user", content: "another chat" }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.length).toBe(before + 1);
  });

  it.each([
    ["without a summary route", { summaryRoute: undefined }, /needs BRIDGE_SUMMARY_MODEL/],
    ["with a share outside 0-1", { presummary: { ...PRESUMMARY, at: 1.5 } }, /BRIDGE_PRESUMMARY_AT/],
    ["with a GPT checker", { presummary: { ...PRESUMMARY, checkModel: "codex:default:gpt-5.5" } }, /BRIDGE_SUMMARY_CHECK_MODEL/],
  ])("refuses to start %s", (_name, overrides, message) => {
    expect(() => config(overrides as Partial<BridgeConfig>)).toThrow(message);
  });

  it("reads the BRIDGE_PRESUMMARY settings", () => {
    vi.stubEnv("BRIDGE_PRESUMMARY", "1");
    vi.stubEnv("BRIDGE_COMPACTION_TOKENS", "300000");
    try {
      expect(config({ presummary: undefined }).presummary).toEqual({ at: 0.7, limit: 300000, orchestratorLimit: 500000, checkModel: "haiku", checkEffort: "high" });
    } finally { vi.unstubAllEnvs(); }
  });
});
