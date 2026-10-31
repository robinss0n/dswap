import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { codexModels } from "../src/models.js";
import { CodexRuntime } from "../src/runtime/codex/runtime.js";
import type { RuntimeRequest } from "../src/runtime/types.js";

/**
 * Offline end-to-end check of the Codex runtime with the real `codex` binary.
 * A local fake Responses API plays the model: turn one calls Droid's `Read`
 * tool, turn two answers with the tool output. Nothing reaches OpenAI.
 *   npx tsx scripts/verify-codex.ts
 */

const seen: Array<{ tools: string[]; developer: string[]; toolOutput?: string }> = [];
const sse = (events: Array<Record<string, unknown>>) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const request = JSON.parse(body) as { input?: Array<Record<string, any>>; tools?: Array<{ name?: string; type?: string }> };
    const output = request.input?.find((item) => item.type === "function_call_output");
    seen.push({ tools: (request.tools ?? []).map((tool) => tool.name ?? tool.type ?? "?"),
      developer: (request.input ?? []).filter((item) => item.role === "developer").map((item) => JSON.stringify(item.content).slice(0, 80)),
      ...(output ? { toolOutput: JSON.stringify(output.output) } : {}) });
    const item = output
      ? { type: "message", role: "assistant", id: "msg_2", content: [{ type: "output_text", text: `The file says: ${JSON.stringify(output.output)}` }] }
      : { type: "function_call", id: "fc_1", call_id: "call_read_1", name: "Read", arguments: JSON.stringify({ file_path: "/tmp/demo.txt" }) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([
      { type: "response.created", response: { id: `resp_${seen.length}` } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id: `resp_${seen.length}`, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]));
  });
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const port = (model.address() as { port: number }).port;

const home = mkdtempSync(join(tmpdir(), "verify-codex-home-"));
writeFileSync(join(home, "config.toml"), `model_provider = "fake"\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "FAKE_CODEX_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
process.env.CODEX_HOME = home;
process.env.FAKE_CODEX_KEY = "offline";
process.env.BRIDGE_CODEX_ACCOUNTS_DIR = join(home, "none");

const project = mkdtempSync(join(tmpdir(), "verify-codex-project-"));
const config = loadConfig({ mode: "sdk", authMode: "subscription", dataDir: mkdtempSync(join(tmpdir(), "verify-codex-data-")), sdkCwd: project,
  models: codexModels(["gpt-fake"], ["default"]) });
const runtime = new CodexRuntime(config, { info: () => {}, warn: () => {}, error: () => {} } as any);
const session = { bridgeSessionId: "verify", role: "chat", state: "NEW", model: "codex:default:gpt-fake", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } as any;
const tools = [{ name: "Read", description: "Droid Read", input_schema: { type: "object" as const, properties: { file_path: { type: "string" } }, required: ["file_path"] } }];
const base: RuntimeRequest = { request: { model: "codex:default:gpt-fake", max_tokens: 1000, system: "You are Droid. DROID-PROMPT-MARKER", tools, messages: [{ role: "user", content: "What is in /tmp/demo.txt?" }] }, session, role: "chat", headers: {} };

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  const first = await runtime.handle(base);
  const call = first.response.content.find((block) => block.type === "tool_use") as { id: string; name: string; input: unknown } | undefined;
  check(first.response.stop_reason === "tool_use" && call?.name === "Read", "turn 1 returns Droid's Read call to Droid");
  check(JSON.stringify(call?.input) === JSON.stringify({ file_path: "/tmp/demo.txt" }), "tool arguments arrive intact");
  check(seen[0]?.tools.join(",") === "request_user_input,Read" || seen[0]?.tools.join(",") === "Read", `Codex offers only Droid's tools (saw ${seen[0]?.tools.join(",")})`);
  check(seen[0]?.developer.some((text) => text.includes("DROID-PROMPT-MARKER")) ?? false, "Droid's prompt reaches the model as developer instructions");
  const second = await runtime.handle({ ...base, request: { ...base.request, messages: [
    ...base.request.messages, { role: "assistant", content: first.response.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: call!.id, content: "hello from droid" }] },
  ] } });
  const text = second.response.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
  check(seen[1]?.toolOutput?.includes("hello from droid") ?? false, "Droid's tool result goes back to Codex");
  check(second.response.stop_reason === "end_turn" && text.includes("hello from droid"), "turn 2 ends with Codex's answer");
} catch (error) {
  check(false, `run threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await runtime.close();
  model.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exitCode = failures.length ? 1 : 0;
