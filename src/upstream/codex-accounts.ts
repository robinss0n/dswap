import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../runtime/codex/app-server.js";
import { BridgeError } from "../types.js";
import { providerCliEnv } from "./auth-env.js";
import { cachedProbe } from "./probe-cache.js";

/**
 * Codex accounts: each one is its own CODEX_HOME with its own `codex login`.
 * `default` is your normal Codex login (~/.codex, or $CODEX_HOME). Extra
 * accounts live under the accounts directory, outside the Bridge state, so
 * uninstalling the Bridge never deletes a login. Bridge never reads auth.json;
 * Codex itself answers who is logged in and how much is left.
 */

export const DEFAULT_CODEX_ACCOUNT = "default";
const accountName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validCodexAccount(name: string): boolean {
  return accountName.test(name);
}

export function codexAccountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_CODEX_ACCOUNTS_DIR ?? join(env.HOME ?? homedir(), ".local/share/factory-cc-accounts/codex");
}

export interface CodexAccountRef { name: string; home: string }

export function listCodexAccounts(env: NodeJS.ProcessEnv = process.env): CodexAccountRef[] {
  const accounts: CodexAccountRef[] = [{ name: DEFAULT_CODEX_ACCOUNT, home: env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex") }];
  const dir = codexAccountsDir(env);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && validCodexAccount(entry.name) && entry.name !== DEFAULT_CODEX_ACCOUNT) accounts.push({ name: entry.name, home: join(dir, entry.name) });
    }
  }
  return accounts;
}

export function codexAccountHome(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const account = listCodexAccounts(env).find((item) => item.name === name);
  if (!account) throw new BridgeError(400, "unknown_codex_account", `No Codex account named ${name}. Add it with: npm run accounts -- add codex ${name}`);
  return account.home;
}

export interface UsageWindow { usedPercent: number; windowMins?: number; resetsAt?: number }
export interface CodexAccountStatus {
  name: string;
  home: string;
  status: "ok" | "limited" | "logged_out" | "error";
  email?: string;
  plan?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  detail?: string;
}

function window(value: any): UsageWindow | undefined {
  return value && typeof value.usedPercent === "number"
    ? { usedPercent: value.usedPercent, ...(typeof value.windowDurationMins === "number" ? { windowMins: value.windowDurationMins } : {}), ...(typeof value.resetsAt === "number" ? { resetsAt: value.resetsAt } : {}) }
    : undefined;
}

/** Ask one account's own Codex who is logged in and what its limits are. Sends no prompt. */
export async function probeCodexAccount(account: CodexAccountRef, open: (home: string) => CodexAppServer = (home) => new CodexAppServer({ codexHome: home, env: providerCliEnv(process.env) })): Promise<CodexAccountStatus> {
  const server = open(account.home);
  try {
    await server.initialize();
    const read = await server.request<{ account?: { type?: string; email?: string; planType?: string } | null }>("account/read", { refreshToken: false }, 20_000);
    if (!read.account) return { ...account, status: "logged_out" };
    const base = { ...account, ...(read.account.email ? { email: read.account.email } : {}), ...(read.account.planType ? { plan: read.account.planType } : {}) };
    if (read.account.type !== "chatgpt") return { ...base, status: "ok", detail: "API key login (no plan limits)" };
    const limits = await server.request<{ rateLimits?: any }>("account/rateLimits/read", undefined, 20_000);
    const fiveHour = window(limits.rateLimits?.primary), weekly = window(limits.rateLimits?.secondary);
    const spent = [fiveHour, weekly].some((item) => item && item.usedPercent >= 100);
    return { ...base, status: spent ? "limited" : "ok", ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
  } catch (error) {
    return { ...account, status: "error", detail: error instanceof Error ? error.message : "probe failed" };
  } finally {
    server.close();
  }
}

/** probeCodexAccount through the shared cache: `auto` would otherwise start one app-server per account for every new session. */
export function cachedCodexAccountStatus(account: CodexAccountRef, ttlMs = 60_000): Promise<CodexAccountStatus> {
  return cachedProbe(`codex-${account.name}`, () => probeCodexAccount(account), { ttlMs, keep: (status) => status.status !== "error" });
}

/**
 * Names of the MCP servers in an account's config.toml (`[mcp_servers.<name>]` tables).
 * Reads table headers only; config.toml holds no login.
 */
export function codexMcpServerNames(home: string): string[] {
  let text: string;
  try { text = readFileSync(join(home, "config.toml"), "utf8"); } catch { return []; }
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[\].]/gm)) {
    names.add(match[1] ?? match[2] ?? match[3]!);
  }
  return [...names];
}

/** Highest usage across both windows; accounts without numbers sort last. */
export function codexLoad(status: CodexAccountStatus): number {
  const used = [status.fiveHour?.usedPercent, status.weekly?.usedPercent].filter((value): value is number => typeof value === "number");
  return used.length ? Math.max(...used) : 101;
}

export function pickCodexAccount(statuses: CodexAccountStatus[], exclude: ReadonlySet<string> = new Set()): string | undefined {
  const usable = statuses.filter((status) => status.status === "ok" && !exclude.has(status.name));
  usable.sort((a, b) => codexLoad(a) - codexLoad(b) || listOrder(statuses, a) - listOrder(statuses, b));
  return usable[0]?.name;
}
const listOrder = (statuses: CodexAccountStatus[], status: CodexAccountStatus) => statuses.indexOf(status);
