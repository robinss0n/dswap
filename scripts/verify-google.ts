import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { googleModels } from "../src/models.js";
import { AntigravityRuntime } from "../src/runtime/antigravity/runtime.js";
import type { RuntimeRequest } from "../src/runtime/types.js";

/**
 * Live check of the Google runtime with Google's Antigravity agent and a real,
 * signed-in Google account. Uses a little of that account's quota.
 *   GOOGLE_ACCOUNT=alt GOOGLE_MODEL=gemini-3.8-flash-low npx tsx scripts/verify-google.ts
 * Turn one must call Droid's Read tool (served over MCP); turn two must answer with the file's word.
 * SLOW=1 sends the tool result after the agent stopped waiting for it, so it must arrive as a new prompt.
 */

const account = process.env.GOOGLE_ACCOUNT ?? "alt";
const model = process.env.GOOGLE_MODEL ?? "gemini-3.8-flash-low";
const id = `google:${account}:${model}`;
const project = mkdtempSync(join(tmpdir(), "verify-google-project-"));
const config = loadConfig({ mode: "sdk", authMode: "subscription", dataDir: mkdtempSync(join(tmpdir(), "verify-google-data-")), sdkCwd: project, models: googleModels([model], [account]) });
const slow = process.env.SLOW === "1";
const runtime = new AntigravityRuntime(config, { info: (...args: unknown[]) => console.log("  log:", ...args.map((arg) => JSON.stringify(arg))), warn: () => {}, error: () => {} } as any,
  slow ? { toolDeferMs: 5_000 } : {});
const session = { bridgeSessionId: "verify-google", role: "chat", state: "NEW", model: id, toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } as any;
const tools = [{ name: "Read", description: "Read a file from the local filesystem.", input_schema: { type: "object" as const, properties: { file_path: { type: "string", description: "Absolute path" } }, required: ["file_path"] } }];
const ask = "Use the Read tool to read /tmp/verify-google.txt, then reply with only the secret word written in it.";
const base: RuntimeRequest = { request: { model: id, max_tokens: 2000, system: "You are Droid, a coding agent. Use the provided tools.", tools, messages: [{ role: "user", content: ask }] }, session, role: "chat", headers: {} };

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const started = Date.now();
try {
  const first = await runtime.handle(base, { textDelta: () => {}, toolTrace: (name) => console.log(`  tool: ${name}`) });
  const call = first.response.content.find((block) => block.type === "tool_use") as { id: string; name: string; input: any } | undefined;
  check(first.response.stop_reason === "tool_use" && call?.name === "Read", `turn 1 asks Droid to run Read (got ${first.response.stop_reason}, ${call?.name ?? "no tool"})`);
  check(call?.input?.file_path === "/tmp/verify-google.txt", `Read targets the asked file (${JSON.stringify(call?.input)})`);
  if (call) {
    if (slow) { console.log("  holding the tool result for 9s (the agent stops waiting after 5s)…"); await new Promise((resolve) => setTimeout(resolve, 9_000)); }
    const second = await runtime.handle({ ...base, request: { ...base.request, messages: [
      { role: "user", content: ask },
      { role: "assistant", content: first.response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "The secret word is: tangerine" }] },
    ] } });
    const text = second.response.content.filter((block) => block.type === "text").map((block: any) => block.text).join("");
    check(second.response.stop_reason === "end_turn", `turn 2 ends the turn (got ${second.response.stop_reason}${second.response.stop_reason === "tool_use" ? `: ${JSON.stringify(second.response.content.filter((block) => block.type === "tool_use"))}` : ""})`);
    check(/tangerine/i.test(text), `turn 2 answers from the tool result (${JSON.stringify(text.slice(0, 120))})`);
    check(second.response.usage.estimated === false && second.response.usage.input_tokens > 0, `usage is reported (${JSON.stringify(second.response.usage)})`);
  }
} catch (error) {
  check(false, `no error (${error instanceof Error ? error.message : error})`);
} finally {
  await runtime.close();
}
console.log(`${failures.length ? "FAILED" : "OK"} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(failures.length ? 1 : 0);
