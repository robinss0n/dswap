import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../../config.js";
import type { Logger } from "../../logging.js";
import { assistantMessage } from "../../protocol/messages.js";
import { canonicalToolUseId, collectToolResults, systemText, textFromBlocks } from "../../protocol/content.js";
import { codexFromModelId } from "../../models.js";
import { historyMessageHashes } from "../../sessions/correlate.js";
import { BridgeError, type ContentBlock, type Json, type MessagesRequest, type ToolDefinition, type Usage } from "../../types.js";
import { resolveRequestCwd } from "../../workspace.js";
import { AUTO_ACCOUNT } from "../../upstream/cswap.js";
import { providerCliEnv } from "../../upstream/auth-env.js";
import { cachedCodexAccountStatus, codexAccountHome, codexMcpServerNames, listCodexAccounts, pickCodexAccount } from "../../upstream/codex-accounts.js";
import { CANCELLED_TOOL_NOTE, CANCELLED_TURN_DENIAL, isUserCancellation } from "../cancellation.js";
import { deferredToolDefinitions } from "../cursor/deferred-catalog.js";
import { hostAllowsAnyTools } from "../native-tool-policy.js";
import { droidReasoningLevel } from "../reasoning.js";
import { buildDynamicUserContent, buildInitialUserContent } from "../system-prompt.js";
import type { BridgeRuntime, RetiredSession, RuntimeControl, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "../types.js";
import { CodexAppServer, CodexRpcError, type AppServerOptions } from "./app-server.js";
import type { FallbackAlerts } from "../../notify.js";

/**
 * Codex through `codex app-server`. Droid's system prompt becomes Codex's
 * base instructions, Droid's tools become Codex dynamic tools, and Codex's
 * own shell, web, image and agent tools are switched off, so Droid runs (and
 * approves) every action. Each account is its own CODEX_HOME; `auto` picks the
 * account with the most headroom when a session starts.
 */

/** Codex features that add built-in tools. Off, the model sees only Droid's tools. */
export const CODEX_BUILTIN_FEATURES_OFF = {
  shell_tool: false, unified_exec: false, goals: false, multi_agent: false, view_image: false, image_generation: false,
  apps: false, plugins: false, computer_use: false, browser_use: false, tool_suggest: false, skill_search: false, sleep_tool: false,
};

/**
 * Codex features that act on their own: hooks from the account's ~/.codex (on by
 * default in codex-cli 0.165.0) would run commands Droid never approved, and
 * memories would carry context between threads behind Droid's back.
 */
export const CODEX_SIDE_EFFECT_FEATURES_OFF = { hooks: false, memories: false };

/**
 * Factory adds these mode tools mid-session (spec mode, Missions), but Codex fixes its
 * tools at thread/start. Registered as deferred placeholders, they become callable once
 * Droid advertises them; until then a call is refused without reaching Droid.
 */
const FACTORY_MODE_TOOLS = ["ExitSpecMode", "ProposeMission", "StartMissionRun", "DismissHandoffItems", "EndFeatureRun", "AskUser"];

/** After a usage-limit failure, `auto` skips that account this long (Codex gives no reset time in the error). */
const LIMITED_ACCOUNT_MS = 10 * 60_000;

interface PendingTool { resolve: (result: { contentItems: Json[]; success: boolean }) => void; reject: (error: unknown) => void; name: string; input: Json }
interface TurnOutcome { status: string; error?: { message?: string; codexErrorInfo?: unknown } }
interface OrphanedCall { name: string; input: Json }

interface ResumeRecord {
  threadId: string;
  account: string;
  model: string;
  history: string[];
  registered: LiveCodex["registered"];
  advertised: LiveCodex["advertised"];
  schemas: LiveCodex["schemas"];
}

interface LiveCodex {
  server?: CodexAppServer;
  threadId?: string;
  account?: string;
  model?: string;
  history?: string[];
  resumeUnsafe?: boolean;
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
  lastError?: TurnOutcome["error"];
  /** Agent messages that streamed deltas; a completed message without any is added whole. */
  streamed: Set<string>;
  /** The agent message the last text came from, so a new message starts on its own paragraph. */
  textItem?: string;
  /**
   * Codex dynamic tools are fixed at thread/start. Deferred ones are placeholders until
   * Droid advertises them (ToolSearch); mode ones until Droid enters that mode.
   */
  registered: Map<string, "advertised" | "deferred" | "mode">;
  /** Tool names in Droid's latest request. */
  advertised: Set<string>;
  /** Input schema of each advertised tool, to notice a tool that changed under the same name. */
  schemas: Map<string, string>;
  /** Droid's latest request: decides which tool calls Codex may make. */
  request?: MessagesRequest;
  /**
   * Calls Codex abandoned when its turn ended (for example an exec cell yielded while
   * AskUser waited on the user). Droid still delivers their results later.
   */
  orphaned: Map<string, OrphanedCall>;
  /** Results of orphaned calls, handed to the model with its next input. */
  lateResults: Array<{ id: string; name: string; content: string | ContentBlock[]; isError?: boolean; cancelled?: boolean }>;
  settled: Set<string>;
  /** The turn in which the user cancelled a Droid tool: further calls in it are refused. */
  cancelledTurn?: string;
  /** The bridge asked Codex to interrupt the running turn; the thread stays usable. */
  interrupting?: boolean;
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

/**
 * Codex's exec cell yields after 30 s by default. A model that then ends its turn
 * abandons the Droid call still running in the cell, and Codex fails it: an AskUser
 * answer arriving later had no call left to answer (codex-cli 0.165.0, 2026-10-31).
 */
/**
 * How long an exec cell waits on Droid tools before yielding to the model. At the 30 s
 * default the model polls `wait`, one extra sampling per 30 s of a long Droid tool.
 */
export const CODEX_EXEC_YIELD_MS = 600_000;

export const CODEX_DEVELOPER_INSTRUCTIONS = "Droid tools such as AskUser, Task and Execute can run for minutes while Droid or the user works. When exec returns \"Script running with cell ID ...\", call wait with that cell_id until the script completes. Do not end your turn while a Droid tool call is still running.";

export class CodexRuntime implements BridgeRuntime {
  readonly kind = "codex" as const;
  private readonly lives = new Map<string, LiveCodex>();
  private readonly resumes = new Map<string, ResumeRecord>();
  private readonly now: () => number;
  private closing = false;
  /** Accounts that just hit a usage limit, until when `auto` skips them. */
  private readonly limitedUntil = new Map<string, number>();

  constructor(private readonly config: BridgeConfig, private readonly logger: Logger, private readonly deps: CodexRuntimeDependencies = {}) {
    this.now = deps.now ?? Date.now;
  }

  setControl(_control: RuntimeControl | undefined): void {
    // Codex built-in tools are off; Droid owns every approval.
  }

  describe(): Record<string, unknown> {
    const lives = [...this.lives.values()];
    return {
      kind: "codex", sessions: lives.length, appServers: lives.filter((live) => live.server).length,
      pendingHostCalls: lives.reduce((sum, live) => sum + live.pending.size + live.orphaned.size, 0),
    };
  }

  /**
   * Orphaned calls count too: Droid still runs them, and the app's release paths
   * (EndFeatureRun worker release, compaction, reclaim exemptions) key off this list.
   */
  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    if (!live) return [];
    return [
      ...[...live.pending.entries()].map(([toolUseId, call]) => ({ toolUseId, toolName: call.name, input: call.input })),
      ...[...live.orphaned.entries()].map(([toolUseId, call]) => ({ toolUseId, toolName: call.name, input: call.input })),
    ];
  }

  protectedSessionIds(): string[] {
    return [...this.lives.entries()].filter(([, live]) => !live.ended && (live.busy || live.pending.size || live.orphaned.size || live.turnId)).map(([id]) => id);
  }

  isSessionUsable(sessionId: string): boolean {
    const live = this.lives.get(sessionId);
    return Boolean(live && !live.ended);
  }

  async deliverResults(sessionId: string, results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>): Promise<Array<"accepted" | "duplicate">> {
    return results.map((result) => this.acceptTool(sessionId, result.tool_use_id, result.content, result.is_error));
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    const outcome = this.acceptTool(sessionId, completion.toolUseId, completion.content, completion.isError);
    // Factory has ended this worker (a terminal EndFeatureRun): Codex must not keep sampling in it.
    if (completion.terminal) await this.cancel(sessionId, "host-terminal");
    return outcome;
  }

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    if (this.closing) throw new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
    const route = codexFromModelId(input.request.model);
    if (!route || !this.config.models?.some((model) => model.id === input.request.model && model.provider === "codex")) {
      throw new BridgeError(400, "unknown_model", "This Codex model is not on the menu.");
    }
    await this.switchAccountIfNeeded(input.session.bridgeSessionId, route.account);
    const live = this.live(input.session.bridgeSessionId);
    if (live.busy) throw new BridgeError(409, "session_busy", "This Codex session already has an active request");
    live.busy = true;
    live.sink = sink;
    live.lastTouched = this.now();
    try {
      const requestHash = historyMessageHashes(input.request.messages).join("\n");
      if (live.lastTurn && live.lastRequestHash === requestHash) return live.lastTurn;
      live.request = input.request;
      // live.blocks is NOT cleared here: anything in it arrived after the last
      // response was cut (a parallel tool call, trailing text) and Droid has not
      // seen it yet. Dropping it left Codex waiting on calls Droid never got.
      const park = this.armPark(live);
      if (!live.turnId) await this.ensureThread(live, input, route);
      const catalogNote = this.updateAdvertised(live, input);
      // Whole history, not just the tail: a Mission pause puts an "[Interrupted]" assistant
      // record between a result and the latest user message. Only calls this thread
      // still owes count, so old results already delivered are never replayed.
      const owed = new Set<string>();
      const results = collectToolResults(input.request.messages).filter((result) => {
        const id = canonicalToolUseId(result.tool_use_id);
        if (owed.has(id) || !(live.pending.has(id) || live.orphaned.has(id))) return false;
        owed.add(id);
        return true;
      });
      const freshIndex = results.findIndex((result) => live.pending.has(canonicalToolUseId(result.tool_use_id)));
      const attach: Json[] = [];
      const notes: string[] = [];
      if (catalogNote) {
        if (freshIndex >= 0) attach.push({ type: "inputText", text: catalogNote });
        else notes.push(catalogNote);
      }
      // Steer before resolving the results, so Codex's next sampling step sees both.
      if (live.turnId) await this.steer(live, input, notes, freshIndex >= 0 ? attach : undefined);
      results.forEach((result, index) => this.resolvePending(live, result.tool_use_id, result.content, result.is_error, index === freshIndex ? attach : []));
      if (!live.turnId) {
        await this.startTurn(live, input, route.model, notes);
      }
      const turn = await this.finishOrPark(live, input, park);
      live.lastRequestHash = requestHash;
      live.lastTurn = turn;
      // Include the reply as well as every request message: a shared opening prompt
      // alone cannot prove continuity. These hashes normalize protocol annotations.
      live.history = historyMessageHashes([...input.request.messages, { role: "assistant", content: turn.response.content }]);
      live.model = route.model;
      return turn;
    } catch (error) {
      if (live.interrupting && error instanceof BridgeError && error.status === 499 && !live.ended) {
        // interrupt() told the app this thread survives; only this response is dropped.
        this.dropUnsentCalls(live);
        live.resumeUnsafe = true;
        throw error;
      }
      await this.cancel(input.session.bridgeSessionId, "request-failed");
      throw error instanceof BridgeError ? error : new BridgeError(502, "codex_error", error instanceof Error ? error.message : "Codex failed");
    } finally {
      live.interrupting = false;
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = this.now();
      void this.trimIdle().catch(() => this.logger.warn("codex_idle_trim_failed"));
    }
  }

  async interrupt(sessionId: string, _reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    if (!live?.server || !live.threadId || !live.turnId) return false;
    live.interrupting = true;
    try { await live.server.request("turn/interrupt", { threadId: live.threadId, turnId: live.turnId }, 10_000); return true; }
    catch { live.interrupting = false; return false; }
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    this.resumes.delete(sessionId);
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
    const sdkSessionId = live?.threadId ?? this.resumes.get(sessionId)?.threadId;
    const resumable = await this.retireIdle(sessionId, reason);
    return { resumable, sdkSessionId };
  }

  async forget(session: RetiredSession): Promise<void> {
    const live = this.lives.get(session.bridgeSessionId);
    if (live && (live.busy || live.pending.size || live.orphaned.size || live.turnId)) return;
    await this.retireIdle(session.bridgeSessionId, "session-expired");
  }

  async close(): Promise<void> {
    this.closing = true;
    this.resumes.clear();
    await Promise.all([...this.lives.keys()].map((sessionId) => this.cancel(sessionId, "bridge shutdown")));
  }

  private async retireIdle(sessionId: string, reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    if (!live) return this.resumes.has(sessionId);
    const record: ResumeRecord | undefined = !live.ended && !live.busy && !live.pending.size && !live.orphaned.size
      && !live.turnId && !live.cancelledTurn && !live.resumeUnsafe && !live.blocks.length && !live.lateResults.length
      && live.lastTurn?.response.stop_reason === "end_turn" && live.threadId && live.account && live.model && live.history
      ? { threadId: live.threadId, account: live.account, model: live.model, history: live.history,
        registered: new Map(live.registered), advertised: new Set(live.advertised), schemas: new Map(live.schemas) }
      : undefined;
    const stopping = this.cancel(sessionId, reason);
    // Publish before yielding so a concurrent cancel cannot be followed by a stale save.
    if (record) {
      this.resumes.set(sessionId, record);
      while (this.resumes.size > 50) this.resumes.delete(this.resumes.keys().next().value!);
    }
    await stopping;
    return Boolean(record);
  }

  private live(sessionId: string): LiveCodex {
    const existing = this.lives.get(sessionId);
    if (existing) return existing;
    const created: LiveCodex = {
      pending: new Map(), blocks: [], busy: false, sent: false, lastTouched: this.now(), streamed: new Set(),
      registered: new Map(), advertised: new Set(), schemas: new Map(), orphaned: new Map(), lateResults: [], settled: new Set(),
    };
    this.lives.set(sessionId, created);
    return created;
  }

  /**
   * Codex accounts are separate app-servers, so a thread cannot move to another account.
   * Switching to a named account starts a new thread that imports the history; `auto`
   * keeps the current account.
   */
  private async switchAccountIfNeeded(sessionId: string, account: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live?.account || account === AUTO_ACCOUNT || account === live.account) return;
    if (live.busy || live.pending.size || live.orphaned.size || live.turnId) {
      throw new BridgeError(409, "model_switch_busy", `Codex account ${live.account} still has work running. Switch accounts after it finishes.`);
    }
    this.logger.info("codex_account_switched", { from: live.account, to: account, threadId: live.threadId });
    await this.cancel(sessionId, "account-switch");
  }

  /**
   * Close app-servers nobody is waiting on: tool-free helper sessions (titles,
   * summaries) as soon as they are idle, others beyond maxIdleSessions, oldest first.
   * Clean closed sessions retain a bounded in-memory native-thread checkpoint.
   */
  private async trimIdle(): Promise<void> {
    const idle = [...this.lives.entries()]
      .filter(([, live]) => live.server && !live.ended && !live.busy && !live.pending.size && !live.orphaned.size && !live.turnId)
      .sort(([, a], [, b]) => a.lastTouched - b.lastTouched);
    const helpers = idle.filter(([, live]) => live.registered.size === 0);
    const others = idle.filter(([, live]) => live.registered.size > 0);
    const excess = others.slice(0, Math.max(0, others.length - (this.config.maxIdleSessions ?? 4)));
    await Promise.all([...helpers, ...excess].map(([id]) => this.retireIdle(id, "idle-pool-limit")));
  }

  private async resolveAccount(account: string): Promise<string> {
    if (account !== AUTO_ACCOUNT) return account;
    const now = this.now();
    const exclude = new Set([...this.limitedUntil].filter(([, until]) => until > now).map(([name]) => name));
    if (this.deps.pickAccount) return this.deps.pickAccount(exclude);
    const statuses = await Promise.all(listCodexAccounts().map((item) => cachedCodexAccountStatus(item)));
    const picked = pickCodexAccount(statuses, exclude);
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
    const sessionId = input.session.bridgeSessionId;
    const server = (this.deps.open ?? ((options) => new CodexAppServer(options)))({
      codexHome: home, cwd, env: providerCliEnv(process.env),
      configOverrides: [...(catalog ? [`model_catalog_json=${JSON.stringify(catalog)}`] : []), ...this.mcpServersOff(home, account)],
      onRequest: (method, params) => this.serverRequest(live, input, method, params),
      onNotification: (method, params) => this.notification(live, method, params),
      onStderr: (line) => { if (line.trim()) this.logger.warn("codex_stderr", { account, sessionId, line: line.slice(0, 500) }); },
    });
    live.server = server;
    live.account = account;
    void server.exited.then(() => {
      if (live.ended) return;
      const stderr = server.stderrTail?.().slice(-1500) ?? "";
      this.logger.warn("codex_app_server_exited", { account, sessionId, threadId: live.threadId, running: Boolean(live.turnId), stderr });
      if (live.finishTurn && live.turnId) {
        live.finishTurn({ status: "failed", error: { message: `codex app-server exited${stderr ? `: ${stderr}` : ""}` } });
      } else if (this.lives.get(sessionId) === live && !live.busy) {
        // An idle session must not keep a dead server: ensureThread would trust it.
        void this.retireIdle(sessionId, "app-server-exited").catch(() => this.logger.warn("codex_retire_failed", { sessionId }));
      }
    });
    await server.initialize();
    const threadConfig = {
      features: {
        ...CODEX_BUILTIN_FEATURES_OFF, ...CODEX_SIDE_EFFECT_FEATURES_OFF,
        // Only the thread config applies this; `-c code_mode...` had no effect (codex-cli 0.165.0).
        code_mode: { enabled: true, default_exec_yield_time_ms: CODEX_EXEC_YIELD_MS },
      },
      web_search: "disabled",
      include_permissions_instructions: false, include_environment_context: false,
      // More Codex-harness context Droid already covers or does not use: the
      // collaboration-mode block, apps, the ~/.agents and ~/.codex skill
      // catalog, and a second copy of AGENTS.md (Droid loads it itself).
      include_collaboration_mode_instructions: false, include_apps_instructions: false,
      project_doc_max_bytes: 0, skills: { include_instructions: false },
    };
    const resume = this.resumes.get(sessionId);
    this.resumes.delete(sessionId);
    const incoming = historyMessageHashes(input.request.messages);
    if (resume && resume.account === account && resume.model === route.model
      && incoming.length > resume.history.length && input.request.messages[resume.history.length]?.role === "user"
      && resume.history.every((hash, index) => incoming[index] === hash)
      && input.request.messages.slice(resume.history.length).every((message) => message.role === "user")) {
      try {
        const resumed = await server.request<{ thread: { id: string } }>("thread/resume", {
          threadId: resume.threadId, cwd, model: route.model, approvalPolicy: "never", sandbox: "read-only",
          config: threadConfig, excludeTurns: true,
        });
        live.threadId = resumed.thread.id;
        live.registered = new Map(resume.registered);
        live.advertised = new Set(resume.advertised);
        live.schemas = new Map(resume.schemas);
        live.sent = true;
        this.logger.info("codex_thread_resumed", { account, threadId: live.threadId });
        return;
      } catch (error) {
        this.logger.warn("codex_thread_resume_failed", { account, threadId: resume.threadId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const droidPrompt = systemText(input.request.system).trim();
    // A tool-free request (title and summary helpers, tool_choice none) gets no tools at all.
    const toolsAllowed = hostAllowsAnyTools(input.request);
    const advertised = toolsAllowed ? input.request.tools ?? [] : [];
    const advertisedNames = new Set(advertised.map((tool) => tool.name));
    // Droid loads deferred tools (FetchUrl, WebSearch, ...) mid-thread with ToolSearch,
    // but Codex takes dynamic tools only here, so they are registered now and gated by
    // toolRefusal until Droid loads them. Codex's deferLoading is not used: codex-cli
    // 0.165.0 fails thread/start with "deferred dynamic tool must include a namespace"
    // for a top-level deferred tool.
    const deferred = toolsAllowed ? deferredToolDefinitions(input.request.messages, advertisedNames) : [];
    const mode = toolsAllowed ? FACTORY_MODE_TOOLS.filter((name) => !advertisedNames.has(name) && !deferred.some((tool) => tool.name === name)).map(modePlaceholder) : [];
    live.registered = new Map([
      ...advertised.map((tool) => [tool.name, "advertised"] as const),
      ...deferred.map((tool) => [tool.name, "deferred"] as const),
      ...mode.map((tool) => [tool.name, "mode"] as const),
    ]);
    const started = await server.request<{ thread: { id: string } }>("thread/start", {
      cwd, model: route.model, approvalPolicy: "never", sandbox: "read-only", serviceName: "factory-cc",
      // Droid's prompt replaces Codex's own 21k-char harness prompt (skills,
      // plugins, sub-agents, functions.exec) instead of sitting under it.
      ...(droidPrompt ? { baseInstructions: droidPrompt } : {}),
      developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
      // The read-only sandbox only bounds Codex's own built-in tools, which are off.
      // Codex still told the model so twice: "the sandbox only permits reading
      // files" (permissions instructions) and a read-only permission_profile in
      // <environment_context>. The model then refused to edit although Droid's
      // Edit/Create/Execute were right there. Droid sends its own environment
      // reminder (cwd, OS) and its prompt says what its tools may do.
      config: threadConfig,
      dynamicTools: [...advertised, ...deferred, ...mode].map(codexToolSpec),
    }).catch((error: unknown) => {
      // Codex answered and refused the thread (bad config or tool spec): retrying the
      // same request cannot help, and a 5xx made Droid retry it as a provider outage.
      if (error instanceof CodexRpcError && error.code !== undefined) {
        throw new BridgeError(400, "codex_thread_rejected", `Codex rejected the new thread: ${error.message}${account ? ` (Codex account ${account})` : ""}`);
      }
      throw error;
    });
    live.threadId = started.thread.id;
    live.advertised = advertisedNames;
    live.schemas = new Map(advertised.map((tool) => [tool.name, schemaKey(tool)]));
    this.logger.info("codex_thread_started", { account, model: route.model, threadId: live.threadId, tools: advertised.length, deferredTools: deferred.length + mode.length });
  }

  /** `-c mcp_servers.<name>.enabled=false` for each server in the account's config: Droid approves every action, and these would bypass it. */
  private mcpServersOff(home: string, account: string): string[] {
    const names = codexMcpServerNames(home);
    // Codex splits override keys on dots and keeps quotes literally, so a dotted name cannot be addressed.
    const unreachable = names.filter((name) => name.includes("."));
    if (unreachable.length) {
      this.logger.warn("codex_mcp_server_not_disabled", { account, servers: unreachable });
      this.deps.alerts?.alert(`codex-mcp-${account}`, "dswap: Codex MCP server left on",
        `Codex account ${account} has MCP servers the bridge cannot switch off (${unreachable.join(", ")}). Their tools would run without Droid's approval; rename them without dots.`);
    }
    return names.filter((name) => !name.includes(".")).map((name) => `mcp_servers.${name}.enabled=false`);
  }

  private async startTurn(live: LiveCodex, input: RuntimeRequest, model: string, notes: string[] = []): Promise<void> {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const droidInput = { ...input, droidPrompt: true };
    const blocks = !live.sent && input.request.messages.length > 1 ? buildInitialUserContent(droidInput, cwd) : buildDynamicUserContent(droidInput, cwd);
    const items = [...this.takeLateInput(live), ...notes.map((text) => ({ type: "text", text })), ...codexUserInput(blocks)];
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
      const refusal = this.toolRefusal(live, String(params.tool));
      if (refusal) return Promise.resolve({ contentItems: [{ type: "inputText", text: refusal }], success: false });
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

  /**
   * Why Codex may not make this call now, or undefined. Mirrors the Claude path's
   * per-request checks: Codex's tool list is fixed at thread/start, Droid's is not.
   */
  private toolRefusal(live: LiveCodex, tool: string): string | undefined {
    if (!hostAllowsAnyTools(live.request)) return "BRIDGE_HOST_TOOL_ACCESS_NONE: This host request permits no tools. Answer using the supplied conversation only.";
    if (live.cancelledTurn && live.cancelledTurn === live.turnId) return CANCELLED_TURN_DENIAL;
    if (live.advertised.has(tool)) return undefined;
    const kind = live.registered.get(tool);
    // Droid rejects a tool it has not loaded; say how to load it instead of a round trip.
    if (kind === "deferred") return `${tool} is not loaded yet. Call ToolSearch with query "select:${tool}" first, then call ${tool} again.`;
    if (kind === "mode") return `${tool} is not available now: Droid offers it only in its matching mode (spec mode, a Mission, or a question to the user). Use the tools Droid currently provides.`;
    return `BRIDGE_HOST_TOOL_NOT_ADVERTISED: ${tool} is not in Droid's current tool set. Use only the tools Droid currently provides; do not work around this restriction.`;
  }

  private notification(live: LiveCodex, method: string, params: any): void {
    if (live.ended) return;
    live.sink?.activity?.();
    if (method === "item/agentMessage/delta" && typeof params?.delta === "string") {
      if (typeof params.itemId === "string") live.streamed.add(params.itemId);
      this.appendText(live, params.delta, params.itemId);
    } else if (method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string" && !live.streamed.has(params.item.id)) {
      this.appendText(live, params.item.text, params.item.id);
    } else if (method === "thread/tokenUsage/updated") {
      const last = params?.tokenUsage?.last;
      // Codex's inputTokens include the cached ones (a rollout: 199112 input, 199040 cached);
      // Anthropic usage counts cache reads apart from input_tokens.
      if (last) {
        const cached = last.cachedInputTokens ?? 0;
        live.usage = { input_tokens: Math.max(0, (last.inputTokens ?? 0) - cached), output_tokens: last.outputTokens ?? 0, cache_read_input_tokens: cached, estimated: false };
      }
    } else if (method === "error" && params?.willRetry === false) {
      live.lastError = params?.error;
    } else if (method === "turn/completed") {
      live.turnId = undefined;
      live.cancelledTurn = undefined;
      this.orphanPending(live);
      live.finishTurn?.({ status: params?.turn?.status ?? "completed", error: params?.turn?.error ?? undefined });
    }
  }

  private appendText(live: LiveCodex, text: string, itemId?: string): void {
    const last = live.blocks.at(-1);
    const newMessage = typeof itemId === "string" && live.textItem !== undefined && itemId !== live.textItem;
    if (typeof itemId === "string") live.textItem = itemId;
    if (last?.type === "text" && typeof last.text === "string") {
      // Separate agent messages would otherwise run together mid-sentence.
      if (newMessage && last.text && !last.text.endsWith("\n\n")) text = `\n\n${text}`;
      last.text += text;
    } else live.blocks.push({ type: "text", text });
    live.sink?.textDelta(text);
  }

  private armPark(live: LiveCodex): Promise<void> {
    return new Promise((resolve) => { live.releasePark = () => resolve(); });
  }

  private async finishOrPark(live: LiveCodex, input: RuntimeRequest, park: Promise<void>): Promise<RuntimeTurn> {
    if (live.pending.size) return this.toolTurn(live, input);
    const outcome = await Promise.race([park.then(() => undefined), live.turnDone!]);
    if (!outcome || live.pending.size) return this.toolTurn(live, input);
    if (outcome.status === "failed") throw this.turnError(live, outcome.error ?? live.lastError);
    if (outcome.status === "interrupted") throw new BridgeError(499, "cancelled", "Codex turn was interrupted");
    return this.turn(live, input, "end_turn");
  }

  /**
   * A failed turn as Droid's error. Limits and overload may be retried from history in a
   * new session (the app's upstream retry), but only when Droid owes no tool results and
   * no call is waiting to be sent: a fresh session would lose them.
   */
  private turnError(live: LiveCodex, error: TurnOutcome["error"]): BridgeError {
    const message = error?.message ?? "Codex turn failed";
    const info = error?.codexErrorInfo;
    const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
    const where = live.account ? ` (Codex account ${live.account})` : "";
    const retry: Record<string, Json> = !live.orphaned.size && !live.pending.size && !live.blocks.some((block) => block.type === "tool_use") ? { retry_from_history: true } : {};
    if (code === "usageLimitExceeded" || code === "rateLimitExceeded" || (!code && /usage limit|rate limit|429/i.test(message))) {
      if (live.account) this.limitedUntil.set(live.account, this.now() + LIMITED_ACCOUNT_MS);
      return new BridgeError(429, "rate_limit_error", `${message}${where}`, retry);
    }
    if (code === "serverOverloaded") return new BridgeError(529, "overloaded_error", `${message}${where}`, retry);
    if (code === "unauthorized") {
      const home = live.account ? codexAccountHome(live.account) : undefined;
      return new BridgeError(401, "authentication_error", `Codex is not logged in${where}. Log in again: ${home ? `CODEX_HOME=${home} ` : ""}codex login`);
    }
    return new BridgeError(502, "codex_turn_failed", `${message}${where}`);
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
    // Droid expects at least one block, as the Claude path always sends.
    const blocks: ContentBlock[] = live.blocks.length ? live.blocks : [{ type: "text", text: "" }];
    // Whatever arrives from here on belongs to the next response.
    live.blocks = [];
    return {
      response: assistantMessage(input.request.model, blocks, stop, live.usage ?? { input_tokens: 0, output_tokens: 0, estimated: true }),
      pendingToolIds: [...live.pending.keys()],
      sdkSessionId: live.threadId,
    };
  }

  /**
   * Record Droid's current tools. Returns a note for the model when Droid advertises a
   * tool this thread did not have before (the real schema of a loaded placeholder, or a
   * warning that Codex cannot call it in this thread), or changes a tool's input schema.
   * Removed tools need no note: toolRefusal turns their calls away.
   */
  private updateAdvertised(live: LiveCodex, input: RuntimeRequest): string | undefined {
    const tools = input.request.tools;
    if (!tools) return undefined;
    const threadStarted = Boolean(live.threadId);
    const added = threadStarted ? tools.filter((tool) => !live.advertised.has(tool.name)) : [];
    const changed = threadStarted ? tools.filter((tool) => live.advertised.has(tool.name) && live.schemas.get(tool.name) !== schemaKey(tool)) : [];
    live.advertised = new Set(tools.map((tool) => tool.name));
    live.schemas = new Map(tools.map((tool) => [tool.name, schemaKey(tool)]));
    const loaded = added.filter((tool) => live.registered.get(tool.name) === "deferred" || live.registered.get(tool.name) === "mode");
    const missing = added.filter((tool) => !live.registered.has(tool.name));
    if (missing.length) this.logger.warn("codex_tool_not_registered", { tools: missing.map((tool) => tool.name) });
    const lines = [
      ...loaded.map((tool) => `Droid loaded ${tool.name}; call it as tools.${tool.name}. ${tool.description ?? ""}\nInput schema: ${JSON.stringify(tool.input_schema ?? {})}`),
      ...changed.map((tool) => `Droid changed the input of ${tool.name}. Use this schema from now on, not the one you were given before:\n${JSON.stringify(tool.input_schema ?? {})}`),
      ...(missing.length ? [`Droid added ${missing.map((tool) => tool.name).join(", ")}, but this Codex thread cannot call ${missing.length > 1 ? "them" : "it"}: Codex fixes its tools when a thread starts.`] : []),
    ];
    return lines.length ? lines.join("\n\n") : undefined;
  }

  /**
   * New user content (a steering message, a reminder) and late results that arrive while
   * a turn runs go to that turn with turn/steer. If Codex refuses and a fresh tool result
   * is being returned, the content rides on that result, labeled, instead of vanishing.
   */
  private async steer(live: LiveCodex, input: RuntimeRequest, notes: string[], attach: Json[] | undefined): Promise<void> {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const user = codexUserInput(buildDynamicUserContent({ ...input, droidPrompt: true }, cwd, { includeContext: false }));
    const lateCount = live.lateResults.length;
    const items = [...lateInput(live.lateResults.slice(0, lateCount)), ...notes.map((text) => ({ type: "text", text })), ...user];
    if (!items.length) return;
    try {
      await live.server!.request("turn/steer", { threadId: live.threadId, input: items, expectedTurnId: live.turnId });
      live.lateResults.splice(0, lateCount);
      notes.length = 0;
      return;
    } catch (error) {
      this.logger.warn("codex_steer_failed", { threadId: live.threadId, message: error instanceof Error ? error.message : String(error) });
    }
    // The turn ended meanwhile: the next turn/start carries late results, notes and user content.
    if (!live.turnId) return;
    if (attach) {
      attach.push({ type: "inputText", text: "Droid sent this with the tool result (it is not tool output):" }, ...items.map(toolOutputItem));
      live.lateResults.splice(0, lateCount);
      notes.length = 0;
      return;
    }
    throw new BridgeError(409, "codex_steer_failed", "Codex refused new input for its running turn, and no tool result could carry it.");
  }

  /** Late results are removed as they are sent, so each reaches the model once. */
  private takeLateInput(live: LiveCodex): Json[] {
    return lateInput(live.lateResults.splice(0));
  }

  /** Codex fails calls still running when its turn ends; Droid will still answer them. */
  private orphanPending(live: LiveCodex): void {
    for (const [id, pending] of live.pending) {
      live.orphaned.set(id, { name: pending.name, input: pending.input });
      pending.resolve({ contentItems: [{ type: "inputText", text: "The turn ended before Droid returned this result." }], success: false });
    }
    live.pending.clear();
  }

  /** Calls Droid never received (their response was dropped) will never be answered. */
  private dropUnsentCalls(live: LiveCodex): void {
    for (const block of live.blocks) {
      if (block.type === "tool_use" && typeof block.id === "string") live.orphaned.delete(block.id);
    }
    live.blocks = [];
  }

  private acceptTool(sessionId: string, toolUseId: string, content: string | ContentBlock[], isError?: boolean): "accepted" | "duplicate" {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live Codex thread owns these tool results");
    return this.resolvePending(live, toolUseId, content, isError) ? "accepted" : "duplicate";
  }

  private resolvePending(live: LiveCodex, toolUseId: string, content: string | ContentBlock[] | undefined, isError?: boolean, extra: Json[] = []): boolean {
    const id = canonicalToolUseId(toolUseId);
    const cancelled = isUserCancellation(content, isError);
    if (cancelled) live.resumeUnsafe = true;
    const pending = live.pending.get(id);
    if (pending) {
      live.pending.delete(id);
      live.settled.add(id);
      // Like the Claude path: the model is told not to retry, and further calls in this turn are refused.
      if (cancelled) live.cancelledTurn = live.turnId;
      pending.resolve({ contentItems: [...codexToolOutput(content), ...(cancelled ? [{ type: "inputText", text: CANCELLED_TOOL_NOTE }] : []), ...extra], success: !isError });
      return true;
    }
    const orphan = live.orphaned.get(id);
    if (orphan !== undefined) {
      live.orphaned.delete(id);
      live.settled.add(id);
      live.lateResults.push({ id, name: orphan.name, content: content ?? "", isError, cancelled });
      return true;
    }
    if (!live.settled.has(id)) this.logger.warn("codex_unknown_tool_result", { threadId: live.threadId, toolUseId: id });
    return false;
  }
}

function lateInput(results: LiveCodex["lateResults"]): Json[] {
  return results.flatMap((result) => [
    { type: "text", text: `${result.name} (call ${result.id}) returned after your earlier turn ended${result.isError ? ", with an error" : ""}. Its result:` },
    ...codexToolOutput(result.content).map(fromToolOutputItem),
    ...(result.cancelled ? [{ type: "text", text: CANCELLED_TOOL_NOTE }] : []),
  ]);
}

/** A placeholder for a Factory mode tool; its real schema arrives when Droid advertises it. */
function modePlaceholder(name: string): ToolDefinition {
  return {
    name, description: "Factory mode tool. Droid offers it only in its matching mode (spec mode, a Mission, or a question to the user); its real schema is sent when Droid does.",
    input_schema: { type: "object", additionalProperties: true },
  };
}

function schemaKey(tool: ToolDefinition): string {
  return JSON.stringify(tool.input_schema ?? {});
}

function codexToolSpec(tool: ToolDefinition): Json {
  return {
    type: "function", name: tool.name, description: tool.description ?? tool.name,
    inputSchema: tool.input_schema ?? { type: "object", properties: {} },
  };
}

/** Droid user blocks -> Codex UserInput items. Documents and URL images have no Codex form. */
function codexUserInput(blocks: ContentBlock[]): Json[] {
  return blocks.flatMap((block): Json[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    const source = block.type === "image" ? (block as { source?: { type?: string; media_type?: string; data?: string } }).source : undefined;
    return source?.type === "base64" ? [{ type: "image", url: `data:${source.media_type};base64,${source.data}` }] : [];
  });
}

function fromToolOutputItem(item: Json): Json {
  const record = item as { type?: string; text?: string; imageUrl?: string };
  return record.type === "inputImage" ? { type: "image", url: record.imageUrl ?? "" } : { type: "text", text: record.text ?? "" };
}

function toolOutputItem(item: Json): Json {
  const record = item as { type?: string; text?: string; url?: string };
  return record.type === "image" ? { type: "inputImage", imageUrl: record.url ?? "" } : { type: "inputText", text: record.text ?? "" };
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
