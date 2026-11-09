import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import type { BridgeModel } from "../../src/models.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import { routedSummaryRequest } from "../../src/sessions/compaction.js";
import type { MessagesRequest } from "../../src/types.js";

const ADAPTIVE = "You are Droid, an AI software engineering agent built by Factory.\n\nSummarize this conversation or agent trajectory so the assistant can continue effectively after compaction.\n\nReturn the summary inside <summary> tags.";
const FIRST = "Please summarize the following conversation:\n```\nUSER: keep PORT 8123\n\n---\n\nASSISTANT: noted\n```\n\nRemember to wrap your final summary in <summary> tags.";
const MODELS: BridgeModel[] = [
  { id: "opus", model: "opus", displayName: "Claude Opus" },
  { id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" },
  { id: "codex:default:gpt-5.5", model: "gpt-5.5", provider: "codex", displayName: "Codex · gpt-5.5" },
];

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function config(overrides: Partial<BridgeConfig> = {}) {
  return loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "summary-route-")), port: 0, clientToken: "client", adminToken: "admin", hookToken: "hook", persistSessions: false, models: MODELS, ...overrides });
}

async function start(overrides: Partial<BridgeConfig>) {
  const seen: MessagesRequest[] = [];
  const runtime: BridgeRuntime = {
    kind: "fake",
    async handle(input) {
      seen.push(input.request);
      return { response: assistantMessage(input.request.model, [{ type: "text", text: "<summary>PORT 8123</summary>" }], "end_turn", { input_tokens: 1, output_tokens: 1 }), pendingToolIds: [] };
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
  return { seen, logger, post };
}

const summarizer = (model: string) => ({ model, max_tokens: 16000, system: ADAPTIVE, output_config: { effort: "low" }, messages: [{ role: "user", content: FIRST }] });

describe("summary route", () => {
  it("sends a Claude session's summary to the configured model and effort", async () => {
    const { seen, logger, post } = await start({ summaryRoute: { model: "sonnet", effort: "high" } });
    await post({ ...summarizer("opus"), thinking: { type: "adaptive" } });
    expect(seen[0]).toMatchObject({ model: "sonnet", output_config: { effort: "high" } });
    expect(seen[0]!.thinking).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("summary_routed", { from: "opus", to: "sonnet", effort: "high", droidEffort: "low" });
  });

  it.each([
    ["a GPT session's summary", summarizer("codex:default:gpt-5.5")],
    ["a Claude turn that allows tools", { ...summarizer("opus"), tools: [{ name: "Read", input_schema: { type: "object" } }] }],
    ["an ordinary Claude turn", { model: "opus", max_tokens: 64, output_config: { effort: "low" }, messages: [{ role: "user", content: "fix the filter" }] }],
  ])("leaves %s as Droid sent it", async (_name, body) => {
    const { seen, logger, post } = await start({ summaryRoute: { model: "sonnet", effort: "high" } });
    await post(body);
    expect(seen[0]).toMatchObject({ model: body.model, output_config: { effort: "low" } });
    expect(logger.info).not.toHaveBeenCalledWith("summary_routed", expect.anything());
  });

  it("changes nothing when no route is configured", async () => {
    const { seen, post } = await start({});
    await post(summarizer("opus"));
    expect(seen[0]).toMatchObject({ model: "opus", output_config: { effort: "low" } });
  });

  it("keeps other output_config fields and drops Droid's other effort encodings", () => {
    const request = { ...summarizer("opus"), reasoning_effort: "low", thinking: { type: "disabled" }, output_config: { effort: "low", format: "text" } } as MessagesRequest;
    expect(routedSummaryRequest(request, { model: "sonnet", effort: "medium" })).toMatchObject({
      model: "sonnet", reasoning_effort: undefined, thinking: undefined, output_config: { effort: "medium", format: "text" }, system: ADAPTIVE,
    });
  });

  it.each([
    ["a model that is not configured", { model: "haiku", effort: "high" }, /must be a Claude model/],
    ["a GPT model", { model: "codex:default:gpt-5.5", effort: "high" }, /must be a Claude model/],
    ["an unknown effort", { model: "sonnet", effort: "huge" }, /BRIDGE_SUMMARY_EFFORT/],
  ])("refuses to start with %s", (_name, summaryRoute, message) => {
    expect(() => config({ summaryRoute: summaryRoute as BridgeConfig["summaryRoute"] })).toThrow(message);
  });

  it("reads BRIDGE_SUMMARY_MODEL and BRIDGE_SUMMARY_EFFORT", () => {
    vi.stubEnv("BRIDGE_SUMMARY_MODEL", "sonnet");
    try {
      expect(config().summaryRoute).toEqual({ model: "sonnet", effort: "high" });
      vi.stubEnv("BRIDGE_SUMMARY_EFFORT", "medium");
      expect(config().summaryRoute).toEqual({ model: "sonnet", effort: "medium" });
    } finally { vi.unstubAllEnvs(); }
    expect(config().summaryRoute).toBeUndefined();
  });
});
