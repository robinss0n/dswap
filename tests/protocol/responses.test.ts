import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeApp } from "../../src/http/app.js";
import { startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function post(app: BridgeApp, token: string, body: unknown, path = "/v1/responses") {
  return fetch(`${app.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("Responses protocol", () => {
  it("accepts a desktop environment reminder sent after a separate Droid error message", async () => {
    const { app, token } = await startTestBridge({ desktopProfile: true, remoteWorkspace: true, promptMode: "droid" });
    apps.push(app);
    const response = await post(app, token, {
      model: "relay-probe",
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      input: [
        { role: "user", content: "Error: model configuration failed" },
        { role: "user", content: [{ type: "input_text", text: "<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n/projects/example\n\n</system-reminder>" }] },
        { role: "user", content: "RELAY_TEXT_PROBE" },
      ],
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("dswap mock: text probe ok");
  });

  it("returns JSON and SSE on both endpoint spellings and logs the actual path", async () => {
    const { app, token, config } = await startTestBridge();
    apps.push(app);
    const response = await post(app, token, { model: "relay-probe", input: "RELAY_TEXT_PROBE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "response", status: "completed", model: "relay-probe",
      output: [{ type: "message", id: expect.any(String), content: [{ type: "output_text", text: "dswap mock: text probe ok" }] }],
      usage: { total_tokens: expect.any(Number) },
    });
    const stream = await post(app, token, { model: "relay-probe", input: "another text probe", stream: true }, "/v1/responses/?test=1");
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const raw = await stream.text();
    for (const event of ["response.created", "response.in_progress", "response.output_item.added", "response.output_text.delta", "response.output_text.done", "response.completed"]) {
      expect(raw).toContain(`event: ${event}\n`);
    }
    expect(raw).toContain("dswap mock: text probe ok");
    expect(raw).not.toContain("event: message_start");
    const logged = readFileSync(join(config.logDir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(logged.map((entry) => entry.path)).toEqual(["/v1/responses", "/v1/responses/"]);
  });

  it("correlates a streamed function call replay and result without a session header", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const tools = [{ type: "function", name: "Read", parameters: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"],
    } }];
    const input = [{ role: "user", content: "RELAY_TOOL_PROBE RELAY_CANARY_ABC CANARY_PATH=/tmp/canary.txt" }];
    const first = await post(app, token, { model: "relay-probe", input, tools, stream: true,
      prompt_cache_key: "shared-client-session", safety_identifier: "shared-client-session" });
    expect(first.status).toBe(200);
    const events = (await first.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const call = events.find((event) => event.type === "response.output_item.done").item;
    expect(call).toMatchObject({ type: "function_call", name: "Read", call_id: expect.stringMatching(/^call_bx_/), arguments: JSON.stringify({ path: "/tmp/canary.txt" }) });
    expect(app.store.list()).toHaveLength(1);
    expect(app.store.list()[0]?.droidSessionId).toBeUndefined();
    const second = await post(app, token, { model: "relay-probe", tools,
      input: [...input, call, { type: "function_call_output", call_id: call.call_id, output: "RELAY_CANARY_ABC" }],
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-bridge-session")).toBe(first.headers.get("x-bridge-session"));
    expect(JSON.stringify(await second.json())).toContain("canary=RELAY_CANARY_ABC");
    expect(app.store.list()).toHaveLength(1);
    expect(app.store.list()[0]?.state).toBe("IDLE");
  });

  it("uses OpenAI errors for authentication, malformed JSON, and unsupported stateful requests", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const unauthorized = await post(app, "wrong", {});
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { type: "invalid_request_error", code: expect.any(String), param: null } });
    const malformed = await fetch(`${app.url}/v1/responses/`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { type: "invalid_request_error", param: null } });
    const unsupported = await post(app, token, { model: "relay-probe", input: "hi", previous_response_id: "resp_previous" });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ error: { type: "invalid_request_error", message: expect.stringContaining("previous_response_id") } });
    expect(app.store.list()).toHaveLength(0);
  });

  it.each([false, true])("uses OpenAI errors for mock runtime rejection (stream=%s)", async (stream) => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const response = await post(app, token, { model: "relay-probe", input: "RELAY_TOOL_PROBE", stream });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "no_safe_tool", param: null } });
  });
});
