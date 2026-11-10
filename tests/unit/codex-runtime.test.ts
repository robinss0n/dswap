import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import { codexModels } from "../../src/models.js";
import { CodexRpcError, type AppServerOptions, type CodexAppServer } from "../../src/runtime/codex/app-server.js";
import { CODEX_AUTO_COMPACT_OFF, CODEX_DEVELOPER_INSTRUCTIONS, CODEX_EXEC_YIELD_MS, CodexRuntime, droidCodexCatalog } from "../../src/runtime/codex/runtime.js";
import { responsesUsage } from "../../src/http/responses-stream.js";
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
    request: { model: MODEL, max_tokens: 1000, system: "You are Droid.", messages, tools: [{ name: "Read", input_schema: { type: "object" } }], ...extra } as MessagesRequest,
    role: "chat", session, headers: { "x-bridge-role": "chat" },
  };
}

/** A fake app-server: the test decides when Codex calls tools and ends turns. */
function fakeServer() {
  const state: { options?: AppServerOptions; turnStarts: any[]; threadStart?: any; threadStarts: number; threadResumes: any[]; resumeError?: Error; startError?: Error; closed: number; steers: any[]; steerError?: Error; log: string[]; exit?: () => void } = { turnStarts: [], threadStarts: 0, threadResumes: [], closed: 0, steers: [], log: [] };
  const open = (options: AppServerOptions) => {
    state.options = options;
    return {
      exited: new Promise<void>((resolve) => { state.exit = resolve; }),
      stderrTail: () => "fatal: test crash",
      initialize: async () => ({}),
      close() { state.closed += 1; },
      request: async (method: string, params: any) => {
        state.log.push(method);
        if (method === "thread/start" && state.startError) throw state.startError;
        if (method === "thread/start") { state.threadStart = params; state.threadStarts += 1; return { thread: { id: `thread-${state.threadStarts}` } }; }
        if (method === "thread/resume") {
          state.threadResumes.push(params);
          if (state.resumeError) throw state.resumeError;
          return { thread: { id: params.threadId } };
        }
        if (method === "turn/start") { state.turnStarts.push(params); return { turn: { id: `turn-${state.turnStarts.length}` } }; }
        if (method === "turn/steer") {
          if (state.steerError) throw state.steerError;
          state.steers.push(params);
          return { turnId: params.expectedTurnId };
        }
        return {};
      },
    } as unknown as CodexAppServer;
  };
  const call = (callId: string, tool = "Read", args: Record<string, unknown> = { file_path: `/${callId}` }) => {
    const answer = state.options!.onRequest!("item/tool/call", { callId, tool, arguments: args }) as Promise<{ contentItems: any[]; success: boolean }>;
    void answer.then(() => state.log.push(`resolved:${callId}`), () => state.log.push(`rejected:${callId}`));
    return answer;
  };
  const notify = (method: string, params: unknown) => state.options!.onNotification!(method, params);
  return { open, state, call, notify };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const texts = (items: any[]) => items.map((item) => item.text ?? item.url ?? item.imageUrl).join("\n");

const toolUses = (content: Array<{ type: string; id?: string }>) => content.filter((block) => block.type === "tool_use").map((block) => block.id);
const withAskUser = [{ name: "Read", input_schema: { type: "object" } }, { name: "AskUser", input_schema: { type: "object" } }];

describe("explicit fresh tool boundary", () => {
  async function waiting() {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "quiz" }]));
    await tick();
    const answer = fake.call("question");
    const turn = await first;
    const messages: Message[] = [{ role: "user", content: "quiz" }, { role: "assistant", content: turn.response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "question", content: "correct" }] }];
    const marked = (body = messages, boundaryId = "b1") => ({ ...input(body), previousSession: { ...session, historyMessageHashes: [...((runtime as any).lives.get(session.bridgeSessionId)?.history ?? [])], pendingToolIds: [...((runtime as any).lives.get(session.bridgeSessionId)?.pending.keys() ?? [])] }, headers: {
      "x-bridge-session": session.bridgeSessionId,
      "x-bridge-fresh-tool-turn": JSON.stringify({ v: 1, boundary_id: boundaryId, answered_call_ids: ["question"] }),
    } });
    const live = (runtime as any).lives.get(session.bridgeSessionId);
    live.server.closeAndWait = async () => { fake.state.closed++; };
    return { fake, runtime, answer, messages, marked, live };
  }
  it.each(["correct", "wrong", "free recall"])("imports %s once, rejects callbacks, replays immutable receipt", async (answerText) => {
    const { fake, runtime, answer, messages, marked } = await waiting();
    (messages[2].content as any)[0].content = answerText;
    const next = runtime.handle(marked());
    await expect(answer).rejects.toMatchObject({ code: "cancelled" });
    await tick();
    expect(fake.state.threadStarts).toBe(2);
    const reference = texts(fake.state.turnStarts[1].input);
    expect(reference).toContain('"tool_use_id":"question"');
    expect(reference).toContain(answerText);
    expect(reference.match(/"tool_result"/g)).toHaveLength(1);
    fake.notify("turn/completed", { turn: { status: "completed" } });
    const reply = await next;
    expect(await runtime.handle(marked())).toEqual(reply);
    expect(fake.state.turnStarts).toHaveLength(2);
    (messages[2].content as any)[0].content = "changed";
    await expect(runtime.handle(marked())).rejects.toMatchObject({ code: "fresh_boundary_rejected" });
    await expect(runtime.handle(marked(messages, "b2"))).rejects.toMatchObject({ code: "fresh_boundary_rejected" });
    await runtime.close();
  });
  it.each(["truncate", "mutate", "foreign", "duplicate", "missing", "orphan", "image", "result-image"])("rejects %s before destruction", async (mode) => {
    const { fake, runtime, messages, marked, live } = await waiting();
    if (mode === "image") (messages[2].content as any).push({ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } });
    if (mode === "result-image") (messages[2].content as any)[0].content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }];
    if (mode === "truncate") messages.shift();
    if (mode === "mutate") messages[0].content = "changed";
    if (mode === "foreign") (messages[2].content as any)[0].tool_use_id = "foreign";
    if (mode === "duplicate") (messages[2].content as any).push((messages[2].content as any)[0]);
    if (mode === "missing") messages.pop();
    if (mode === "orphan") live.orphaned.set("orphan", { name: "Read", input: {} });
    await expect(runtime.handle(marked())).rejects.toMatchObject({ code: "fresh_boundary_rejected" });
    expect(fake.state.closed).toBe(0);
    expect(runtime.isSessionUsable(session.bridgeSessionId)).toBe(true);
    await runtime.close();
  });
  it.each(["new", "schema", "placeholder"])("requires mixed sibling completion before adopting changed catalog (%s)", async mode => {
    const { fake, runtime, marked, messages, live } = await waiting();
    live.pending.set("sibling", { name: "Read", input: {}, resolve() {}, reject() {} });
    (messages[1].content as any).push({ type: "tool_use", id: "sibling", name: "Read", input: {} });
    const { historyMessageHashes } = await import("../../src/sessions/correlate.js");
    live.history = historyMessageHashes(messages.slice(0, 2));
    const changed = marked();
    const toolName = mode === "schema" ? "Read" : mode === "placeholder" ? "AskUser" : "NewTool";
    changed.request.tools = [{ name: toolName, input_schema: { type: "object", properties: { changed: { type: "string" } } } }];
    await expect(runtime.handle(changed)).rejects.toMatchObject({ code: "fresh_boundary_rejected" });
    expect(fake.state.closed).toBe(0);
    (messages[2].content as any).push({ type: "tool_result", tool_use_id: "sibling", is_error: true, content: "error detail" });
    const next = runtime.handle(changed);
    await tick();
    expect(fake.state.threadStart.dynamicTools).toContainEqual(expect.objectContaining({ name: toolName }));
    expect(texts(fake.state.turnStarts[1].input)).toContain('"is_error":true');
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await next;
    await runtime.close();
  });
  it("retains stable failure when old child cannot exit", async () => {
    const { fake, runtime, marked, live } = await waiting();
    live.server.closeAndWait = async () => { throw new Error("termination timeout"); };
    await expect(runtime.handle(marked())).rejects.toMatchObject({ code: "fresh_boundary_failed" });
    await expect(runtime.handle(marked())).rejects.toMatchObject({ code: "fresh_boundary_failed" });
    expect(fake.state.threadStarts).toBe(1);
    await runtime.close();
  });
  it("fences cancellation while old child exit is outstanding", async () => {
    const { fake, runtime, marked, live } = await waiting();
    let exit!: () => void;
    live.server.closeAndWait = () => new Promise<void>((resolve) => { exit = resolve; });
    const next = runtime.handle(marked());
    await tick();
    expect(fake.state.threadStarts).toBe(1);
    await runtime.cancel(session.bridgeSessionId, "disconnect");
    exit();
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
    await expect(runtime.handle(marked())).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.state.threadStarts).toBe(1);
    await runtime.close();
  });
});

describe("CodexRuntime catalog transitions", () => {
  const prober = [{ name: "probe", input_schema: { type: "object" } }];
  const teacher = [...prober, { name: "plan_init", input_schema: { type: "object" } }];
  it.each(["live", "retired", "legacy-advertised"])("rebuilds prober history for teacher tools (%s), then reuses it", async (mode) => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const messages: Message[] = [{ role: "user", content: "probe first" }];
    const first = runtime.handle(input(messages, { tools: prober }));
    await tick();
    fake.notify("item/agentMessage/delta", { itemId: "probe-answer", delta: "probe complete" });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    const answer = await first;
    messages.push({ role: "assistant", content: answer.response.content }, { role: "user", content: "teach now" });
    if (mode === "retired") await runtime.endHostSession(session.bridgeSessionId, "test");
    if (mode === "legacy-advertised") {
      // Model the old updateAdvertised bug: the name was advertised but never registered.
      const lives = (runtime as unknown as { lives: Map<string, { advertised: Set<string> }> }).lives;
      lives.get(session.bridgeSessionId)!.advertised.add("plan_init");
    }
    if (mode === "live") {
      await expect(runtime.handle(input([{ role: "user", content: "truncated" }], { tools: teacher })))
        .rejects.toMatchObject({ status: 409 });
      expect(fake.state.closed).toBe(0);
    }
    const next = runtime.handle(input(messages, { tools: teacher }));
    await tick();
    expect(fake.state.threadStarts).toBe(2);
    expect(fake.state.threadResumes).toHaveLength(0);
    expect(fake.state.threadStart.dynamicTools).toContainEqual(expect.objectContaining({ name: "plan_init" }));
    expect(texts(fake.state.turnStarts[1].input)).toContain("probe complete");
    const call = fake.call("plan", "plan_init");
    const toolTurn = await next;
    expect(toolTurn.pendingToolIds).toEqual(["plan"]);
    const followup = runtime.handle(input([...messages, { role: "assistant", content: toolTurn.response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "plan", content: "plan saved" }] }], { tools: teacher }));
    await call;
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await followup;
    expect(fake.state.threadStarts).toBe(2);
    await runtime.close();
  });

  it.each([false, true])("rejects a pending transition without resolving calls or cancelling (orphan=%s)", async (orphan) => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const messages: Message[] = [{ role: "user", content: "probe" }];
    const first = runtime.handle(input(messages, { tools: prober }));
    await tick();
    const call = fake.call("probe-call", "probe");
    const turn = await first;
    if (orphan) fake.notify("turn/completed", { turn: { status: "completed" } });
    messages.push({ role: "assistant", content: turn.response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "probe-call", content: "done" }] });
    await expect(runtime.handle(input(messages, { tools: teacher }))).rejects.toMatchObject({ status: 409, code: "codex_catalog_transition_pending" });
    expect(fake.state.closed).toBe(0);
    expect(runtime.pendingHostCalls(session.bridgeSessionId)).toHaveLength(1);
    const finish = runtime.handle(input(messages, { tools: prober }));
    await tick();
    await expect(runtime.handle(input(messages, { tools: teacher }))).rejects.toMatchObject({ status: 409 });
    await call;
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await finish;
    await runtime.close();
  });
});

describe("CodexRuntime thread resume", () => {
  const opening: Message = { role: "user", content: "original question" };
  async function finished(runtime: CodexRuntime, fake: ReturnType<typeof fakeServer>, request = input([opening])) {
    const pending = runtime.handle(request);
    await tick();
    fake.notify("item/agentMessage/delta", { itemId: "answer", delta: "original answer" });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    return pending;
  }

  it.each(["host", "forget", "trim"] as const)("resumes a clean thread retired by %s, restoring its tools and sending only new input", async (retirement) => {
    const fake = fakeServer();
    const info = vi.fn();
    const runtime = new CodexRuntime({ ...config(), maxIdleSessions: retirement === "trim" ? 0 : 4 }, { ...logger, info }, { open: fake.open });
    const turn = await finished(runtime, fake);
    if (retirement === "host") expect(await runtime.endHostSession(session.bridgeSessionId, "host-ended")).toEqual({ resumable: true, sdkSessionId: "thread-1" });
    if (retirement === "forget") await runtime.forget({ bridgeSessionId: session.bridgeSessionId });
    await tick();
    expect(runtime.isSessionUsable(session.bridgeSessionId)).toBe(false);
    const next = runtime.handle(input([
      opening, { role: "assistant", content: turn.response.content }, { role: "user", content: "new question" },
    ], { tools: [...withAskUser] }));
    await tick();
    expect(fake.state.threadStarts).toBe(1);
    expect(fake.state.threadResumes).toEqual([expect.objectContaining({
      threadId: "thread-1", model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only",
      config: fake.state.threadStart.config, excludeTurns: true,
    })]);
    expect(fake.state.threadResumes[0].dynamicTools).toBeUndefined();
    const sent = texts(fake.state.turnStarts[1].input);
    expect(sent).toContain("new question");
    expect(sent).toContain("Droid loaded AskUser");
    expect(sent).not.toContain("original question");
    expect(sent).not.toContain("original answer");
    expect(info).toHaveBeenCalledWith("codex_thread_resumed", { account: "default", threadId: "thread-1" });
    const call = fake.call("resumed-read");
    const toolTurn = await next;
    expect(toolTurn.pendingToolIds).toEqual(["resumed-read"]);
    await runtime.completeHostTool(session.bridgeSessionId, { toolUseId: "resumed-read", toolName: "Read", input: { file_path: "/resumed-read" }, content: "ok" });
    await call;
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await runtime.close();
  });

  it("retires an idle session whose app-server died, then resumes its thread in a new server", async () => {
    const fake = fakeServer();
    const warn = vi.fn();
    const runtime = new CodexRuntime(config(), { ...logger, warn }, { open: fake.open });
    const turn = await finished(runtime, fake);
    fake.state.exit!();
    await tick();
    expect(warn).toHaveBeenCalledWith("codex_app_server_exited", expect.objectContaining({ running: false, stderr: "fatal: test crash" }));
    expect(runtime.isSessionUsable(session.bridgeSessionId)).toBe(false);
    const next = runtime.handle(input([opening, { role: "assistant", content: turn.response.content }, { role: "user", content: "after crash" }]));
    await tick();
    expect(fake.state.threadResumes).toEqual([expect.objectContaining({ threadId: "thread-1" })]);
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await next;
    await runtime.close();
  });

  it.each(["prefix", "reply", "resume-error", "unseen-assistant"] as const)("imports history instead when %s is incompatible", async (failure) => {
    const fake = fakeServer();
    const warn = vi.fn();
    const runtime = new CodexRuntime(config(), { ...logger, warn }, { open: fake.open });
    const turn = await finished(runtime, fake);
    await runtime.endHostSession(session.bridgeSessionId, "host-ended");
    if (failure === "resume-error") fake.state.resumeError = new Error("rollout missing");
    const messages: Message[] = [
      failure === "prefix" ? { ...opening, content: "edited opening" } : opening,
      { role: "assistant", content: failure === "reply" ? "edited reply" : turn.response.content },
      ...(failure === "unseen-assistant" ? [{ role: "user" as const, content: "missed question" }, { role: "assistant" as const, content: "missed answer" }] : []),
      { role: "user", content: "new question" },
    ];
    await finished(runtime, fake, input(messages));
    expect(fake.state.threadStarts).toBe(2);
    expect(fake.state.threadResumes).toHaveLength(failure === "resume-error" ? 1 : 0);
    expect(texts(fake.state.turnStarts[1].input)).toContain("Imported conversation history");
    if (failure === "resume-error") expect(warn).toHaveBeenCalledWith("codex_thread_resume_failed", expect.objectContaining({ message: "rollout missing" }));
    await runtime.close();
  });

  it.each(["cancel-live", "cancel-retired", "request-failure", "tool-cancel", "terminal"] as const)("does not retain a checkpoint after %s", async (failure) => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const turn = await finished(runtime, fake);
    if (failure === "cancel-retired") await runtime.endHostSession(session.bridgeSessionId, "host-ended");
    if (failure.startsWith("cancel")) await runtime.cancel(session.bridgeSessionId, "factory-cancelled");
    else {
      const messages: Message[] = [opening, { role: "assistant", content: turn.response.content }, { role: "user", content: "more" }];
      const pending = runtime.handle(input(messages, failure === "terminal" ? { tools: [{ name: "EndFeatureRun", input_schema: { type: "object" } }] } : {}));
      await tick();
      if (failure === "request-failure") {
        fake.notify("turn/completed", { turn: { status: "failed", error: { message: "bad request" } } });
        await expect(pending).rejects.toMatchObject({ status: 502 });
      } else {
        const answer = fake.call("cancel-tool", failure === "terminal" ? "EndFeatureRun" : "Read");
        const toolTurn = await pending;
        if (failure === "terminal") {
          await runtime.completeHostTool(session.bridgeSessionId, { toolUseId: "cancel-tool", toolName: "EndFeatureRun", input: { file_path: "/cancel-tool" }, content: "done", terminal: true });
          await answer;
        } else {
          const continuation = runtime.handle(input([
            ...messages, { role: "assistant", content: toolTurn.response.content },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "cancel-tool", content: "Tool execution cancelled by user", is_error: true }] },
          ]));
          await answer;
          fake.notify("turn/completed", { turn: { status: "completed" } });
          await continuation;
        }
      }
    }
    expect((await runtime.endHostSession(session.bridgeSessionId, "host-ended")).resumable).toBe(false);
    await finished(runtime, fake, input([opening, { role: "assistant", content: turn.response.content }, { role: "user", content: "again" }]));
    expect(fake.state.threadResumes).toHaveLength(0);
    await runtime.close();
  });
});

describe("CodexRuntime Responses", () => {
  it.each([false, true])("configures Script=%s on start and resume, forwarding summaries without transcript pollution", async (script) => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const opening: Message = { role: "user", content: "go" };
    const extra: Partial<MessagesRequest> = {
      tools: [{ name: script ? "Script" : "Read", input_schema: { type: "object" } }],
      responses: { customTools: [], deferredTools: [], verbosity: "low", reasoningSummary: "auto" },
    };
    const reasoningDelta = vi.fn();
    const first = runtime.handle(input([opening], extra), { textDelta() {}, toolTrace() {}, reasoningDelta });
    await tick();
    expect(fake.state.threadStart.config.features.code_mode).toEqual(script
      ? { enabled: false } : { enabled: true, default_exec_yield_time_ms: CODEX_EXEC_YIELD_MS });
    expect(fake.state.threadStart.developerInstructions).toBe(script ? undefined : CODEX_DEVELOPER_INSTRUCTIONS);
    expect(fake.state.threadStart.config.model_verbosity).toBe("low");
    expect(fake.state.turnStarts[0].summary).toBe("auto");
    fake.notify("item/reasoning/summaryTextDelta", { itemId: "reason-1", delta: "Considering", summaryIndex: 2 });
    fake.notify("item/agentMessage/delta", { itemId: "answer", delta: "done" });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    const turn = await first;
    expect(reasoningDelta).toHaveBeenCalledWith("Considering", "reason-1", 2);
    expect(turn.response.content).toEqual([{ type: "text", text: "done" }]);
    await runtime.endHostSession(session.bridgeSessionId, "host-ended");
    const next = runtime.handle(input([
      opening, { role: "assistant", content: turn.response.content }, { role: "user", content: "continue" },
    ], { ...extra, responses: { ...extra.responses!, verbosity: "high" } }));
    await tick();
    expect(fake.state.threadResumes[0].config).toMatchObject({
      model_verbosity: "high", features: { code_mode: { enabled: !script } },
    });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await next;
    await runtime.close();
  });

  it("deduplicates deferred schemas, preferring Responses definitions and advertised tools", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const schema = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
    const pending = runtime.handle(input([{ role: "user", content: "<system-reminder>\nDeferred tools:\nFetchUrl\nWebSearch\nRead\n</system-reminder>" }], {
      responses: { customTools: [], deferredTools: [
        { name: "FetchUrl", input_schema: schema }, { name: "FetchUrl", input_schema: schema },
        { name: "Read", input_schema: schema },
      ] },
    }));
    await tick();
    const tools = fake.state.threadStart.dynamicTools;
    expect(tools.filter((tool: any) => tool.name === "FetchUrl")).toEqual([
      expect.objectContaining({ inputSchema: schema }),
    ]);
    expect(tools.filter((tool: any) => tool.name === "Read")).toEqual([
      expect.objectContaining({ inputSchema: { type: "object" } }),
    ]);
    expect(tools.every((tool: any) => tool.deferLoading === undefined)).toBe(true);
    expect(await fake.call("not-loaded", "FetchUrl", { url: "https://example.com" })).toMatchObject({
      success: false, contentItems: [{ text: expect.stringContaining("select:FetchUrl") }],
    });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await pending;
    await runtime.close();
  });
});

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
    // A plain result continuation has no new user content to steer.
    expect(fake.state.steers).toEqual([]);
  });

  it("registers Droid's deferred tools up front and makes them callable once ToolSearch loads them", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const reminder = "<system-reminder>\nDeferred tools:\nWebSearch\nFetchUrl\n</system-reminder>";
    const tools = [{ name: "Read", input_schema: { type: "object" } }, { name: "ToolSearch", input_schema: { type: "object" } }];
    const opening: Message = { role: "user", content: `${reminder}\nread the docs` };
    const first = runtime.handle(input([opening], { tools }));
    await tick();
    // codex-cli 0.165.0 rejects thread/start when a top-level dynamic tool has deferLoading.
    expect(fake.state.threadStart.dynamicTools.map((tool: any) => [tool.name, "deferLoading" in tool]))
      .toEqual([["Read", false], ["ToolSearch", false], ["WebSearch", false], ["FetchUrl", false],
        ...["ExitSpecMode", "ProposeMission", "StartMissionRun", "DismissHandoffItems", "EndFeatureRun", "AskUser"].map((name) => [name, false])]);
    // Before Droid loads it, the bridge says how to load it instead of forwarding a call Droid rejects.
    const early = await fake.call("exec-early", "FetchUrl", { url: "https://example.test" });
    expect(early.success).toBe(false);
    expect(texts(early.contentItems)).toContain("select:FetchUrl");
    const search = fake.call("exec-search", "ToolSearch", { query: "select:FetchUrl" });
    const turn = await first;
    expect(toolUses(turn.response.content as any)).toEqual(["exec-search"]);

    const fetchUrl = { name: "FetchUrl", description: "Fetch a URL.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };
    const second = runtime.handle(input([
      opening,
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-search", content: "Loaded 1 tool(s): FetchUrl" }] },
    ], { tools: [...tools, fetchUrl] }));
    const searched = texts((await search).contentItems);
    expect(searched).toContain("Loaded 1 tool(s): FetchUrl");
    // Codex only has the placeholder schema; the real one rides on the ToolSearch result.
    expect(searched).toContain("tools.FetchUrl");
    expect(searched).toContain('"required":["url"]');
    void fake.call("exec-fetch", "FetchUrl", { url: "https://example.test" });
    const next = await second;
    expect(toolUses(next.response.content as any)).toEqual(["exec-fetch"]);
  });

  it("steers user text that arrives with a tool result into the running turn before resolving the result", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "go" }]));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    const second = runtime.handle(input([
      { role: "user", content: "go" },
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-a", content: "file text" }, { type: "text", text: "the model is called claude opus fyi" }] },
    ]));
    expect(texts((await read).contentItems)).toBe("file text");
    expect(fake.state.steers).toEqual([{ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "the model is called claude opus fyi" }] }]);
    expect(fake.state.log.indexOf("turn/steer")).toBeLessThan(fake.state.log.indexOf("resolved:exec-a"));
    expect(fake.state.turnStarts).toHaveLength(1);
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await second).response.stop_reason).toBe("end_turn");
  });

  it("delivers a result that a Mission pause separated from the latest user message", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "go" }]));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    const second = runtime.handle(input([
      { role: "user", content: "go" },
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-a", content: "file text" }] },
      { role: "assistant", content: "[Interrupted]" },
      { role: "user", content: "[resume the mission]" },
    ]));
    expect(texts((await read).contentItems)).toBe("file text");
    expect(texts(fake.state.steers[0].input)).toContain("[resume the mission]");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await second).response.stop_reason).toBe("end_turn");
  });

  it("puts the text on the tool result, labeled, when Codex refuses to steer", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "go" }]));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    fake.state.steerError = new Error("turn/steer: turn is not steerable");
    const second = runtime.handle(input([
      { role: "user", content: "go" },
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-a", content: "file text" }, { type: "text", text: "stop after this file" }] },
    ]));
    expect(texts((await read).contentItems)).toBe("file text\nDroid sent this with the tool result (it is not tool output):\nstop after this file");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await second;
  });

  it("delivers an AskUser answer that arrives after Codex abandoned the call when its turn ended", async () => {
    // 2026-10-31 incident: the exec cell yielded after 30 s while AskUser waited, the
    // model ended its turn, Codex failed the call, and the answer was dropped.
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([{ role: "user", content: "where should we build it?" }], { tools: withAskUser }));
    await tick();
    const ask = fake.call("exec-ask", "AskUser", { questionnaire: "1. [question] Where?" });
    const turn = await first;
    fake.notify("item/agentMessage/delta", { itemId: "m1", delta: "Choose an option above." });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await ask).success).toBe(false);
    // Droid still owes this result; the session must not be evicted meanwhile.
    expect(runtime.protectedSessionIds()).toContain("bridge-codex");

    const answered = runtime.handle(input([
      { role: "user", content: "where should we build it?" },
      { role: "assistant", content: turn.response.content as any },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-ask", content: "[answer] 3.first and why does docs-fetch not working?" }] },
    ], { tools: withAskUser }));
    await tick();
    expect(fake.state.turnStarts).toHaveLength(2);
    const sent = texts(fake.state.turnStarts[1].input);
    expect(sent).toContain("AskUser (call exec-ask) returned after your earlier turn ended");
    expect(sent).toContain("3.first and why does docs-fetch not working?");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await answered).response.stop_reason).toBe("end_turn");
    expect(runtime.protectedSessionIds()).not.toContain("bridge-codex");
  });

  it("forwards a GPT behavioral profile's root effort instead of dropping it", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([{ role: "user", content: "go" }], {
      reasoning_effort: "xhigh", thinking: { type: "enabled", budget_tokens: 24576 },
    }));
    await tick();
    expect(fake.state.turnStarts[0].effort).toBe("xhigh");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await pending;
    await runtime.close();
  });

  it("runs an exact thinking budget at the nearest named Codex effort", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([{ role: "user", content: "go" }], {
      thinking: { type: "enabled", budget_tokens: 12345 },
    }));
    await tick();
    expect(fake.state.turnStarts[0].effort).toBe("medium");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await pending;
    await runtime.close();
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

  it("gives Codex Droid's prompt as its base prompt and drops Codex-harness context", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([{ role: "user", content: "go" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.state.threadStart.baseInstructions).toBe("You are Droid.");
    // Droid's prompt stays the base; the developer layer only covers Codex's exec yield.
    expect(fake.state.threadStart.developerInstructions).toBe(CODEX_DEVELOPER_INSTRUCTIONS);
    expect(fake.state.threadStart.config).toMatchObject({
      include_collaboration_mode_instructions: false, include_apps_instructions: false,
      project_doc_max_bytes: 0, skills: { include_instructions: false },
    });
    void fake.call("exec-a");
    await pending;
  });
});

describe("CodexRuntime parity with the Claude path", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const opening: Message = { role: "user", content: "go" };
  const after = (turn: { response: { content: unknown } }, results: Array<Record<string, unknown>>, extra: Message[] = []): Message[] => [
    opening, { role: "assistant", content: turn.response.content as any }, { role: "user", content: results as any }, ...extra,
  ];

  it("keeps an orphaned call, with its input, in pendingHostCalls", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening], { tools: withAskUser }));
    await tick();
    void fake.call("exec-ask", "AskUser", { questionnaire: "1. [question] Where?" });
    await first;
    fake.notify("turn/completed", { turn: { status: "completed" } });
    // The app's EndFeatureRun release, compaction link and reclaim exemption read this list.
    expect(runtime.pendingHostCalls("bridge-codex")).toEqual([{ toolUseId: "exec-ask", toolName: "AskUser", input: { questionnaire: "1. [question] Where?" } }]);
  });

  it("refuses calls to a tool Droid no longer advertises, without sending them to Droid", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening], { tools: withAskUser }));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    // The next request drops AskUser (for example after spec approval).
    const second = runtime.handle(input(after(turn, [{ type: "tool_result", tool_use_id: "exec-a", content: "ok" }])));
    await read;
    const refused = await fake.call("exec-ask", "AskUser", { questionnaire: "x" });
    expect(refused.success).toBe(false);
    expect(texts(refused.contentItems)).toContain("BRIDGE_HOST_TOOL_NOT_ADVERTISED");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    const next = await second;
    expect(toolUses(next.response.content as any)).toEqual([]);
  });

  it("gives a tool-free request no Codex tools and refuses calls under tool_choice none", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const helper = runtime.handle(input([opening], { tools: [] }));
    await tick();
    expect(fake.state.threadStart.dynamicTools).toEqual([]);
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await helper;

    const other = fakeServer();
    const none = new CodexRuntime(config(), logger, { open: other.open });
    const pending = none.handle(input([opening], { tool_choice: { type: "none" } } as Partial<MessagesRequest>));
    await tick();
    expect(other.state.threadStart.dynamicTools).toEqual([]);
    const refused = await other.call("exec-a");
    expect(texts(refused.contentItems)).toContain("BRIDGE_HOST_TOOL_ACCESS_NONE");
    other.notify("turn/completed", { turn: { status: "completed" } });
    await pending;
  });

  it("makes a Factory mode tool callable once Droid adds it mid-session", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening]));
    await tick();
    expect(fake.state.threadStart.dynamicTools).toContainEqual(expect.objectContaining({ name: "ExitSpecMode" }));
    const early = await fake.call("exec-early", "ExitSpecMode", { plan: "x" });
    expect(texts(early.contentItems)).toContain("not available now");
    const read = fake.call("exec-a");
    const turn = await first;
    const exitSpec = { name: "ExitSpecMode", description: "Leave spec mode.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } };
    const second = runtime.handle(input(after(turn, [{ type: "tool_result", tool_use_id: "exec-a", content: "ok" }]),
      { tools: [{ name: "Read", input_schema: { type: "object" } }, exitSpec] }));
    const note = texts((await read).contentItems);
    expect(note).toContain("Droid loaded ExitSpecMode");
    expect(note).toContain('"required":["plan"]');
    void fake.call("exec-exit", "ExitSpecMode", { plan: "the plan" });
    expect(toolUses((await second).response.content as any)).toEqual(["exec-exit"]);
  });

  it("tells Codex when a tool's input schema changes under the same name", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening]));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    const v2 = { name: "Read", input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 100 } } } };
    const second = runtime.handle(input(after(turn, [{ type: "tool_result", tool_use_id: "exec-a", content: "ok" }]), { tools: [v2] }));
    expect(texts((await read).contentItems)).toContain('Droid changed the input of Read. Use this schema from now on, not the one you were given before:\n{"type":"object","properties":{"limit":{"type":"integer","minimum":100}}}');
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await second;
  });

  it("tells Codex not to retry a tool the user cancelled, and refuses further calls in that turn", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening]));
    await tick();
    const read = fake.call("exec-a");
    const turn = await first;
    const second = runtime.handle(input(after(turn, [{ type: "tool_result", tool_use_id: "exec-a", content: "Error: Tool execution cancelled by user", is_error: true }])));
    const cancelled = await read;
    expect(cancelled.success).toBe(false);
    expect(texts(cancelled.contentItems)).toContain("Do not retry it");
    const retry = await fake.call("exec-b");
    expect(texts(retry.contentItems)).toContain("BRIDGE_USER_CANCELLED");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect(toolUses((await second).response.content as any)).toEqual([]);
    // A new turn may use tools again.
    const third = runtime.handle(input([...after(turn, [{ type: "tool_result", tool_use_id: "exec-a", content: "Error: Tool execution cancelled by user", is_error: true }]),
      { role: "assistant", content: "Cancelled." }, { role: "user", content: "try something else" }]));
    await tick();
    void fake.call("exec-c");
    expect(toolUses((await third).response.content as any)).toEqual(["exec-c"]);
  });

  it("maps a usage limit to a retryable 429 and skips that account for the next auto pick", async () => {
    const auto = "codex:auto:gpt-6.1-sol";
    const cfg = loadConfig({ dataDir: config().dataDir, mode: "sdk", authMode: "subscription", models: codexModels(["gpt-6.1-sol"], ["auto"]) });
    const picks: string[][] = [];
    const fake = fakeServer();
    const runtime = new CodexRuntime(cfg, logger, { open: fake.open, pickAccount: async (exclude) => { picks.push([...exclude]); return "default"; } });
    const failing = runtime.handle({ ...input([opening]), request: { ...input([opening]).request, model: auto } });
    await tick();
    fake.notify("turn/completed", { turn: { status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } });
    await expect(failing).rejects.toMatchObject({ status: 429, code: "rate_limit_error", extra: { retry_from_history: true } });
    const retry = runtime.handle({ ...input([opening]), request: { ...input([opening]).request, model: auto } });
    await tick();
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await retry;
    expect(picks).toEqual([[], ["default"]]);
  });

  it("maps a Codex login failure to 401 with the login command", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const failing = runtime.handle(input([opening]));
    await tick();
    fake.notify("turn/completed", { turn: { status: "failed", error: { message: "401", codexErrorInfo: "unauthorized" } } });
    await expect(failing).rejects.toMatchObject({ status: 401, message: expect.stringContaining("codex login") });
  });

  it("keeps the thread when the bridge interrupts a turn", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const slow = runtime.handle(input([opening]));
    await tick();
    expect(await runtime.interrupt("bridge-codex", "timeout")).toBe(true);
    fake.notify("turn/completed", { turn: { status: "interrupted" } });
    await expect(slow).rejects.toMatchObject({ status: 499 });
    expect(runtime.isSessionUsable("bridge-codex")).toBe(true);
    const next = runtime.handle(input([opening, { role: "assistant", content: "" }, { role: "user", content: "again" }]));
    await tick();
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await next;
    expect(fake.state.threadStarts).toBe(1);
    expect(fake.state.closed).toBe(0);
  });

  it("closes the session after a terminal host completion", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const first = runtime.handle(input([opening], { tools: [{ name: "EndFeatureRun", input_schema: { type: "object" } }] }));
    await tick();
    const end = fake.call("exec-end", "EndFeatureRun", { status: "done" });
    await first;
    expect(await runtime.completeHostTool("bridge-codex", { toolUseId: "exec-end", toolName: "EndFeatureRun", content: "ended", terminal: true } as any)).toBe("accepted");
    expect((await end).success).toBe(true);
    expect(fake.state.closed).toBe(1);
    expect(runtime.isSessionUsable("bridge-codex")).toBe(false);
  });

  it("reports cached tokens apart from input tokens", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([opening]));
    await tick();
    fake.notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 199112, cachedInputTokens: 199040, outputTokens: 73 } } });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await pending).response.usage).toMatchObject({ input_tokens: 72, cache_read_input_tokens: 199040, output_tokens: 73 });
  });

  it("separates two agent messages and never returns empty content", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([opening]));
    await tick();
    fake.notify("item/agentMessage/delta", { itemId: "m1", delta: "First." });
    fake.notify("item/agentMessage/delta", { itemId: "m2", delta: "Second." });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    expect((await pending).response.content).toEqual([{ type: "text", text: "First.\n\nSecond." }]);

    const quiet = fakeServer();
    const silent = new CodexRuntime(config(), logger, { open: quiet.open });
    const empty = silent.handle(input([opening]));
    await tick();
    quiet.notify("turn/completed", { turn: { status: "completed" } });
    expect((await empty).response.content).toEqual([{ type: "text", text: "" }]);
  });

  it("starts Codex without bridge secrets, hooks, memories or the account's MCP servers", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    dirs.push(home);
    writeFileSync(join(home, "config.toml"), '[mcp_servers.fake]\ncommand = "x"\n[mcp_servers.fake.env]\nA = "1"\n[mcp_servers."other-x"]\ncommand = "y"\n');
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("BRIDGE_ADMIN_TOKEN", "admin-secret");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([opening]));
    await tick();
    const env = fake.state.options!.env!;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.BRIDGE_ADMIN_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fake.state.options!.configOverrides).toEqual(expect.arrayContaining(["mcp_servers.fake.enabled=false", "mcp_servers.other-x.enabled=false"]));
    expect(fake.state.threadStart.config.features).toMatchObject({ hooks: false, memories: false, shell_tool: false });
    // Long Droid tools must not make the model poll `wait` every 30 s.
    expect(fake.state.threadStart.config.features.code_mode).toEqual({ enabled: true, default_exec_yield_time_ms: CODEX_EXEC_YIELD_MS });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await pending;
  });

  it("answers a thread/start rejection with a non-retryable 400 instead of a 502", async () => {
    const fake = fakeServer();
    fake.state.startError = new CodexRpcError("thread/start", -32600, "deferred dynamic tool must include a namespace: WebSearch");
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    await expect(runtime.handle(input([{ role: "user", content: "hi" }]))).rejects.toMatchObject({
      status: 400, code: "codex_thread_rejected", message: expect.stringContaining("deferred dynamic tool must include a namespace"),
    });
  });

  it("closes idle tool-free helpers and keeps at most maxIdleSessions others", async () => {
    const fake = fakeServer();
    const cfg = { ...config(), maxIdleSessions: 1 };
    const runtime = new CodexRuntime(cfg, logger, { open: fake.open });
    const run = async (id: string, tools?: MessagesRequest["tools"]) => {
      const request = input([opening], tools ? { tools } : {});
      const pending = runtime.handle({ ...request, session: { ...session, bridgeSessionId: id } });
      await tick();
      fake.notify("turn/completed", { turn: { status: "completed" } });
      await pending;
      await tick();
    };
    await run("helper", []);
    expect(runtime.isSessionUsable("helper")).toBe(false);
    await run("chat-a");
    expect(runtime.isSessionUsable("chat-a")).toBe(true);
    await run("chat-b");
    expect(runtime.isSessionUsable("chat-a")).toBe(false);
    expect(runtime.isSessionUsable("chat-b")).toBe(true);
  });

  it("starts a new thread with the history when the user switches to another named account", async () => {
    const accounts = mkdtempSync(join(tmpdir(), "codex-accounts-"));
    dirs.push(accounts);
    mkdirSync(join(accounts, "work"));
    vi.stubEnv("BRIDGE_CODEX_ACCOUNTS_DIR", accounts);
    const cfg = loadConfig({ dataDir: config().dataDir, mode: "sdk", authMode: "subscription", models: codexModels(["gpt-6.1-sol"], ["default", "work"]) });
    const fake = fakeServer();
    const runtime = new CodexRuntime(cfg, logger, { open: fake.open });
    const first = runtime.handle(input([opening]));
    await tick();
    fake.notify("item/agentMessage/delta", { itemId: "m1", delta: "hello" });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    const turn = await first;
    const switched = input([opening, { role: "assistant", content: turn.response.content as any }, { role: "user", content: "continue on work" }]);
    const second = runtime.handle({ ...switched, request: { ...switched.request, model: "codex:work:gpt-6.1-sol" } });
    await tick();
    expect(fake.state.threadStarts).toBe(2);
    expect(fake.state.options!.codexHome).toBe(join(accounts, "work"));
    expect(texts(fake.state.turnStarts[1].input)).toContain("hello");
    fake.notify("turn/completed", { turn: { status: "completed" } });
    await second;
  });
});

describe("droidCodexCatalog", () => {
  it("removes multi-agent, apply_patch and web search from every model, keeping code mode", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const out = mkdtempSync(join(tmpdir(), "codex-out-"));
    dirs.push(home, out);
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ etag: "x", models: [{
      slug: "gpt-6.1-sol", tool_mode: "code_mode_only", multi_agent_version: "v2", multi_agent_reasoning_effort: "xhigh",
      apply_patch_tool_type: "freeform", web_search_tool_type: "text_and_image", supports_search_tool: true,
      node_repl_disabled: false, experimental_supported_tools: ["clock"], context_window: 500000,
    }] }));
    const path = droidCodexCatalog(home, out, "default")!;
    const [model] = JSON.parse(readFileSync(path, "utf8")).models;
    expect(model).toEqual({
      slug: "gpt-6.1-sol", tool_mode: "code_mode_only", supports_search_tool: false, node_repl_disabled: true,
      experimental_supported_tools: [], context_window: 500000,
    });
    const direct = droidCodexCatalog(home, out, "default", true)!;
    expect(direct).toBe(join(out, "codex-catalog-default-direct.json"));
    expect(JSON.parse(readFileSync(direct, "utf8")).models).toEqual([{ ...model, tool_mode: "direct" }]);
    expect(JSON.parse(readFileSync(path, "utf8")).models).toEqual([model]);
  });

  it("keeps Codex's own catalog when there is no cache to copy", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    dirs.push(home);
    expect(droidCodexCatalog(home, home, "default")).toBeUndefined();
  });

  it("alerts when Codex runs without the Droid catalog", async () => {
    const fake = fakeServer();
    const alerts: string[] = [];
    const runtime = new CodexRuntime(config(), logger, { open: fake.open, alerts: { alert: (key) => { alerts.push(key); } } });
    const pending = runtime.handle(input([{ role: "user", content: "go" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    void fake.call("exec-a");
    await pending;
    // The real ~/.codex catalog exists on this machine, so no fallback here; the
    // configOverrides tell which path ran.
    const used = (fake.state.options?.configOverrides ?? []).some((item) => item.startsWith("model_catalog_json="));
    expect(alerts).toEqual(used ? [] : ["codex-catalog-default"]);
  });
});

describe("CodexRuntime context fidelity", () => {
  const opening: Message = { role: "user", content: "original question" };
  async function answered(runtime: CodexRuntime, fake: ReturnType<typeof fakeServer>, request: RuntimeRequest, extra: () => void = () => undefined) {
    const pending = runtime.handle(request);
    await tick();
    extra();
    fake.notify("item/agentMessage/delta", { itemId: `answer-${fake.state.turnStarts.length}`, delta: "original answer" });
    fake.notify("turn/completed", { turn: { status: "completed" } });
    return pending;
  }

  it("raises Codex's auto-compaction limit beyond any window unless the upstream owns compaction", async () => {
    const fake = fakeServer();
    await answered(new CodexRuntime(config(), logger, { open: fake.open }), fake, input([opening]));
    expect(fake.state.threadStart.config.model_auto_compact_token_limit).toBe(CODEX_AUTO_COMPACT_OFF);
    const upstream = fakeServer();
    await answered(new CodexRuntime({ ...config(), upstreamCompaction: "upstream" }, logger, { open: upstream.open }), upstream, input([opening]));
    expect(upstream.state.threadStart.config).not.toHaveProperty("model_auto_compact_token_limit");
  });

  it("rebuilds the thread from Droid's history after Codex compacted on its own", async () => {
    const fake = fakeServer();
    const warn = vi.fn();
    const runtime = new CodexRuntime(config(), { ...logger, warn }, { open: fake.open });
    const first = await answered(runtime, fake, input([opening]), () => fake.notify("thread/compacted", { threadId: "thread-1", turnId: "turn-1" }));
    expect(first.continuity).toEqual({ kind: "new" });
    expect(warn).toHaveBeenCalledWith("codex_upstream_compacted", { threadId: "thread-1" });
    const second = await answered(runtime, fake, input([opening, { role: "assistant", content: first.response.content }, { role: "user", content: "next" }]));
    expect(fake.state.threadStarts).toBe(2);
    expect(fake.state.threadResumes).toEqual([]);
    expect(texts(fake.state.turnStarts[1].input)).toContain("original question");
    expect(second.continuity).toEqual({ kind: "reseeded", reason: "codex-compaction", importedMessages: 2 });
    expect(second.sdkSessionId).toBe("thread-2");
  });

  it("maps contextWindowExceeded to Droid's context_length_exceeded", async () => {
    const fake = fakeServer();
    const runtime = new CodexRuntime(config(), logger, { open: fake.open });
    const pending = runtime.handle(input([opening]));
    await tick();
    fake.notify("turn/completed", { turn: { status: "failed", error: { message: "Your input exceeds the context window of this model.", codexErrorInfo: "contextWindowExceeded" } } });
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 400, code: "context_length_exceeded", extra: { type: "invalid_request_error" } });
    expect((failure as Error).message).toMatch(/^prompt is too long/);
    expect(runtime.isSessionUsable(session.bridgeSessionId)).toBe(false);
  });

  it("reports each reply's last call once, with reasoning tokens, and never zero after usage was seen", async () => {
    const fake = fakeServer();
    const info = vi.fn();
    const runtime = new CodexRuntime(config(), { ...logger, info }, { open: fake.open });
    const first = await answered(runtime, fake, input([opening]), () => fake.notify("thread/tokenUsage/updated", {
      tokenUsage: { last: { inputTokens: 50_000, cachedInputTokens: 48_000, outputTokens: 900, reasoningOutputTokens: 600 }, modelContextWindow: 922_000 },
    }));
    expect(first.response.usage).toMatchObject({ input_tokens: 2_000, cache_read_input_tokens: 48_000, output_tokens: 900, reasoning_output_tokens: 600, estimated: false });
    expect(info).toHaveBeenCalledWith("codex_context_window", expect.objectContaining({ modelContextWindow: 922_000 }));
    const second = await answered(runtime, fake, input([opening, { role: "assistant", content: first.response.content }, { role: "user", content: "next" }]));
    expect(second.response.usage).toMatchObject({ input_tokens: 2_000, cache_read_input_tokens: 48_000, output_tokens: 900, estimated: true });
    expect(responsesUsage(first.response.usage)).toMatchObject({ input_tokens: 50_000, output_tokens_details: { reasoning_tokens: 600 } });
  });

  it("resumes an idle thread after a bridge restart from its saved record", async () => {
    const shared = config();
    const fake = fakeServer();
    const before = new CodexRuntime(shared, logger, { open: fake.open });
    const first = await answered(before, fake, input([opening]));
    await before.close();
    const saved = JSON.parse(readFileSync(join(shared.dataDir, "codex-resumes.json"), "utf8"));
    expect(saved.records[session.bridgeSessionId]).toMatchObject({ threadId: "thread-1", account: "default", model: "gpt-6.1-sol" });
    // Content-free: hashes and tool names only.
    expect(JSON.stringify(saved)).not.toContain("original");

    const restarted = fakeServer();
    const after = new CodexRuntime(shared, logger, { open: restarted.open });
    const next = await answered(after, restarted, input([opening, { role: "assistant", content: first.response.content }, { role: "user", content: "new question" }]));
    expect(restarted.state.threadResumes).toEqual([expect.objectContaining({ threadId: "thread-1" })]);
    expect(restarted.state.threadStarts).toBe(0);
    expect(next.continuity).toMatchObject({ kind: "resumed" });
    expect(texts(restarted.state.turnStarts[0].input)).not.toContain("original question");
  });
});
