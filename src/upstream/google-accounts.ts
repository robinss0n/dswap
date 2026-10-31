import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcpClient, type AcpClientOptions } from "../runtime/antigravity/acp-client.js";
import { BridgeError } from "../types.js";

/**
 * Google accounts run through Google's Antigravity ACP agent, signed in with
 * "Log in with Google" (Google AI Pro / Ultra plans). Each account is its own
 * GEMINI_HOME, so sign-ins never mix. Bridge never reads the saved token: it
 * only checks that the file exists, and asks the agent itself for plan, models
 * and limits (`/usage` is answered locally by the agent, without a model turn).
 */

const accountName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GOOGLE_AUTH_METHOD = "oauth-personal";
export const ANTIGRAVITY_PROTOCOL_VERSION = 1;

export function validGoogleAccount(name: string): boolean {
  return accountName.test(name) && name !== "auto";
}

export function googleAccountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_GOOGLE_ACCOUNTS_DIR ?? join(env.HOME ?? homedir(), ".local/share/factory-cc-accounts/google");
}

/** Installed by `dswap runtime google`; BRIDGE_ANTIGRAVITY_EXECUTABLE overrides it. */
export function antigravityRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".local/share/factory-cc-runtimes/antigravity");
}

export function antigravityExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_ANTIGRAVITY_EXECUTABLE ?? join(antigravityRuntimeDir(env), "current", process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par");
}

/** The Linux build drops to user `nobody` unless `--uid=` is empty (as the ACP registry launches it). */
export function antigravityArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "linux" ? ["--uid="] : [];
}

export interface GoogleAccountRef { name: string; home: string }

export function listGoogleAccounts(env: NodeJS.ProcessEnv = process.env): GoogleAccountRef[] {
  const dir = googleAccountsDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validGoogleAccount(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, home: join(dir, entry.name) }));
}

export function googleAccountHome(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const account = listGoogleAccounts(env).find((item) => item.name === name);
  if (!account) throw new BridgeError(400, "unknown_google_account", `No Google account named ${name}. Add it with: dswap add google ${name}`);
  return account.home;
}

/** Existence only; the token itself is never read. */
export function googleSignedIn(home: string): boolean {
  return existsSync(join(home, "antigravity-acp", "acp_token.json"));
}

/** Environment for one account's agent: its own home, file token storage, no ambient Google keys. */
export function antigravityEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|GOOGLE_GENAI_USE_VERTEXAI|GEMINI_HOME)$/.test(key)));
  return { ...clean, GEMINI_HOME: home, GEMINI_FORCE_FILE_STORAGE: "true" };
}

export function openAgent(home: string, options: Omit<AcpClientOptions, "executable"> & { executable?: string } = {}): AcpClient {
  return new AcpClient({ executable: antigravityExecutable(), args: antigravityArgs(), ...options, env: antigravityEnv(home, options.env) });
}

/**
 * The ACP client identity the bridge reports. Antigravity offers non-Gemini
 * models (Claude Sonnet/Opus, GPT-OSS) only to clients on its allowlist
 * (model_selection.supports_third_party_models: JetBrains, Android Studio,
 * Zed, Xcode); any other name gets the Gemini-only list. Zed is the client
 * whose ACP use matches the bridge's (no fs/terminal capabilities, MCP tools).
 */
export const ACP_CLIENT_INFO = { name: "zed", title: "Zed", version: "0.212.0" } as const;

export async function initializeAgent(client: AcpClient): Promise<any> {
  return client.request("initialize", {
    protocolVersion: ANTIGRAVITY_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: ACP_CLIENT_INFO,
  }, 120_000);
}

// ── limits ────────────────────────────────────────────────────────────────────
export interface QuotaWindow { usedPercent: number; resetsAt?: number }
export interface QuotaGroup { name: string; fiveHour?: QuotaWindow; weekly?: QuotaWindow; other: Array<{ name: string } & QuotaWindow> }

/** `Oct 02, 2026, 08:22 UTC` (the agent's format) as epoch ms. */
function parseReset(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}) UTC$/.exec(text.trim());
  if (!match) { const parsed = Date.parse(text); return Number.isNaN(parsed) ? undefined : parsed; }
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]!);
  return month < 0 ? undefined : Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]));
}

/** Parses the agent's `/usage` Markdown (Quota Limits section) into groups of windows. */
export function parseUsageReport(markdown: string): QuotaGroup[] {
  const groups: QuotaGroup[] = [];
  let inLimits = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (/^###\s/.test(line)) { inLimits = /quota limits/i.test(line); continue; }
    if (!inLimits) continue;
    const group = /^- \*\*(.+?)\*\*\s*$/.exec(line);
    if (group) { groups.push({ name: group[1]!, other: [] }); continue; }
    const bucket = /^\s+- \*\*(.+?):\*\*\s*(\d+)% remaining(?: \(resets (.+)\))?/.exec(line);
    const current = groups.at(-1);
    if (!bucket || !current) continue;
    const window: QuotaWindow = { usedPercent: Math.max(0, Math.min(100, 100 - Number(bucket[2]))), ...(parseReset(bucket[3]) ? { resetsAt: parseReset(bucket[3]) } : {}) };
    const name = bucket[1]!;
    if (/week/i.test(name) && !current.weekly) current.weekly = window;
    else if (/(5|five)[- ]?h|hour/i.test(name) && !current.fiveHour) current.fiveHour = window;
    else current.other.push({ name, ...window });
  }
  return groups;
}

export function usageError(markdown: string): string | undefined {
  return /Unable to retrieve quota status \((.+)\)/.exec(markdown)?.[1];
}

// ── status ────────────────────────────────────────────────────────────────────
export interface GoogleAccountStatus {
  name: string;
  home: string;
  status: "ok" | "limited" | "logged_out" | "error";
  plan?: string;
  /** The Gemini group (or the first group) of the account's limits. */
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  groups?: QuotaGroup[];
  models?: string[];
  detail?: string;
}

const probeCwd = (home: string) => { const dir = join(home, "probe"); mkdirSync(dir, { recursive: true }); return dir; };

/** Ask one account's own agent for its plan, models and limits. Sends no model prompt. */
export async function probeGoogleAccount(account: GoogleAccountRef,
  open: (home: string, onNotification: (method: string, params: any) => void) => AcpClient = (home, onNotification) => openAgent(home, { onNotification })): Promise<GoogleAccountStatus> {
  if (!googleSignedIn(account.home)) return { ...account, status: "logged_out" };
  let report = "";
  const client = open(account.home, (method, params) => {
    const update = params?.update;
    if (method === "session/update" && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") report += update.content.text;
  });
  try {
    await initializeAgent(client);
    // With a saved token this returns at once; a dead token would start an interactive sign-in, so keep it short.
    const auth = await client.request("authenticate", { methodId: GOOGLE_AUTH_METHOD }, 45_000);
    const plan = auth?._meta?.antigravity?.tier?.name || undefined;
    const session = await client.request("session/new", { cwd: probeCwd(account.home), mcpServers: [], _meta: { antigravity: { enabledTools: [] } } }, 120_000);
    const models: string[] = (session?.models?.availableModels ?? []).map((model: any) => model?.modelId).filter((id: unknown): id is string => typeof id === "string");
    await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "/usage" }] }, 60_000);
    const groups = parseUsageReport(report);
    const gemini = groups.find((group) => /gemini/i.test(group.name)) ?? groups[0];
    const spent = [gemini?.fiveHour, gemini?.weekly].some((window) => window && window.usedPercent >= 100);
    const problem = usageError(report);
    return {
      ...account, status: spent ? "limited" : "ok", ...(plan ? { plan } : {}), ...(models.length ? { models } : {}), ...(groups.length ? { groups } : {}),
      ...(gemini?.fiveHour ? { fiveHour: gemini.fiveHour } : {}), ...(gemini?.weekly ? { weekly: gemini.weekly } : {}),
      ...(problem ? { detail: `limits unavailable: ${problem}` } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "probe failed";
    return { ...account, status: /no answer|auth|sign|login|credential|token/i.test(message) ? "logged_out" : "error", detail: message };
  } finally {
    client.close();
  }
}

/** A one-line prompt on the account's last-listed (smallest) model, which starts its 5-hour window. No tools. */
export async function pingGoogleAccount(account: GoogleAccountRef, prompt: string,
  open: (home: string) => AcpClient = (home) => openAgent(home)): Promise<{ model?: string }> {
  const client = open(account.home);
  try {
    await initializeAgent(client);
    await client.request("authenticate", { methodId: GOOGLE_AUTH_METHOD }, 45_000);
    const session = await client.request("session/new", { cwd: probeCwd(account.home), mcpServers: [], _meta: { antigravity: { enabledTools: [] } } }, 120_000);
    const models: string[] = (session?.models?.availableModels ?? []).map((model: any) => model?.modelId).filter((id: unknown): id is string => typeof id === "string");
    const model = models.at(-1);
    if (model) await client.request("session/set_model", { sessionId: session.sessionId, modelId: model }, 30_000);
    await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] }, 120_000);
    return model ? { model } : {};
  } finally {
    client.close();
  }
}

/** Highest usage across both windows; accounts without numbers sort last. */
export function googleLoad(status: GoogleAccountStatus): number {
  const used = [status.fiveHour?.usedPercent, status.weekly?.usedPercent].filter((value): value is number => typeof value === "number");
  return used.length ? Math.max(...used) : 101;
}

export function pickGoogleAccount(statuses: GoogleAccountStatus[], exclude: ReadonlySet<string> = new Set()): string | undefined {
  const usable = statuses.filter((status) => status.status === "ok" && !exclude.has(status.name));
  usable.sort((a, b) => googleLoad(a) - googleLoad(b) || statuses.indexOf(a) - statuses.indexOf(b));
  return usable[0]?.name;
}
