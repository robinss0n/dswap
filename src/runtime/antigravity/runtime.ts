import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../../config.js";
import type { Logger } from "../../logging.js";
import { assistantMessage } from "../../protocol/messages.js";
import { canonicalToolUseId, collectToolResults, systemText, textFromBlocks } from "../../protocol/content.js";
import { googleFromModelId } from "../../models.js";
import { historyMessageHashes } from "../../sessions/correlate.js";
import { BridgeError, type ContentBlock, type Json, type Usage } from "../../types.js";
import { processCwd, resolveRequestCwd } from "../../workspace.js";
import { AUTO_ACCOUNT } from "../../upstream/cswap.js";
import { droidAntigravity, REPLACE_MARKER, type AntigravityExecutable } from "../../upstream/antigravity-patch.js";
import { antigravityExecutable, GOOGLE_AUTH_METHOD, googleAccountHome, initializeAgent, listGoogleAccounts, openAgent, pickGoogleAccount, probeGoogleAccount } from "../../upstream/google-accounts.js";
import { toCursorToolResult } from "../cursor/tools.js";
import { buildDynamicUserContent, buildInitialUserContent } from "../system-prompt.js";
import { droidReasoningLevel, mapReasoningValue } from "../reasoning.js";
import type { BridgeRuntime, RetiredSession, RuntimeControl, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "../types.js";
import type { AcpClient } from "./acp-client.js";
import type { FallbackAlerts } from "../../notify.js";
import { DroidMcpHost, type HostedResult, type HostedTool } from "./droid-mcp-host.js";

/**
 * Google models through Google's Antigravity ACP agent. Droid's system prompt is
 * appended to the agent's, all of Antigravity's built-in tools are switched off,
 * and Droid's tools are served to it as an MCP server, so Droid runs (and
 * approves) every action. Each Google account is its own GEMINI_HOME; `auto`
 * picks the account with the most headroom when a session starts.
 */

/** MCP server name the agent sees; its tools are loaded eagerly so the model sees them directly. */
export const DROID_MCP_NAME = "droid";

/**
 * Antigravity abandons an MCP tool call after 3 minutes, but a Droid tool can run longer (a long
 * command, or a wait for the user's approval). Shortly before that limit the held call is answered
 * with DEFERRED_RESULT; Droid's real result is then sent to the model as the next prompt.
 */
export const TOOL_DEFER_MS = 160_000;
/**
 * Fallback only, for when the patched server is unavailable (see
 * upstream/antigravity-patch.ts, which makes Droid's prompt replace Antigravity's).
 * Antigravity accepts a client prompt only as an appended section
 * (`_meta.antigravity.systemPrompt.append`, rendered last as
 * <user_system_instructions>); its own ~1.4k-word harness prompt (identity,
 * messaging, transcripts, artifacts, communication style) always comes first and
 * no ACP option removes it. This notice makes Droid's prompt the one that counts.
 */
export const DROID_HOST_NOTICE = "You are running inside Factory Droid, as Droid's model. Droid's system prompt follows this notice and is authoritative: where it differs from the instructions above (the Antigravity identity, messaging, conversation transcript, artifacts and communication style sections), follow Droid's. Antigravity's built-in tools (run_command, file viewing and editing, artifacts, subagents) are not available; call only the tools provided in this session. Droid runs them and the user approves them.";

export const DEFERRED_RESULT = "Droid is still running this tool (it can take a while, for example while the user approves it). Do not call it again and do not guess its result. End your turn now; the result will arrive in the next message.";

interface PendingTool {
  resolve: (result: HostedResult) => void;
  reject: (error: unknown) => void;
  name: string;
  input: Json;
  /** Already returned to Droid as a tool_use. */
  reported: boolean;
  /** The MCP call was answered with DEFERRED_RESULT; Droid's result goes into a new prompt instead. */
  deferred: boolean;
  timer?: NodeJS.Timeout;
}
interface DeferredResult { name: string; content: string | ContentBlock[]; isError?: boolean }
interface TurnOutcome { stopReason?: string; error?: Error; usage?: any }
/** An ACP session config option (model, thinking_level, mode). Options may be grouped. */
interface ConfigOption { id: string; currentValue?: string; options?: Array<{ value?: string; options?: Array<{ value?: string }> }> }

interface LiveGoogle {
  client?: AcpClient;
  acpSessionId?: string;
  account?: string;
  /** The session's config options as Antigravity last reported them. */
  configOptions?: ConfigOption[];
  tools: HostedTool[];
  disposeMcp?: () => void;
  turn?: Promise<TurnOutcome>;
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
  deferredResults: DeferredResult[];
}

export interface AntigravityRuntimeDependencies {
  /** Injected for tests: start one account's agent. */
  open?: (home: string, handlers: { onNotification: (method: string, params: any) => void; onRequest: (method: string, params: any) => Promise<unknown> }, build: AntigravityExecutable) => AcpClient;
  /** Injected for tests: which server to run and whether it replaces the system prompt. */
  antigravity?: () => AntigravityExecutable;
  /** Desktop alert when Droid's prompt stops being the whole system prompt (see FallbackAlerts). */
  alerts?: Pick<FallbackAlerts, "alert">;
  /** Injected for tests: choose a concrete account for `auto`. */
  pickAccount?: (exclude: ReadonlySet<string>) => Promise<string>;
  /** Injected for tests: resolve an account name to its GEMINI_HOME. */
  accountHome?: (name: string) => string;
  mcpHost?: DroidMcpHost;
  now?: () => number;
  toolDeferMs?: number;
}

export class AntigravityRuntime implements BridgeRuntime {
  readonly kind = "google" as const;
  private readonly lives = new Map<string, LiveGoogle>();
  private readonly now: () => number;
  private readonly mcp: DroidMcpHost;
  private closing = false;
  private build?: AntigravityExecutable;
  private patchFailed = false;

  constructor(private readonly config: BridgeConfig, private readonly logger: Logger, private readonly deps: AntigravityRuntimeDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.mcp = deps.mcpHost ?? new DroidMcpHost();
  }

  setControl(_control: RuntimeControl | undefined): void {
    // Antigravity built-in tools are off; Droid owns every approval.
  }

  describe(): Record<string, unknown> {
    return { kind: "google", sessions: this.lives.size, pendingHostCalls: [...this.lives.values()].reduce((sum, live) => sum + live.pending.size, 0) };
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    return live ? [...live.pending.entries()].map(([toolUseId, call]) => ({ toolUseId, toolName: call.name, input: call.input })) : [];
  }

  protectedSessionIds(): string[] {
    return [...this.lives.entries()].filter(([, live]) => !live.ended && (live.busy || live.pending.size || live.turn)).map(([id]) => id);
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
    const route = googleFromModelId(input.request.model);
    if (!route || !this.config.models?.some((model) => model.id === input.request.model && model.provider === "google")) {
      throw new BridgeError(400, "unknown_model", "This Google model is not on the menu.");
    }
    const live = this.live(input.session.bridgeSessionId);
    if (live.busy) throw new BridgeError(409, "session_busy", "This Google session already has an active request");
    live.busy = true;
    live.sink = sink;
    live.lastTouched = this.now();
    try {
      const requestHash = historyMessageHashes(input.request.messages).join("\n");
      if (live.lastTurn && live.lastRequestHash === requestHash) return live.lastTurn;
      // A tool the agent called while Droid was not waiting on this session is reported now.
      live.blocks = [...live.pending.entries()].filter(([, call]) => !call.reported).map(([id, call]) => ({ type: "tool_use", id, name: call.name, input: call.input }));
      const park = this.armPark(live);
      live.tools = (input.request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? tool.name, inputSchema: (tool.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown> }));
      this.deliverRequestResults(live, input);
      if (live.deferredResults.length) await this.resumeWithDeferred(live, input);
      else if (!live.turn) {
        await this.ensureSession(live, input, route);
        await this.applyModel(live, route);
        await this.applyReasoning(live, input);
        this.startTurn(live, input);
      }
      const turn = await this.finishOrPark(live, input, park);
      live.lastRequestHash = requestHash;
      live.lastTurn = turn;
      return turn;
    } catch (error) {
      await this.cancel(input.session.bridgeSessionId, "request-failed");
      throw error instanceof BridgeError ? error : new BridgeError(502, "google_error", error instanceof Error ? error.message : "Antigravity failed");
    } finally {
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = this.now();
    }
  }

  async interrupt(sessionId: string, _reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    if (!live?.client || !live.acpSessionId || !live.turn) return false;
    live.client.notify("session/cancel", { sessionId: live.acpSessionId });
    return true;
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    const error = new BridgeError(499, "cancelled", reason);
    live.ended = error;
    for (const pending of live.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    live.pending.clear();
    if (live.client && live.acpSessionId && live.turn) live.client.notify("session/cancel", { sessionId: live.acpSessionId });
    live.client?.close();
    live.disposeMcp?.();
    this.lives.delete(sessionId);
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const live = this.lives.get(sessionId);
    const sdkSessionId = live?.acpSessionId;
    await this.cancel(sessionId, reason);
    return { resumable: false, sdkSessionId };
  }

  async forget(session: RetiredSession): Promise<void> {
    const live = this.lives.get(session.bridgeSessionId);
    if (live && (live.busy || live.pending.size || live.turn)) return;
    await this.cancel(session.bridgeSessionId, "session-expired");
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.lives.keys()].map((sessionId) => this.cancel(sessionId, "bridge shutdown")));
    await this.mcp.close();
  }

  private live(sessionId: string): LiveGoogle {
    const existing = this.lives.get(sessionId);
    if (existing) return existing;
    const created: LiveGoogle = { tools: [], pending: new Map(), blocks: [], busy: false, sent: false, lastTouched: this.now(), deferredResults: [] };
    this.lives.set(sessionId, created);
    return created;
  }

  private async resolveAccount(account: string): Promise<string> {
    if (account !== AUTO_ACCOUNT) return account;
    if (this.deps.pickAccount) return this.deps.pickAccount(new Set());
    const statuses = await Promise.all(listGoogleAccounts().map((item) => probeGoogleAccount(item)));
    const picked = pickGoogleAccount(statuses);
    if (!picked) throw new BridgeError(429, "no_account_available", "Every Google account is rate limited or signed out. See dswap.");
    return picked;
  }

  /** The patched server (Droid's prompt replaces Antigravity's), made once per Antigravity version. */
  private executable(): AntigravityExecutable {
    if (this.patchFailed) { const original = this.build?.original ?? antigravityExecutable(); return { executable: original, replacesPrompt: false, original }; }
    this.build ??= (this.deps.antigravity ?? (() => droidAntigravity(antigravityExecutable(), (error) => {
      this.logger.warn("antigravity_patch_unavailable", { error: error instanceof Error ? error.message : String(error) });
    })))();
    if (!this.build.replacesPrompt) {
      this.deps.alerts?.alert("google-patch-unavailable", "dswap: Google models fell back",
        "Antigravity could not be patched (a new version may have changed its code). Google models now run with Antigravity's own prompt, and Droid's prompt is only appended.");
    }
    return this.build;
  }

  private async ensureSession(live: LiveGoogle, input: RuntimeRequest, route: { account: string; model: string }): Promise<void> {
    if (live.client && live.acpSessionId) return;
    const account = await this.resolveAccount(route.account);
    const build = this.executable();
    try {
      await this.startAgent(live, input, account, build);
    } catch (error) {
      if (!build.replacesPrompt || (error instanceof BridgeError && error.code === "google_signed_out")) throw error;
      // A patched server that cannot start a session must not take Google down:
      // go back to the unmodified one (appended prompt) for the rest of this run.
      this.logger.warn("antigravity_patch_failed", { error: error instanceof Error ? error.message : String(error) });
      this.patchFailed = true;
      this.deps.alerts?.alert("google-patch-failed", "dswap: Google models fell back",
        "The patched Antigravity server failed to start a session. Until the bridge restarts, Google models run with Antigravity's own prompt, and Droid's prompt is only appended.");
      live.client?.close();
      live.disposeMcp?.();
      Object.assign(live, { client: undefined, acpSessionId: undefined, disposeMcp: undefined, configOptions: undefined });
      await this.startAgent(live, input, account, this.executable());
    }
    await this.selectSession(live, route, account);
  }

  /** Start the agent and its session, up to session/new. */
  private async startAgent(live: LiveGoogle, input: RuntimeRequest, account: string, build: AntigravityExecutable): Promise<void> {
    const home = (this.deps.accountHome ?? googleAccountHome)(account);
    const cwd = processCwd(resolveRequestCwd(input.headers, input.request, this.config), this.config);
    const handlers = {
      onNotification: (method: string, params: any) => this.notification(live, method, params),
      onRequest: (method: string, params: any) => this.agentRequest(method, params),
    };
    const client = (this.deps.open ?? ((agentHome, h, b) => openAgent(agentHome, { cwd, executable: b.executable, ...h })))(home, handlers, build);
    live.client = client;
    live.account = account;
    void client.exited.then(() => { if (!live.ended) { live.lastError ??= "Antigravity agent exited"; live.releasePark?.(); } });
    await initializeAgent(client);
    await client.request("authenticate", { methodId: GOOGLE_AUTH_METHOD }, 60_000).catch((error: unknown) => {
      throw new BridgeError(401, "google_signed_out", `Google account ${account} needs a new sign-in: dswap login google ${account} (${error instanceof Error ? error.message : error})`);
    });
    const mcp = await this.mcp.register({
      tools: () => live.tools,
      call: (name, args, signal) => this.toolCall(live, name, args, signal),
    });
    live.disposeMcp = mcp.dispose;
    mkdirSync(cwd, { recursive: true });
    const droidPrompt = systemText(input.request.system).trim();
    // Patched server: the marker makes Droid's prompt the whole system prompt.
    const prompt = build.replacesPrompt ? `${REPLACE_MARKER}${droidPrompt}` : `${DROID_HOST_NOTICE}\n\n${droidPrompt}`;
    const session = await client.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", {
      cwd,
      mcpServers: [{ type: "http", name: DROID_MCP_NAME, url: mcp.url, headers: [] }],
      _meta: { antigravity: { enabledTools: [], eagerMcpServers: [DROID_MCP_NAME], ...(droidPrompt ? { systemPrompt: { append: prompt } } : {}) } },
    }, 120_000);
    live.acpSessionId = session.sessionId;
    live.configOptions = session.configOptions;
    this.logger.info("google_agent_started", { account, replacesPrompt: build.replacesPrompt });
  }

  /** Mode and model for a new session. */
  private async selectSession(live: LiveGoogle, route: { model: string }, account: string): Promise<void> {
    const client = live.client!;
    const session = { sessionId: live.acpSessionId! };
    // MCP tools are Droid's; Droid approves them, so the agent must not ask again.
    await client.request("session/set_mode", { sessionId: session.sessionId, modeId: "yolo" }, 30_000);
    // The model picker takes a base id (gemini-3.8-flash), with the thinking level
    // as its own option; set_model only knows the flat ids (gemini-3.8-flash-high)
    // that older menus stored, so it stays the fallback.
    try {
      await this.setConfigOption(live, "model", route.model);
    } catch {
      await client.request("session/set_model", { sessionId: session.sessionId, modelId: route.model }, 30_000).catch((error: unknown) => {
        throw new BridgeError(400, "unknown_model", `Google account ${account} cannot use ${route.model}: ${error instanceof Error ? error.message : error}`);
      });
    }
    this.logger.info("google_session_started", { account, model: route.model, acpSessionId: session.sessionId, tools: live.tools.length });
  }

  private async setConfigOption(live: LiveGoogle, configId: string, value: string): Promise<void> {
    const result = await live.client!.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: live.acpSessionId, configId, value }, 30_000);
    if (result?.configOptions) live.configOptions = result.configOptions;
  }

  /**
   * Droid can switch models inside a conversation; the session keeps going, so
   * the new model has to be selected in Antigravity before the next turn.
   */
  private async applyModel(live: LiveGoogle, route: { model: string }): Promise<void> {
    const current = live.configOptions?.find((item) => item.id === "model")?.currentValue;
    if (!current || current === route.model) return;
    try {
      await this.setConfigOption(live, "model", route.model);
    } catch (error) {
      throw new BridgeError(400, "unknown_model", `Google account ${live.account} cannot switch to ${route.model}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Droid's reasoning selector -> the model's thinking_level, before each new
   * turn. Models without that option (Claude, GPT-OSS on Antigravity) are left
   * alone; a refused level keeps the current one rather than failing the turn.
   */
  private async applyReasoning(live: LiveGoogle, input: RuntimeRequest): Promise<void> {
    const level = droidReasoningLevel(input.request);
    const option = live.configOptions?.find((item) => item.id === "thinking_level");
    if (!level || !option) return;
    const allowed = (option.options ?? []).flatMap((item) => item.options ?? [item]).map((item) => item.value).filter((value): value is string => Boolean(value));
    if (!allowed.length) return;
    const wanted = mapReasoningValue(level, allowed);
    if (option.currentValue === wanted) return;
    await this.setConfigOption(live, "thinking_level", wanted).catch((error: unknown) => {
      this.logger.warn("google_thinking_level_refused", { wanted, error: error instanceof Error ? error.message : String(error) });
    });
  }

  private startTurn(live: LiveGoogle, input: RuntimeRequest, override?: Json[]): void {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const droidInput = { ...input, droidPrompt: true };
    const prompt = override ?? acpPrompt(!live.sent && input.request.messages.length > 1 ? buildInitialUserContent(droidInput, cwd) : buildDynamicUserContent(droidInput, cwd));
    live.sent = true;
    live.turn = live.client!.request<{ stopReason?: string; usage?: any }>("session/prompt", { sessionId: live.acpSessionId, prompt }, 0)
      .then((result) => ({ stopReason: result?.stopReason, usage: result?.usage }), (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }))
      .then((outcome) => { live.turn = undefined; return outcome; });
    void live.turn.then(() => live.releasePark?.());
  }

  /** Droid results for calls the agent stopped waiting on: stop any leftover turn, then prompt with them. */
  private async resumeWithDeferred(live: LiveGoogle, input: RuntimeRequest): Promise<void> {
    const results = live.deferredResults.splice(0);
    const running = live.turn;
    if (running) {
      live.client?.notify("session/cancel", { sessionId: live.acpSessionId });
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 30_000))]);
      if (live.turn === running) throw new BridgeError(502, "google_turn_failed", "Antigravity did not stop its turn to take the tool results");
    }
    live.blocks = live.blocks.filter((block) => block.type === "tool_use");
    const blocks: ContentBlock[] = [{ type: "text", text: "Droid finished the tool call(s) you were waiting for. Results:" }];
    for (const result of results) {
      blocks.push({ type: "text", text: `\n${result.name}${result.isError ? " (failed)" : ""}:\n${typeof result.content === "string" ? result.content : textFromBlocks(result.content) || "(no text output)"}` });
      if (Array.isArray(result.content)) blocks.push(...result.content.filter((block) => block.type === "image"));
    }
    this.startTurn(live, input, acpPrompt(blocks));
  }

  /** An MCP tool call from the agent becomes a Droid tool_use; the HTTP request waits for Droid's result. */
  private toolCall(live: LiveGoogle, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HostedResult> {
    return new Promise<HostedResult>((resolve, reject) => {
      if (live.ended) { reject(live.ended); return; }
      const id = canonicalToolUseId(`toolu_${randomUUID().replace(/-/g, "")}`);
      const input = args as Json;
      const call: PendingTool = { resolve, reject, name, input, reported: false, deferred: false };
      const defer = () => {
        clearTimeout(call.timer);
        if (call.deferred || live.pending.get(id) !== call) return;
        call.deferred = true;
        resolve({ content: [{ type: "text", text: DEFERRED_RESULT }] });
      };
      call.timer = setTimeout(defer, this.deps.toolDeferMs ?? TOOL_DEFER_MS);
      call.timer.unref?.();
      live.pending.set(id, call);
      live.blocks.push({ type: "tool_use", id, name, input });
      live.sink?.toolTrace(name, "");
      // The agent gave up on the call; Droid still owns the tool_use, so its result is kept for later.
      signal.addEventListener("abort", defer, { once: true });
      live.releasePark?.();
    });
  }

  private agentRequest(method: string, params: any): Promise<unknown> {
    if (method === "session/request_permission") {
      // Only Droid's MCP tools exist, and Droid approves those itself.
      const allow = (params?.options ?? []).find((option: any) => option?.kind === "allow_once") ?? params?.options?.[0];
      return Promise.resolve(allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } });
    }
    return Promise.reject(new Error(`${method} is handled by Droid's tools in this bridge`));
  }

  private notification(live: LiveGoogle, method: string, params: any): void {
    if (live.ended || method !== "session/update") return;
    live.sink?.activity?.();
    const update = params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") this.appendText(live, update.content.text);
  }

  private appendText(live: LiveGoogle, text: string): void {
    const last = live.blocks.at(-1);
    if (last?.type === "text" && typeof last.text === "string") last.text += text;
    else live.blocks.push({ type: "text", text });
    live.sink?.textDelta(text);
  }

  private armPark(live: LiveGoogle): Promise<void> {
    return new Promise((resolve) => { live.releasePark = () => resolve(); });
  }

  private async finishOrPark(live: LiveGoogle, input: RuntimeRequest, park: Promise<void>): Promise<RuntimeTurn> {
    const turn = live.turn;
    if (live.pending.size || !turn) return this.turn(live, input, "tool_use");
    // The park opens when the agent calls a Droid tool, when the turn ends, or when the agent exits.
    await Promise.race([park, turn]);
    if (live.pending.size) return this.turn(live, input, "tool_use");
    const outcome = live.turn === turn ? undefined : await turn;
    if (!outcome) throw new BridgeError(502, "google_turn_failed", `${live.lastError ?? "Antigravity stopped without finishing the turn"}${live.account ? ` (Google account ${live.account})` : ""}`);
    if (outcome.error) {
      const message = outcome.error.message;
      const limited = /quota|rate.?limit|resource.?exhausted|429|usage limit/i.test(message);
      throw new BridgeError(limited ? 429 : 502, limited ? "rate_limit_error" : "google_turn_failed", `${message}${live.account ? ` (Google account ${live.account})` : ""}`);
    }
    if (outcome.usage) live.usage = { input_tokens: outcome.usage.inputTokens ?? 0, output_tokens: (outcome.usage.outputTokens ?? 0) + (outcome.usage.thoughtTokens ?? 0), cache_read_input_tokens: outcome.usage.cachedReadTokens ?? 0, estimated: false };
    if (outcome.stopReason === "cancelled") throw new BridgeError(499, "cancelled", "Google turn was cancelled");
    return this.turn(live, input, outcome.stopReason === "max_tokens" ? "max_tokens" : "end_turn");
  }

  private turn(live: LiveGoogle, input: RuntimeRequest, stop: "tool_use" | "end_turn" | "max_tokens"): RuntimeTurn {
    for (const call of live.pending.values()) call.reported = true;
    return {
      response: assistantMessage(input.request.model, [...live.blocks], stop, live.usage ?? { input_tokens: 0, output_tokens: 0, estimated: true }),
      pendingToolIds: [...live.pending.keys()],
      sdkSessionId: live.acpSessionId,
    };
  }

  private deliverRequestResults(live: LiveGoogle, input: RuntimeRequest): void {
    for (const result of collectToolResults(input.request.messages)) this.resolvePending(live, result.tool_use_id, result.content, result.is_error);
  }

  private acceptTool(sessionId: string, toolUseId: string, content: string | ContentBlock[], isError?: boolean): "accepted" | "duplicate" {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live Google session owns these tool results");
    return this.resolvePending(live, toolUseId, content, isError) ? "accepted" : "duplicate";
  }

  private resolvePending(live: LiveGoogle, toolUseId: string, content: string | ContentBlock[] | undefined, isError?: boolean): boolean {
    const id = canonicalToolUseId(toolUseId);
    const pending = live.pending.get(id);
    if (!pending) return false;
    live.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.deferred) live.deferredResults.push({ name: pending.name, content: content ?? "(no output)", isError });
    else pending.resolve(toCursorToolResult(content ?? "(no output)", isError) as HostedResult);
    return true;
  }
}


/** Droid content blocks as ACP prompt blocks (text and base64 images). */
function acpPrompt(blocks: ContentBlock[]): Json[] {
  return blocks.flatMap((block): Json[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    const source = block.type === "image" ? (block as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    return source?.type === "base64" && source.data ? [{ type: "image", mimeType: source.media_type ?? "image/png", data: source.data }] : [];
  });
}
