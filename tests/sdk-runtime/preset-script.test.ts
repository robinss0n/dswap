import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { ContentBlock, Message, ToolDefinition } from "../../src/types.js";
import { COMPACTION_SUMMARY } from "../../src/workspace.js";

// Droid's Script-mode catalog: file and shell tools exist only inside Script.
const scriptTools: ToolDefinition[] = ["Script", "WaitForScript", "AskUser", "TodoWrite", "Task", "Skill", "TaskOutput", "ToolSearch", "ExitSpecMode"]
  .map((name) => ({ name, description: `${name} tool`, input_schema: { type: "object" as const, properties: {} } }));
const droidSystem = "You are Droid, built by Factory. Use Script for file and shell work.";
const source = "const r = await tools.Read({ file_path: '/abs/a.txt' });\ntext(r);";

const runtimes: SdkRuntime[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const success = (result: string) => ({ type: "result", subtype: "success", is_error: false, result, session_id: "native-sdk-session" });
type Guard = (hook: { tool_name?: string; tool_use_id?: string }) => Promise<unknown>;

class FakeSdk implements SdkHandle {
  readonly calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  readonly inputs: SdkUserInput[] = [];
  readonly handlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
  readonly descriptions = new Map<string, string>();
  readonly mcpStatus = vi.fn(async () => [{ name: "droid", status: "connected", tools: [...this.handlers.keys()].map((name) => ({ name })) }]);
  constructor(readonly respond: (input: SdkUserInput, index: number, sdk: FakeSdk) => AsyncGenerator<Record<string, unknown>>) {}
  tool(): unknown { return {}; }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    return { ...options, instance: {
      isConnected: () => this.calls.length > 0,
      sendToolListChanged: () => undefined,
      server: { sendToolListChanged: async () => undefined, setRequestHandler: () => undefined },
      registerTool: (name: string, config: { inputSchema: { parse(input: unknown): Record<string, unknown> }; description: string }, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => {
        const wrapped = (args: Record<string, unknown>, extra?: unknown) => handler(config.inputSchema.parse(args), extra);
        this.handlers.set(name, wrapped);
        this.descriptions.set(name, config.description);
        return { update: () => undefined, remove: () => { if (this.handlers.get(name) === wrapped) this.handlers.delete(name); } };
      },
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args);
    const self = this;
    return {
      interrupt: vi.fn(async () => undefined), close: vi.fn(), mcpServerStatus: this.mcpStatus,
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          self.inputs.push(input);
          yield { type: "system", subtype: "init", session_id: "native-sdk-session" };
          yield* self.respond(input, self.inputs.length - 1, self);
        }
      },
    };
  }
  guard(call = 0): Guard {
    return (this.calls[call]!.options.hooks as { PreToolUse: Array<{ hooks: Guard[] }> }).PreToolUse[0]!.hooks[0]!;
  }
}

function create(sdk: FakeSdk, overrides = {}) {
  const config = loadConfig({
    mode: "sdk", dataDir: mkdtempSync(join(tmpdir(), "relay-preset-script-")), authMode: "byok", permissionMode: "bypass", promptMode: "claude-code",
    upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline-test-model", upstreamTokenEnv: "BRIDGE_TEST_FAKE_KEY",
    requestTimeoutMs: 5_000, toolWaitMs: 5_000, persistSessions: true, ...overrides,
  });
  const runtime = new SdkRuntime(config, logger, sdk);
  runtimes.push(runtime);
  return runtime;
}
function session(extra: Partial<SessionRecord> = {}): SessionRecord {
  return { bridgeSessionId: "session-a", role: "chat", state: "NEW", model: "relay", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...extra };
}
const user = (content: string | ContentBlock[]): Message => ({ role: "user", content });
function request(s: SessionRecord, messages: Message[], extra: Partial<RuntimeRequest["request"]> = {}): RuntimeRequest {
  return { request: { model: "relay", max_tokens: 100, system: droidSystem, tools: scriptTools, messages, ...extra }, session: s, role: "chat", headers: {} };
}
const inputText = (input: SdkUserInput | undefined) => JSON.stringify(input?.message.content ?? "");
const denied = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };

beforeEach(() => { vi.stubEnv("BRIDGE_TEST_FAKE_KEY", "offline-placeholder-never-sent"); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); vi.unstubAllEnvs(); });

describe("BRIDGE_PROMPT=claude-code with Droid's Script-only catalog", () => {
  it("keeps the preset, forwards Droid's instructions once, and routes every Droid tool through MCP", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`reply-${index}`); });
    const runtime = create(sdk);
    const s = session();
    await runtime.handle(request(s, [user("first")]));
    const options = sdk.calls[0]!.options;
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(options.env).toMatchObject({ CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? "1000000" });
    expect(options.settings).toEqual({ autoCompactEnabled: false });
    // None of Droid's Script-mode tools is a native file/shell equivalent, so all stay on Droid's side.
    expect([...sdk.handlers.keys()].sort()).toEqual(scriptTools.map((tool) => tool.name).sort());
    const first = inputText(sdk.inputs[0]);
    expect(first).toContain(`Host context (dynamic):\\n${droidSystem}`);
    expect(first).toContain("Allowed native tool equivalents for this host request: none.");

    await runtime.handle(request(s, [user("first"), { role: "assistant", content: "reply-0" }, user("second")]));
    expect(inputText(sdk.inputs[1])).not.toContain("Host context (dynamic)");

    const changed = `${droidSystem}\nThe user switched to spec mode.`;
    await runtime.handle(request(s, [user("first"), { role: "assistant", content: "reply-0" }, user("second"), { role: "assistant", content: "reply-1" }, user("third")], { system: changed }));
    expect(inputText(sdk.inputs[2])).toContain("The user switched to spec mode.");
    expect(sdk.calls).toHaveLength(1);
  });

  it("denies every native Claude Code tool while Droid advertises only Script", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const runtime = create(sdk);
    const controller = vi.fn(async () => ({ behavior: "allow" as const }));
    runtime.setControl({ requestApproval: controller });
    await runtime.handle(request(session(), [user("go")]));
    const guard = sdk.guard();
    for (const name of ["Read", "Bash", "Write", "Edit", "Glob", "Grep", "Agent", "Task", "Skill", "ToolSearch", "WebFetch", "TodoWrite", "ExitPlanMode"]) {
      expect(await guard({ tool_name: name }), name).toMatchObject(denied);
    }
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Bash", { command: "ls" })).toMatchObject({ behavior: "deny" });
    expect(controller).not.toHaveBeenCalled();
    for (const name of scriptTools.map((tool) => `mcp__droid__${tool.name}`)) expect(await guard({ tool_name: name }), name).toEqual({});
  });

  it("round-trips a Script call and its result on one native query", async () => {
    const scriptResult = "contents of a.txt\n\nstatus: completed · 0.1s";
    const seen: { result?: unknown } = {};
    const sdk = new FakeSdk(async function* (_input, index, fake) {
      if (index !== 0) return;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "script-1", name: "mcp__droid__Script", input: { script: source } }] } };
      seen.result = await fake.handlers.get("Script")!({ script: source }, { toolUseID: "script-1" });
      yield { type: "assistant", message: { content: [{ type: "text", text: "Read it." }] } };
      yield success("Read it.");
    });
    const runtime = create(sdk);
    const s = session();
    const opening = user("read a.txt");
    const first = await runtime.handle(request(s, [opening]));
    expect(first.response.stop_reason).toBe("tool_use");
    expect(first.response.content).toContainEqual(expect.objectContaining({ type: "tool_use", id: "script-1", name: "Script", input: { script: source } }));
    const reminder = "<system-reminder>Script bindings loaded: WebSearch</system-reminder>";
    const done = await runtime.handle(request(s, [opening, { role: "assistant", content: first.response.content },
      user([{ type: "tool_result", tool_use_id: "script-1", content: scriptResult }, { type: "text", text: reminder }])]));
    expect(seen.result).toMatchObject({ isError: false, content: [{ type: "text", text: scriptResult }, { type: "text", text: expect.stringContaining("Host continuation context") }, { type: "text", text: reminder }] });
    expect(done.response.stop_reason).toBe("end_turn");
    expect(done.response.content).toContainEqual({ type: "text", text: "Read it." });
    expect(sdk.calls).toHaveLength(1);
  });

  it("reseeds after Droid compaction without replaying historical Script calls", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`reply-${index}`); });
    const runtime = create(sdk);
    const summary = user([{ type: "text", text: `${COMPACTION_SUMMARY}\n<summary>Edited a.txt via Script.</summary>` }]);
    const history: Message[] = [
      summary,
      { role: "assistant", content: [{ type: "tool_use", id: "old-script", name: "Script", input: { script: "await tools.Execute({ command: 'rm x' })" } }] },
      user([{ type: "tool_result", tool_use_id: "old-script", content: "removed" }]),
      { role: "assistant", content: "Done earlier." },
      user("continue"),
    ];
    const turn = await runtime.handle(request(session({ bridgeSessionId: "session-c" }), history));
    expect(turn.continuity).toMatchObject({ kind: "reseeded", reason: "droid-compaction" });
    const content = inputText(sdk.inputs[0]);
    expect(content).toContain("Imported conversation history");
    expect(content).toContain("Edited a.txt via Script.");
    expect(content).toContain("Historical tool call Script:");
    expect(content).toContain(`Host context (dynamic):\\n${droidSystem}`);
    expect(sdk.inputs[0]!.message.content).not.toContainEqual(expect.objectContaining({ type: "tool_use" }));
    expect(sdk.inputs[0]!.message.content).not.toContainEqual(expect.objectContaining({ type: "tool_result" }));
    expect(sdk.calls[0]!.options.resume).toBeUndefined();
  });

  it("rebuilds from Droid's history after Claude Code compacts on its own", async () => {
    const sdk = new FakeSdk(async function* (_input, index) {
      if (index === 0) yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 190_000 } };
      yield success(`reply-${index}`);
    });
    const runtime = create(sdk);
    const s = session();
    await runtime.handle(request(s, [user("remember Pine")]));
    const turn = await runtime.handle(request({ ...s, sdkSessionId: "native-sdk-session" }, [user("remember Pine"), { role: "assistant", content: "reply-0" }, user("what was it?")]));
    expect(sdk.calls).toHaveLength(2);
    expect(turn.continuity).toMatchObject({ kind: "reseeded", reason: "claude-code-compaction:auto" });
    expect(inputText(sdk.inputs[1])).toContain("remember Pine");
    expect(inputText(sdk.inputs[1])).toContain(`Host context (dynamic):\\n${droidSystem}`);
    expect([...sdk.handlers.keys()]).toContain("Script");
  });

  it("desktop profile keeps Script on Droid's side and denies native reads Droid did not advertise", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const project = realpathSync(mkdtempSync(join(tmpdir(), "relay-preset-script-project-")));
    const dataDir = join(mkdtempSync(join(tmpdir(), "relay-preset-script-desktop-")), "bridge-data");
    const runtime = create(sdk, { desktopProfile: true, permissionMode: "ask", dataDir });
    const reminder: ContentBlock = { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n${project}\n</system-reminder>` };
    await runtime.handle(request(session(), [user([reminder, { type: "text", text: "go" }])]));
    expect([...sdk.handlers.keys()]).toEqual(expect.arrayContaining(["Script", "WaitForScript", "Task", "Skill"]));
    const guard = sdk.guard();
    for (const name of ["Read", "Grep", "Bash", "Write", "Agent", "Skill"]) expect(await guard({ tool_name: name }), name).toMatchObject(denied);
    expect(await guard({ tool_name: "mcp__droid__Script" })).toEqual({});
  });
});

describe("BRIDGE_PROMPT=claude-code with a remote workspace", () => {
  const direct: ToolDefinition[] = ["Read", "LS", "Grep", "Glob", "Create", "Edit", "Execute", "Task", "Skill"]
    .map((name) => ({ name, input_schema: { type: "object" as const, properties: {} } }));
  function remote(sdk: FakeSdk) {
    const dataDir = join(mkdtempSync(join(tmpdir(), "relay-preset-remote-")), "bridge-data");
    return create(sdk, { desktopProfile: true, permissionMode: "ask", remoteWorkspace: true, dataDir });
  }
  // The project exists only on Droid's machine; nothing here reads it.
  const reminder: ContentBlock = { type: "text", text: "<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n/home/someone/project-on-droid-machine\n</system-reminder>" };

  it.each([["direct", direct], ["Script", scriptTools]] as const)("keeps the preset, exposes every %s-mode Droid tool and denies every native tool", async (_mode, catalog) => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const runtime = remote(sdk);
    await runtime.handle(request(session(), [user([reminder, { type: "text", text: "go" }])], { tools: [...catalog] }));
    const options = sdk.calls[0]!.options;
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect((options.systemPrompt as { append: string }).append).toContain("Remote workspace:");
    expect(options.cwd).toMatch(/bridge-data\/remote-cwd$/);
    expect([...sdk.handlers.keys()].sort()).toEqual(catalog.map((tool) => tool.name).sort());
    expect(inputText(sdk.inputs[0])).toContain("Allowed native tool equivalents for this host request: none.");
    const guard = sdk.guard();
    for (const name of ["Read", "LS", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Skill", "WebFetch"]) {
      expect(await guard({ tool_name: name }), name).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("Remote workspace") } });
    }
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Read", { file_path: "/etc/hostname" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("Remote workspace") });
    for (const tool of catalog) expect(await guard({ tool_name: `mcp__droid__${tool.name}` }), tool.name).toEqual({});
  });
});
