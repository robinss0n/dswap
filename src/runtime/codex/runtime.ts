import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../../config.js";
import type { Logger } from "../../logging.js";
import { assistantMessage } from "../../protocol/messages.js";
import { canonicalToolUseId, collectToolResults, systemText, textFromBlocks } from "../../protocol/content.js";
import { codexFromModelId } from "../../models.js";
import { historyMessageHashes } from "../../sessions/correlate.js";
import { BridgeError, type ContentBlock, type Json, type Usage } from "../../types.js";
import { resolveRequestCwd } from "../../workspace.js";
import { AUTO_ACCOUNT } from "../../upstream/cswap.js";
import { codexAccountHome, listCodexAccounts, pickCodexAccount, probeCodexAccount } from "../../upstream/codex-accounts.js";
import { droidReasoningLevel } from "../reasoning.js";
import { buildDynamicUserContent, buildInitialUserContent } from "../system-prompt.js";
import type { BridgeRuntime, RetiredSession, RuntimeControl, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "../types.js";
import { CodexAppServer, type AppServerOptions } from "./app-server.js";
import type { FallbackAlerts } from "../../notify.js";

/**
 * Codex through `codex app-server`. Droid's system prompt becomes Codex's
 * developer instructions, Droid's tools become Codex dynamic tools, and Codex's
 * own shell, web, image and agent tools are switched off, so Droid runs (and
 * approves) every action. Each account is its own CODEX_HOME; `auto` picks the
 * account with the most headroom when a session starts.
 */

/** Codex features that add built-in tools. Off, the model sees only Droid's tools. */
export const CODEX_BUILTIN_FEATURES_OFF = {
  shell_tool: false, unified_exec: false, goals: false, multi_agent: false, view_image: false, image_generation: false,
  apps: false, plugins: false, computer_use: false, browser_use: false, tool_suggest: false, skill_search: false, sleep_tool: false,
};

interface PendingTool { resolve: (result: { contentItems: Json[]; success: boolean }) => void; reject: (error: unknown) => void; name: string; input: Json }
interface TurnOutcome { status: string; error?: { message?: string; codexErrorInfo?: unknown } }

interface LiveCodex {
  server?: CodexAppServer;
  threadId?: string;
  account?: string;
  turnId?: string;
  turnDone?: Promise<TurnOutcome>;
  finishTurn?: (outcome: TurnOutcome) => void;
  pending: Map<string, PendingTool>;
  blocks: ContentBlock[];
  usage?: Usage;
  busy: boolean;
  sent: boolean;
  sink?: StreamSink;
  releasePark?: () => void;
  lastRequestHash?: string;
  lastTurn?: RuntimeTurn;
  ended?: BridgeError;
  lastTouched: number;
  lastError?: string;
  /** Agent messages that streamed deltas; a completed message without any is added whole. */
  streamed: Set<string>;
}

/**
 * Codex's model catalog adds tools no feature flag removes: multi_agent_version
 * brings spawn_agent & co plus a 2.4k-char "you are /root of a team" prompt,
 * apply_patch_tool_type an apply_patch that would bypass Droid's Edit, and the
 * search fields a web search tool. The bridge hands app-server a copy of the
 * account's catalog without them (absent = off; null fails to parse).
 * tool_mode stays code_mode_only: Droid's tools are then called from Codex's
 * `exec` cell, which runs them in parallel. "direct" made each call its own
 * model round trip (3 reads: ~2 s apart instead of within 2 ms, codex-cli 0.165.0).
 * Returns the copy's path, or undefined to keep Codex's own catalog.
 */
export function droidCodexCatalog(codexHome: string, outDir: string, account: string): string | undefined {
  let catalog: { models?: Array<Record<string, unknown>> };
  try { catalog = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")); } catch { return undefined; }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) return undefined;
  const models = catalog.models.map((model) => {
    const copy: Record<string, unknown> = { ...model, supports_search_tool: false, node_repl_disabled: true, experimental_supported_tools: [] };
    // Absent means off: multi-agent "disabled", no apply_patch or web search tool.
    for (const key of ["multi_agent_version", "multi_agent_reasoning_effort", "apply_patch_tool_type", "web_search_tool_type"]) delete copy[key];
    return copy;
  });
  const path = join(outDir, `codex-catalog-${account}.json`);
  writeFileSync(path, JSON.stringify({ models }), { mode: 0o600 });
  return path;
}

export interface CodexRuntimeDependencies {
  /** Injected for tests: open an app-server for one CODEX_HOME. */
  open?: (options: AppServerOptions) => CodexAppServer;
  /** Injected for tests: choose a concrete account for `auto`. */
  pickAccount?: (exclude: ReadonlySet<string>) => Promise<string>;
  now?: () => number;
  /** Desktop alert when a session runs without Droid parity (see FallbackAlerts). */
  alerts?: Pick<FallbackAlerts, "alert">;
}

// Droid level -> Codex effort. Every model in Codex's catalog (models_cache.json,
// 2026-10-31) accepts low, medium, high, xhigh and max. None accepts "minimal"
// (gpt-6.1-sol fails the turn with it), so Droid's "off" maps to the lowest, low.
const EFFORT: Record<string, string> = { off: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/**
 * Codex runs a model's parallel function calls at once, so their item/tool/call
 * requests arrive a few milliseconds apart. Answer Droid only once they stop
 * arriving, so one assistant message carries all of them.
 */
const TOOL_GATHER_MS = 120;
const TOOL_GATHER_MAX_MS = 1500;

export class CodexRuntime implements BridgeRuntime {
  readonly kind = "codex" as const;
  private readonly lives = new Map<string, LiveCodex>();
  private readonly now: () => number;
  private closing = false;

  constructor(private readonly config: BridgeConfig, private readonly logger: Logger, private readonly deps: CodexRuntimeDependencies = {}) {
    this.now = deps.now ?? Date.now;
  }

  setControl(_control: RuntimeControl | undefined): void {
    // Codex built-in tools are off; Droid owns every approval.
  }

  describe(): Record<string, unknown> {
    return { kind: "codex", sessions: this.lives.size, pendingHostCalls: [...this.lives.values()].reduce((sum, live) => sum + live.pending.size, 0) };
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    return live ? [...live.pending.entries()].map(([toolUseId, call]) => ({ toolUseId, toolName: call.name, input: call.input })) : [];
  }

  protectedSessionIds(): string[] {
    return [...this.lives.entries()].filter(([, live]) => !live.ended && (live.busy || live.pending.size || live.turnId)).map(([id]) => id);
  }

  isSessionUsable(sessionId: string): boolean {
    const live = this.lives.get(sessionId);
    return Boolean(live && !live.ended);
  }

  async deliverResults(sessionId: string, results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>): Promise<Array<"accepted" | "duplicate">> {
    return results.map((result) => this.acceptTool(sessionId, result.tool_use_id, result.content, result.is_error));
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    return this.acceptTool(sessionId, completion.toolUseId, completion.content, completion.isError);
  }

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    if (this.closing) throw new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
    const route = codexFromModelId(input.request.model);
    if (!route || !this.config.models?.some((model) => model.id === input.request.model && model.provider === "codex")) {
      throw new BridgeError(400, "unknown_model", "This Codex model is not on the menu.");
    }
    const live = this.live(input.session.bridgeSessionId);
    if (live.busy) throw new BridgeError(409, "session_busy", "This Codex session already has an active request");
    live.busy = true;
    live.sink = sink;
    live.lastTouched = this.now();
    try {
      const requestHash = historyMessageHashes(input.request.messages).join("\n");
      if (live.lastTurn && live.lastRequestHash === requestHash) return live.lastTurn;
      // live.blocks is NOT cleared here: anything in it arrived after the last
      // response was cut (a parallel tool call, trailing text) and Droid has not
      // seen it yet. Dropping it left Codex waiting on calls Droid never got.
      const park = this.armPark(live);
      this.deliverRequestResults(live, input);
      if (!live.turnId) {
        await this.ensureThread(live, input, route);
        await this.startTurn(live, input, route.model);
      }
      const turn = await this.finishOrPark(live, input, park);
      live.lastRequestHash = requestHash;
      live.lastTurn = turn;
      return turn;
    } catch (error) {
      await this.cancel(input.session.bridgeSessionId, "request-failed");
      throw error instanceof BridgeError ? error : new BridgeError(502, "codex_error", error instanceof Error ? error.message : "Codex failed");
    } finally {
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = this.now();
    }
  }

  async interrupt(sessionId: string, _reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    if (!live?.server || !live.threadId || !live.turnId) return false;
    try { await live.server.request("turn/interrupt", { threadId: live.threadId, turnId: live.turnId }, 10_000); return true; }
    catch { return false; }
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    const error = new BridgeError(499, "cancelled", reason);
    live.ended = error;
    for (const pending of live.pending.values()) pending.reject(error);
    live.pending.clear();
    live.finishTurn?.({ status: "interrupted" });
    live.server?.close();
    this.lives.delete(sessionId);
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const live = this.lives.get(sessionId);
    const sdkSessionId = live?.threadId;
    await this.cancel(sessionId, reason);
    return { resumable: false, sdkSessionId };
  }

  async forget(session: RetiredSession): Promise<void> {
    const live = this.lives.get(session.bridgeSessionId);
    if (live && (live.busy || live.pending.size || live.turnId)) return;
    await this.cancel(session.bridgeSessionId, "session-expired");
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.lives.keys()].map((sessionId) => this.cancel(sessionId, "bridge shutdown")));
  }

  private live(sessionId: string): LiveCodex {
    const existing = this.lives.get(sessionId);
    if (existing) return existing;
    const created: LiveCodex = { pending: new Map(), blocks: [], busy: false, sent: false, lastTouched: this.now(), streamed: new Set() };
    this.lives.set(sessionId, created);
    return created;
  }

  private async resolveAccount(account: string): Promise<string> {
    if (account !== AUTO_ACCOUNT) return account;
    if (this.deps.pickAccount) return this.deps.pickAccount(new Set());
    const statuses = await Promise.all(listCodexAccounts().map((item) => probeCodexAccount(item)));
    const picked = pickCodexAccount(statuses);
    if (!picked) throw new BridgeError(429, "no_account_available", "Every Codex account is rate limited or logged out. See npm run accounts.");
    return picked;
  }

  private async ensureThread(live: LiveCodex, input: RuntimeRequest, route: { account: string; model: string }): Promise<void> {
    if (live.server && live.threadId) return;
    const account = await this.resolveAccount(route.account);
    const home = codexAccountHome(account);
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const catalog = droidCodexCatalog(home, this.config.dataDir, account);
    if (!catalog) {
      this.deps.alerts?.alert(`codex-catalog-${account}`, "dswap: Codex fallback",
        `Codex account ${account} has no model catalog to adjust, so Codex adds its own tools (sub-agents, apply_patch) next to Droid's. Droid's prompt is still the base prompt.`);
    }
    const server = (this.deps.open ?? ((options) => new CodexAppServer(options)))({
      codexHome: home, cwd, configOverrides: catalog ? [`model_catalog_json=${JSON.stringify(catalog)}`] : [],
      onRequest: (method, params) => this.serverRequest(live, input, method, params),
      onNotification: (method, params) => this.notification(live, method, params),
    });
    live.server = server;
    live.account = account;
    void server.exited.then(() => { if (!live.ended) live.finishTurn?.({ status: "failed", error: { message: "codex app-server exited" } }); });
    await server.initialize();
    const droidPrompt = systemText(input.request.system).trim();
    const started = await server.request<{ thread: { id: string } }>("thread/start", {
      cwd, model: route.model, approvalPolicy: "never", sandbox: "read-only", serviceName: "factory-cc",
      // Droid's prompt replaces Codex's own 21k-char harness prompt (skills,
      // plugins, sub-agents, functions.exec) instead of sitting under it.
      ...(droidPrompt ? { baseInstructions: droidPrompt } : {}),
      // The read-only sandbox only bounds Codex's own built-in tools, which are off.
      // Codex still told the model so twice: "the sandbox only permits reading
      // files" (permissions instructions) and a read-only permission_profile in
      // <environment_context>. The model then refused to edit although Droid's
      // Edit/Create/Execute were right there. Droid sends its own environment
      // reminder (cwd, OS) and its prompt says what its tools may do.
      config: {
        features: CODEX_BUILTIN_FEATURES_OFF, web_search: "disabled",
        include_permissions_instructions: false, include_environment_context: false,
        // More Codex-harness context Droid already covers or does not use: the
        // collaboration-mode block, apps, the ~/.agents and ~/.codex skill
        // catalog, and a second copy of AGENTS.md (Droid loads it itself).
        include_collaboration_mode_instructions: false, include_apps_instructions: false,
        project_doc_max_bytes: 0, skills: { include_instructions: false },
      },
      dynamicTools: (input.request.tools ?? []).map((tool) => ({ type: "function", name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.input_schema ?? { type: "object", properties: {} } })),
    });
    live.threadId = started.thread.id;
    this.logger.info("codex_thread_started", { account, model: route.model, threadId: live.threadId, tools: (input.request.tools ?? []).length });
  }

  private async startTurn(live: LiveCodex, input: RuntimeRequest, model: string): Promise<void> {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const droidInput = { ...input, droidPrompt: true };
    const blocks = !live.sent && input.request.messages.length > 1 ? buildInitialUserContent(droidInput, cwd) : buildDynamicUserContent(droidInput, cwd);
    const items: Json[] = blocks.flatMap((block): Json[] => {
      if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
      const source = block.type === "image" ? (block as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
      return source?.type === "base64" ? [{ type: "image", url: `data:${source.media_type};base64,${source.data}` }] : [];
    });
    live.turnDone = new Promise((resolve) => { live.finishTurn = resolve; });
    const level = droidReasoningLevel(input.request);
    const started = await live.server!.request<{ turn: { id: string } }>("turn/start", {
      threadId: live.threadId, input: items, model, ...(level && EFFORT[level] ? { effort: EFFORT[level] } : {}),
    });
    live.turnId = started.turn.id;
    live.sent = true;
  }

  private serverRequest(live: LiveCodex, input: RuntimeRequest, method: string, params: any): Promise<unknown> {
    if (method === "item/tool/call") {
      return new Promise((resolve, reject) => {
        if (live.ended) { reject(live.ended); return; }
        const id = canonicalToolUseId(String(params.callId || `toolu_${randomUUID().replace(/-/g, "")}`));
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
        live.pending.set(id, { resolve, reject, name: params.tool, input: args });
        live.blocks.push({ type: "tool_use", id, name: params.tool, input: args });
        // This becomes a real tool_use block for Droid; a "[Tool]" text trace
        // would only add noise to the transcript.
        live.sink?.activity?.();
        live.releasePark?.();
      });
    }
    // Built-in tools are off, so Codex should not ask; if it does, Droid owns approvals.
    return Promise.reject(new Error(`${method} is handled by Droid's tools in this bridge`));
  }

  private notification(live: LiveCodex, method: string, params: any): void {
    if (live.ended) return;
    live.sink?.activity?.();
    if (method === "item/agentMessage/delta" && typeof params?.delta === "string") {
      if (typeof params.itemId === "string") live.streamed.add(params.itemId);
      this.appendText(live, params.delta);
    } else if (method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string" && !live.streamed.has(params.item.id)) {
      this.appendText(live, params.item.text);
    } else if (method === "thread/tokenUsage/updated") {
      const last = params?.tokenUsage?.last;
      if (last) live.usage = { input_tokens: last.inputTokens ?? 0, output_tokens: last.outputTokens ?? 0, cache_read_input_tokens: last.cachedInputTokens ?? 0, estimated: false };
    } else if (method === "error" && params?.willRetry === false) {
      live.lastError = params?.error?.message;
    } else if (method === "turn/completed") {
      live.turnId = undefined;
      live.finishTurn?.({ status: params?.turn?.status ?? "completed", error: params?.turn?.error ?? undefined });
    }
  }

  private appendText(live: LiveCodex, text: string): void {
    const last = live.blocks.at(-1);
    if (last?.type === "text" && typeof last.text === "string") last.text += text;
    else live.blocks.push({ type: "text", text });
    live.sink?.textDelta(text);
  }

  private armPark(live: LiveCodex): Promise<void> {
    return new Promise((resolve) => { live.releasePark = () => resolve(); });
  }

  private async finishOrPark(live: LiveCodex, input: RuntimeRequest, park: Promise<void>): Promise<RuntimeTurn> {
    if (live.pending.size) return this.toolTurn(live, input);
    const outcome = await Promise.race([park.then(() => undefined), live.turnDone!]);
    if (!outcome || live.pending.size) return this.toolTurn(live, input);
    if (outcome.status === "failed") {
      const message = outcome.error?.message ?? live.lastError ?? "Codex turn failed";
      const limited = /usage limit|rate limit|429/i.test(message);
      throw new BridgeError(limited ? 429 : 502, limited ? "rate_limit_error" : "codex_turn_failed", `${message}${live.account ? ` (Codex account ${live.account})` : ""}`);
    }
    if (outcome.status === "interrupted") throw new BridgeError(499, "cancelled", "Codex turn was interrupted");
    return this.turn(live, input, "end_turn");
  }

  /** Wait for sibling parallel calls, then hand Droid every call it has not seen. */
  private async toolTurn(live: LiveCodex, input: RuntimeRequest): Promise<RuntimeTurn> {
    const deadline = this.now() + TOOL_GATHER_MAX_MS;
    let seen = -1;
    while (live.blocks.length !== seen && this.now() < deadline && !live.ended) {
      seen = live.blocks.length;
      await new Promise((resolve) => setTimeout(resolve, TOOL_GATHER_MS));
    }
    return this.turn(live, input, "tool_use");
  }

  private turn(live: LiveCodex, input: RuntimeRequest, stop: "tool_use" | "end_turn"): RuntimeTurn {
    const blocks = live.blocks;
    // Whatever arrives from here on belongs to the next response.
    live.blocks = [];
    return {
      response: assistantMessage(input.request.model, blocks, stop, live.usage ?? { input_tokens: 0, output_tokens: 0, estimated: true }),
      pendingToolIds: [...live.pending.keys()],
      sdkSessionId: live.threadId,
    };
  }

  private deliverRequestResults(live: LiveCodex, input: RuntimeRequest): void {
    for (const result of collectToolResults(input.request.messages)) this.resolvePending(live, result.tool_use_id, result.content, result.is_error);
  }

  private acceptTool(sessionId: string, toolUseId: string, content: string | ContentBlock[], isError?: boolean): "accepted" | "duplicate" {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live Codex thread owns these tool results");
    return this.resolvePending(live, toolUseId, content, isError) ? "accepted" : "duplicate";
  }

  private resolvePending(live: LiveCodex, toolUseId: string, content: string | ContentBlock[] | undefined, isError?: boolean): boolean {
    const id = canonicalToolUseId(toolUseId);
    const pending = live.pending.get(id);
    if (!pending) return false;
    live.pending.delete(id);
    pending.resolve({ contentItems: codexToolOutput(content), success: !isError });
    return true;
  }
}

/** Droid tool result -> Codex dynamic tool output items. */
export function codexToolOutput(content: string | ContentBlock[] | undefined): Json[] {
  if (typeof content === "string") return [{ type: "inputText", text: content }];
  const items = (content ?? []).flatMap((block): Json[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "inputText", text: block.text }];
    const source = block.type === "image" ? (block as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    return source?.type === "base64" ? [{ type: "inputImage", imageUrl: `data:${source.media_type};base64,${source.data}` }] : [];
  });
  return items.length ? items : [{ type: "inputText", text: textFromBlocks(content ?? []) || "(no output)" }];
}
