import { afterEach, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { codexModels } from "../../src/models.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { CodexRuntime } from "../../src/runtime/codex/runtime.js";
import type { AppServerOptions, CodexAppServer } from "../../src/runtime/codex/app-server.js";

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const model = "codex:default:gpt-6.1-sol";
const logger = { info() {}, warn() {}, error() {} };
async function setup(gateAt?: string, timeout = false, mixed = false) {
  let entered!: () => void, release!: () => void;
  const enteredGate = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "fresh-http-")), port: 0, clientToken: "client", adminToken: "admin", requestTimeoutMs: timeout ? 500 : 10000, persistSessions: false, models: codexModels(["gpt-6.1-sol"], ["default"]) });
  let opens = 0, retired = 0;
  const runtime = new CodexRuntime(config, logger, { open(options: AppServerOptions) {
    const generation = ++opens;
    return {
      exited: new Promise<void>(() => {}), initialize: async () => { if (generation > 1 && gateAt === "startup") { entered(); await gate; } if (generation > 1 && gateAt === "failure") throw new Error("start failed"); return {}; }, close() {},
      async closeAndWait() { retired++; if (gateAt === "retirement") { entered(); await gate; } },
      async request(method: string) {
        if (method === "thread/start") return { thread: { id: `thread-${generation}` } };
        if (method === "turn/start") {
          setTimeout(() => {
            options.onNotification!("item/agentMessage/delta", { itemId: "text", delta: generation === 1 ? "Question" : "Feedback" });
            if (generation === 1) void options.onRequest!("item/tool/call", { callId: "q1", tool: "AskUser", arguments: { question: "Recall?" } }).catch(() => {});
            if (generation === 1 && mixed) void options.onRequest!("item/tool/call", { callId: "q2", tool: "AskUser", arguments: { question: "Sibling?" } }).catch(() => {});
            if (generation !== 1) options.onNotification!("turn/completed", { turn: { status: "completed" } });
          }, 5);
          return { turn: { id: `turn-${generation}` } };
        }
        return {};
      },
    } as unknown as CodexAppServer;
  } });
  const app = createBridgeApp(config, logger, "", runtime);
  apps.push(app); await listen(app, config);
  const post = (input: unknown[], headers = {}, signal?: AbortSignal) => fetch(`${app.url}/v1/responses`, { method: "POST", signal, headers: { authorization: "Bearer client", "content-type": "application/json", ...headers }, body: JSON.stringify({ model, stream: true, input, tools: [{ type: "function", name: "AskUser", parameters: { type: "object" } }] }) });
  return { app, post, enteredGate, release, counts: () => ({ opens, retired }) };
}
it.each(["correct", "wrong", "free recall", "mixed", "wire-prefixed"])("Responses SSE boundary imports %s and replays without rollback", async answer => {
  const { app, post, counts } = await setup(undefined, false, answer === "mixed");
  const first = await post([{ role: "user", content: "quiz" }]);
  const id = first.headers.get("x-bridge-session")!;
  expect(await first.text()).toContain("response.completed");
  const callId = answer === "wire-prefixed" ? "call_bx_q1" : "q1";
  const history: any[] = [{ role: "user", content: "quiz" }, { role: "assistant", content: [{ type: "output_text", text: "Question" }] },
    { type: "function_call", call_id: callId, name: "AskUser", arguments: JSON.stringify({ question: "Recall?" }) },
    { type: "function_call_output", call_id: callId, output: answer }];
  if (answer === "mixed") {
    history.splice(3, 0, { type: "function_call", call_id: "q2", name: "AskUser", arguments: '{"question":"Sibling?"}' });
    history.push({ type: "function_call_output", call_id: "q2", output: "sibling answer" });
  }
  const headers = { "x-bridge-session": id, "x-bridge-fresh-tool-turn": JSON.stringify({ v: 1, boundary_id: "b1", answered_call_ids: [callId] }) };
  if (answer === "wire-prefixed") {
    const collision = await post(history, { ...headers, "x-bridge-fresh-tool-turn": JSON.stringify({ v: 1, boundary_id: "collision", answered_call_ids: ["q1", callId] }) });
    expect(collision.status).toBe(409); await collision.text();
    expect(counts()).toEqual({ opens: 1, retired: 0 });
  }
  for (const invalid of [history.slice(1), [{ role: "user", content: "mutation" }, ...history.slice(1)]]) {
    const rejected = await post(invalid, headers); expect(rejected.status).toBe(409); await rejected.text();
    expect(counts()).toEqual({ opens: 1, retired: 0 });
  }
  const next = await post(history, headers);
  const text = await next.text();
  expect(text).toContain("Feedback"); expect(text).toContain("response.completed");
  expect(counts()).toEqual({ opens: 2, retired: 1 });
  const snapshot = structuredClone(app.store.get(id));
  const retry = await post(history, headers);
  expect(await retry.text()).toContain("Feedback");
  expect(counts()).toEqual({ opens: 2, retired: 1 });
  expect(app.store.get(id)?.historyMessageHashes).toEqual(snapshot?.historyMessageHashes);
  const later = await post([...history, { role: "assistant", content: "Feedback" }, { role: "user", content: "next" }], { "x-bridge-session": id });
  await later.text();
  const newer = structuredClone(app.store.get(id));
  const stale = await post(history, headers);
  expect(stale.status).toBe(409); await stale.text();
  expect(app.store.get(id)?.historyMessageHashes).toEqual(newer?.historyMessageHashes);
  expect(app.store.get(id)?.pendingToolIds).toEqual(newer?.pendingToolIds);
});

for (const stage of ["retirement", "startup"]) {
  it.each(["disconnect", "admin", "timeout"])(`fences %s during ${stage}`, async mode => {
    const { app, post, enteredGate, release, counts } = await setup(stage, mode === "timeout");
    const first = await post([{ role: "user", content: "quiz" }]);
    const id = first.headers.get("x-bridge-session")!; await first.text();
    const history = [{ role: "user", content: "quiz" }, { role: "assistant", content: "Question" },
      { type: "function_call", call_id: "q1", name: "AskUser", arguments: '{"question":"Recall?"}' },
      { type: "function_call_output", call_id: "q1", output: "correct" }];
    const headers = { "x-bridge-session": id, "x-bridge-fresh-tool-turn": JSON.stringify({ v: 1, boundary_id: "b1", answered_call_ids: ["q1"] }) };
    const controller = new AbortController();
    const pending = post(history, headers, controller.signal).then(async r => { await r.text(); }, () => {});
    await enteredGate;
    if (mode === "disconnect") { controller.abort(); await new Promise(r => setTimeout(r, 30)); }
    if (mode === "admin") {
      const response = await fetch(`${app.url}/internal/cancel`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }) });
      expect(response.status).toBe(200); await response.text();
    }
    if (mode === "timeout") await new Promise(r => setTimeout(r, 600));
    release(); await pending; await new Promise(r => setTimeout(r, 30));
    expect(counts().opens).toBe(stage === "retirement" ? 1 : 2);
    expect(["FAILED", "CANCELLED"]).toContain(app.store.get(id)?.state);
    expect(app.store.get(id)?.pendingToolIds).toEqual([]);
    expect(app.store.get(id)?.sdkSessionId).toBeUndefined();
  });
}

it("clears old native identity and pending calls after startup failure", async () => {
  const { app, post } = await setup("failure");
  const first = await post([{ role: "user", content: "quiz" }]);
  const id = first.headers.get("x-bridge-session")!; await first.text();
  const failed = await post([{ role: "user", content: "quiz" }, { role: "assistant", content: "Question" },
    { type: "function_call", call_id: "q1", name: "AskUser", arguments: '{"question":"Recall?"}' },
    { type: "function_call_output", call_id: "q1", output: "answer" }],
    { "x-bridge-session": id, "x-bridge-fresh-tool-turn": JSON.stringify({ v: 1, boundary_id: "b1", answered_call_ids: ["q1"] }) });
  await failed.text();
  expect(app.store.get(id)).toMatchObject({ state: "FAILED", pendingToolIds: [] });
  expect(app.store.get(id)?.sdkSessionId).toBeUndefined();
});
