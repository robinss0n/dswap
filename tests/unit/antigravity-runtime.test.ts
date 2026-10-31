import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import { googleModels } from "../../src/models.js";
import type { AcpClient } from "../../src/runtime/antigravity/acp-client.js";
import type { DroidMcpHost } from "../../src/runtime/antigravity/droid-mcp-host.js";
import { AntigravityRuntime, DROID_HOST_NOTICE } from "../../src/runtime/antigravity/runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { MessagesRequest } from "../../src/types.js";
import { ACP_CLIENT_INFO, initializeAgent } from "../../src/upstream/google-accounts.js";

const dirs: string[] = [];
const logger: Logger = { info() {}, warn() {}, error() {} };
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "agy-")); dirs.push(dir); return dir; };

function setup(initial: string, thinking = true, menu: string[] = [initial]) {
  let model = initial;
  const project = tmp();
  const config: BridgeConfig = loadConfig({ dataDir: tmp(), mode: "sdk", authMode: "subscription", sdkCwd: project, models: googleModels(menu, ["main"]) });
  const calls: Array<[string, any]> = [];
  const options = (current: string) => [
    { id: "model", currentValue: model, options: [{ value: model }] },
    ...(thinking ? [{ id: "thinking_level", currentValue: current, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] }] : []),
  ];
  let level = "high";
  const client = {
    exited: new Promise(() => {}), close() {}, notify() {},
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === "session/new") return { sessionId: "acp-1", configOptions: options(level) };
      if (method === "session/set_config_option") {
        if (params.configId === "thinking_level") level = params.value;
        if (params.configId === "model") model = params.value;
        return { configOptions: options(level) };
      }
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    },
  } as unknown as AcpClient;
  const mcpHost = { register: async () => ({ url: "http://127.0.0.1:1/mcp", dispose() {} }), close: async () => {} } as unknown as DroidMcpHost;
  const runtime = new AntigravityRuntime(config, logger, { open: () => client, accountHome: () => tmp(), mcpHost });
  const session: SessionRecord = {
    bridgeSessionId: "bridge-google", role: "chat", state: "IDLE", model: `google:main:${initial}`, provider: "google",
    toolNames: ["Read"], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
  };
  const input = (extra: Partial<MessagesRequest> = {}): RuntimeRequest => ({
    request: { model: `google:main:${initial}`, max_tokens: 100, system: "You are Droid.", messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }], ...extra } as MessagesRequest,
    role: "chat", session, headers: { "x-bridge-role": "chat" },
  });
  const switchTo = (next: string): RuntimeRequest => {
    const request = input();
    return { ...request, request: { ...request.request, model: `google:main:${next}` } };
  };
  return { runtime, calls, input, switchTo, config };
}

describe("AntigravityRuntime", () => {
  it("introduces itself as Zed, the identity Antigravity offers its full model list to", async () => {
    let sent: any;
    await initializeAgent({ request: async (_method: string, params: any) => { sent = params; return {}; } } as unknown as AcpClient);
    expect(sent.clientInfo).toEqual(ACP_CLIENT_INFO);
    expect(ACP_CLIENT_INFO.name).toBe("zed");
  });

  it("appends Droid's prompt behind the host notice and picks the model by base id", async () => {
    const { runtime, calls, input } = setup("gemini-3.8-flash");
    await runtime.handle(input());
    const created = calls.find(([method]) => method === "session/new")![1];
    expect(created._meta.antigravity.systemPrompt.append).toBe(`${DROID_HOST_NOTICE}\n\nYou are Droid.`);
    expect(created._meta.antigravity.enabledTools).toEqual([]);
    expect(calls).toContainEqual(["session/set_config_option", { sessionId: "acp-1", configId: "model", value: "gemini-3.8-flash" }]);
  });

  it.each([["off", "low"], ["low", "low"], ["medium", "medium"], ["xhigh", "high"], ["max", "high"]])("maps Droid level %s to thinking_level %s", async (level, wanted) => {
    const { runtime, calls, input } = setup("gemini-3.8-flash");
    const extra = level === "off" ? { thinking: { type: "between_tools" } } : { output_config: { effort: level } };
    await runtime.handle(input(extra as Partial<MessagesRequest>));
    const levels = calls.filter(([method, params]) => method === "session/set_config_option" && params.configId === "thinking_level").map(([, params]) => params.value);
    // The session starts at "high"; it is only changed when Droid asks for something else.
    expect(levels).toEqual(wanted === "high" ? [] : [wanted]);
  });

  it("leaves models without a thinking option alone", async () => {
    const { runtime, calls, input } = setup("claude-opus-4-6-thinking", false);
    await runtime.handle(input({ output_config: { effort: "low" } } as Partial<MessagesRequest>));
    expect(calls.some(([method, params]) => method === "session/set_config_option" && params.configId === "thinking_level")).toBe(false);
  });

  it("selects the new model when Droid switches models inside a conversation", async () => {
    const { runtime, calls, input, switchTo } = setup("gemini-3.8-flash", true, ["gemini-3.8-flash", "claude-sonnet-4-6"]);
    await runtime.handle(input());
    calls.length = 0;
    await runtime.handle({ ...switchTo("claude-sonnet-4-6"), request: { ...switchTo("claude-sonnet-4-6").request, messages: [
      { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }] } });
    expect(calls).toContainEqual(["session/set_config_option", { sessionId: "acp-1", configId: "model", value: "claude-sonnet-4-6" }]);
    expect(calls.some(([method]) => method === "session/new")).toBe(false);
  });
});
