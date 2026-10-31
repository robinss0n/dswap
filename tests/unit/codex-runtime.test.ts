import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import { codexModels } from "../../src/models.js";
import type { AppServerOptions, CodexAppServer } from "../../src/runtime/codex/app-server.js";
import { CodexRuntime } from "../../src/runtime/codex/runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { Message, MessagesRequest } from "../../src/types.js";

const MODEL = "codex:default:gpt-6.1-sol";
const dirs: string[] = [];
const logger: Logger = { info() {}, warn() {}, error() {} };
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

function config(): BridgeConfig {
  const dir = mkdtempSync(join(tmpdir(), "codex-runtime-"));
  dirs.push(dir);
  return loadConfig({ dataDir: dir, mode: "sdk", authMode: "subscription", models: codexModels(["gpt-6.1-sol"], ["default"]) });
}

const session: SessionRecord = {
  bridgeSessionId: "bridge-codex", role: "chat", state: "IDLE", model: MODEL, provider: "codex",
  toolNames: ["Read"], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
  usage: { input_tokens: 0, output_tokens: 0, estimated: true },
};

function input(messages: Message[], extra: Partial<MessagesRequest> = {}): RuntimeRequest {
  return {
    request: { model: MODEL, max_tokens: 1000, messages, tools: [{ name: "Read", input_schema: { type: "object" } }], ...extra } as MessagesRequest,
    role: "chat", session, headers: { "x-bridge-role": "chat" },
  };
}

/** A fake app-server: the test decides when Codex calls tools and ends turns. */
function fakeServer() {
  const state: { options?: AppServerOptions; turnStarts: any[]; threadStart?: any } = { turnStarts: [] };
  const open = (options: AppServerOptions) => {
    state.options = options;
    return {
      exited: new Promise(() => {}),
      initialize: async () => ({}),
      close() {},
      request: async (method: string, params: any) => {
        if (method === "thread/start") { state.threadStart = params; return { thread: { id: "thread-1" } }; }
        if (method === "turn/start") { state.turnStarts.push(params); return { turn: { id: `turn-${state.turnStarts.length}` } }; }
        return {};
      },
    } as unknown as CodexAppServer;
  };
  const call = (callId: string) => state.options!.onRequest!("item/tool/call", { callId, tool: "Read", arguments: { file_path: `/${callId}` } });
  return { open, state, call };
}

const toolUses = (content: Array<{ type: string; id?: string }>) => content.filter((block) => block.type === "tool_use").map((block) => block.id);

describe("CodexRuntime", () => {
  it("answers parallel tool calls in one response, and never drops a call Droid has not seen", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "go" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Codex runs a model's parallel calls at once; their requests land ms apart.
    void fake.call("exec-a");
    setTimeout(() => void fake.call("exec-b"), 20);
    setTimeout(() => void fake.call("exec-c"), 40);
    const turn = await first;
    expect(turn.response.stop_reason).toBe("tool_use");
    expect(toolUses(turn.response.content as any)).toEqual(["exec-a", "exec-b", "exec-c"]);
    expect(turn.pendingToolIds).toEqual(["exec-a", "exec-b", "exec-c"]);
  });

  it("carries a call that arrived after the response into the next one instead of an empty tool_use reply", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "go" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    void fake.call("exec-a");
    const turn = await first;
    expect(toolUses(turn.response.content as any)).toEqual(["exec-a"]);
    // A late sibling, after the first response already went out.
    void fake.call("exec-late");
    const next = await runtime.handle(input([
      { role: "user", content: "go" },
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-a", content: "ok" }] },
    ]));
    expect(next.response.stop_reason).toBe("tool_use");
    expect(toolUses(next.response.content as any)).toEqual(["exec-late"]);
    expect(next.pendingToolIds).toEqual(["exec-late"]);
  });

  it.each([["off", "low"], ["xhigh", "xhigh"], ["max", "max"]])("maps Droid level %s to Codex effort %s", async (level, effort) => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const extra = level === "off" ? { thinking: { type: "between_tools" } } : { output_config: { effort: level } };
    const pending = runtime.handle(input([{ role: "user", content: "go" }], extra as Partial<MessagesRequest>));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.state.turnStarts[0].effort).toBe(effort);
    // Codex must not tell the model its (unused) sandbox is read-only.
    expect(fake.state.threadStart.config).toMatchObject({ include_permissions_instructions: false, include_environment_context: false });
    void fake.call("exec-a");
    await pending;
  });
});
