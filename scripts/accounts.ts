import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { listAccounts } from "../src/upstream/cswap.js";
import { codexAccountsDir, listCodexAccounts, probeCodexAccount, validCodexAccount, DEFAULT_CODEX_ACCOUNT, type CodexAccountStatus, type UsageWindow } from "../src/upstream/codex-accounts.js";

/**
 * One overview of every account the Bridge can route to.
 *   npm run accounts                     table of Claude (cswap), Codex and Google accounts
 *   npm run accounts -- --json           the same as JSON
 *   npm run accounts -- add codex <name> new Codex account; runs `codex login` in its own CODEX_HOME
 *   npm run accounts -- remove codex <name>
 *   npm run accounts -- login codex [name] log an existing Codex account in again (default: ~/.codex)
 *   npm run accounts -- login claude     `claude auth login`, then `cswap add`: adds a new account or renews a dead one
 *   npm run accounts -- remove claude <num|email>   `cswap remove`
 *   npm run accounts -- auto on|off|status  run `cswap auto` as a systemd user service (Linux)
 * Claude accounts are stored by cswap; these commands only call it.
 */

export interface AccountRow { provider: string; account: string; email: string; plan: string; fiveHour: string; weekly: string; status: string }

const pct = (value?: number) => value === undefined ? "-" : `${Math.round(value)}%`;
function resets(window?: UsageWindow): string {
  if (!window?.resetsAt || window.usedPercent < 100) return "";
  const minutes = Math.max(0, Math.round((window.resetsAt * 1000 - Date.now()) / 60_000));
  return minutes >= 120 ? ` (${Math.round(minutes / 60)}h)` : ` (${minutes}m)`;
}

export function claudeRows(accounts: ReturnType<typeof listAccounts>): AccountRow[] {
  return accounts.map((account: any) => ({
    provider: "claude", account: account.alias ? `${account.number} ${account.alias}` : String(account.number),
    email: account.email ?? "", plan: account.organizationName ?? "",
    fiveHour: pct(account.usage?.fiveHour?.pct), weekly: pct(account.usage?.sevenDay?.pct),
    status: account.disabled ? "disabled" : account.usageStatus === "ok" && Math.max(account.usage?.fiveHour?.pct ?? 0, account.usage?.sevenDay?.pct ?? 0) >= 100 ? "limited" : account.usageStatus ?? "unknown",
  }));
}

export function codexRows(statuses: CodexAccountStatus[]): AccountRow[] {
  return statuses.map((status) => ({
    provider: "codex", account: status.name, email: status.email ?? "", plan: status.plan ?? "",
    fiveHour: `${pct(status.fiveHour?.usedPercent)}${resets(status.fiveHour)}`, weekly: `${pct(status.weekly?.usedPercent)}${resets(status.weekly)}`,
    status: status.status === "error" ? `error: ${status.detail ?? ""}`.trim() : status.status,
  }));
}

export function renderTable(rows: AccountRow[]): string {
  const header: AccountRow = { provider: "PROVIDER", account: "ACCOUNT", email: "EMAIL", plan: "PLAN", fiveHour: "5H", weekly: "WEEK", status: "STATUS" };
  const keys = Object.keys(header) as Array<keyof AccountRow>;
  const width = Object.fromEntries(keys.map((key) => [key, Math.max(...[header, ...rows].map((row) => row[key].length))]));
  return [header, ...rows].map((row) => keys.map((key) => row[key].padEnd(width[key]!)).join("  ").trimEnd()).join("\n") + "\n";
}

async function overview(json: boolean): Promise<void> {
  let claude: AccountRow[];
  try { claude = claudeRows(listAccounts()); }
  catch { claude = [{ provider: "claude", account: "-", email: "", plan: "", fiveHour: "-", weekly: "-", status: "cswap unavailable" }]; }
  const codex = codexRows(await Promise.all(listCodexAccounts().map((account) => probeCodexAccount(account))));
  const google: AccountRow = { provider: "google", account: "-", email: "", plan: "", fiveHour: "-", weekly: "-", status: "not connected yet" };
  const rows = [...claude, ...codex, google];
  process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : renderTable(rows));
}

function addCodex(name: string): number {
  if (!validCodexAccount(name) || name === DEFAULT_CODEX_ACCOUNT) throw new Error("Account names use letters, digits, dot, dash or underscore, and `default` is your normal ~/.codex login.");
  const home = join(codexAccountsDir(), name);
  if (existsSync(home)) throw new Error(`Codex account ${name} already exists (${home}).`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  process.stderr.write(`Logging in Codex account ${name} (CODEX_HOME=${home}). Use the ChatGPT account you want for it.\n`);
  const result = spawnSync(process.env.BRIDGE_CODEX_EXECUTABLE ?? "codex", ["login"], { stdio: "inherit", env: { ...process.env, CODEX_HOME: home } });
  if (result.status !== 0) {
    rmSync(home, { recursive: true, force: true });
    throw new Error("codex login did not finish; nothing was kept.");
  }
  return 0;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return spawnSync(command, args, { stdio: "inherit", env }).status === 0;
}

function loginCodex(name = DEFAULT_CODEX_ACCOUNT): number {
  const account = listCodexAccounts().find((item) => item.name === name);
  if (!account) throw new Error(`No Codex account named ${name}. Add it with: dswap add codex ${name}`);
  process.stderr.write(`Logging in Codex account ${name} again (CODEX_HOME=${account.home}).\n`);
  if (!run(process.env.BRIDGE_CODEX_EXECUTABLE ?? "codex", ["login"], { ...process.env, CODEX_HOME: account.home })) throw new Error("codex login did not finish.");
  return 0;
}

/** cswap stores Claude accounts: log in with Claude Code, then let cswap add or renew that account. */
function loginClaude(): number {
  process.stderr.write("Step 1/2: log in with Claude Code. Pick the account you want to add or renew.\n");
  if (!run(process.env.BRIDGE_CLAUDE_EXECUTABLE ?? "claude", ["auth", "login"])) throw new Error("claude auth login did not finish; cswap was not changed.");
  process.stderr.write("Step 2/2: storing it in cswap.\n");
  if (!run(process.env.BRIDGE_CSWAP_EXECUTABLE ?? "cswap", ["add"])) throw new Error("cswap add failed.");
  return 0;
}

function removeClaude(selector: string): number {
  if (!run(process.env.BRIDGE_CSWAP_EXECUTABLE ?? "cswap", ["remove", selector])) throw new Error("cswap remove failed.");
  return 0;
}

const AUTO_UNIT = "cswap-auto.service";

/** systemctl --user needs the session bus; nothing else is passed through. */
function systemctl(args: string[], quiet = false): number {
  const env = { HOME: homedir(), PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
  return spawnSync("systemctl", ["--user", ...args], { stdio: quiet ? "ignore" : "inherit", env }).status ?? 1;
}

export function cswapAutoUnit(cswap: string, path: string): string {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return `[Unit]
Description=cswap auto-switch (moves the default Claude login off an account before it hits its limit)

[Service]
ExecStart=${quote(cswap)} auto
Environment=${quote(`PATH=${path}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** `cswap auto` swaps ~/.claude's login while Claude Code keeps running, so bridge sessions on the plain models switch in place. */
function auto(action?: string): number {
  if (process.platform !== "linux") throw new Error("dswap auto uses a systemd user service and needs Linux.");
  const unit = join(homedir(), ".config/systemd/user", AUTO_UNIT);
  if (action === "on") {
    const found = spawnSync("sh", ["-c", "command -v cswap"], { encoding: "utf8" });
    const cswap = found.stdout.trim();
    if (found.status !== 0 || !cswap) throw new Error("cswap is not on PATH.");
    mkdirSync(join(homedir(), ".config/systemd/user"), { recursive: true });
    writeFileSync(unit, cswapAutoUnit(cswap, process.env.PATH ?? "/usr/bin:/bin"), { mode: 0o644 });
    if (systemctl(["daemon-reload"]) !== 0 || systemctl(["enable", "--now", AUTO_UNIT]) !== 0) throw new Error("systemctl could not start cswap auto.");
    process.stderr.write("cswap auto is on: the default Claude login moves to the account with the most room at 90% use. Logs: journalctl --user -u cswap-auto\n");
    return 0;
  }
  if (action === "off") {
    systemctl(["disable", "--now", AUTO_UNIT], true);
    rmSync(unit, { force: true });
    systemctl(["daemon-reload"], true);
    process.stderr.write("cswap auto is off.\n");
    return 0;
  }
  if (action === undefined || action === "status") {
    const active = systemctl(["is-active", "--quiet", AUTO_UNIT], true) === 0;
    process.stdout.write(`cswap auto: ${active ? "on" : existsSync(unit) ? "installed but not running" : "off"}\n`);
    if (active) spawnSync("journalctl", ["--user", "-u", AUTO_UNIT, "-n", "5", "--no-pager", "-o", "cat"], { stdio: "inherit" });
    return 0;
  }
  throw new Error("Usage: dswap auto on|off|status");
}

function removeCodex(name: string): number {
  if (name === DEFAULT_CODEX_ACCOUNT) throw new Error("`default` is your normal ~/.codex login; log it out with `codex logout` instead.");
  const account = listCodexAccounts().find((item) => item.name === name);
  if (!account) throw new Error(`No Codex account named ${name}.`);
  rmSync(account.home, { recursive: true, force: true });
  process.stderr.write(`Removed Codex account ${name}.\n`);
  return 0;
}

export async function accounts(argv: string[]): Promise<number> {
  const [action, provider, name] = argv;
  if (!action || action === "--json") { await overview(action === "--json"); return 0; }
  if ((action === "add" || action === "remove") && provider === "codex" && name) return action === "add" ? addCodex(name) : removeCodex(name);
  if (action === "auto") return auto(provider);
  if (action === "login" && provider === "codex") return loginCodex(name);
  if ((action === "login" || action === "add") && provider === "claude") return loginClaude();
  if (action === "remove" && provider === "claude" && name) return removeClaude(name);
  throw new Error([
    "Usage: dswap                          overview of every account",
    "       dswap --json",
    "       dswap add codex <name>         new Codex account (runs codex login)",
    "       dswap login codex [name]       log a Codex account in again (default: your ~/.codex)",
    "       dswap remove codex <name>",
    "       dswap login claude             add a Claude account or renew a dead one (claude auth login + cswap add)",
    "       dswap remove claude <num|email>",
    "       dswap auto on|off|status       keep cswap auto running in the background (switches before a limit, same session)",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  accounts(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : "accounts failed"); process.exitCode = 1; });
}
