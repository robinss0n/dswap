import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { listAccounts } from "../src/upstream/cswap.js";
import { codexAccountsDir, listCodexAccounts, probeCodexAccount, validCodexAccount, DEFAULT_CODEX_ACCOUNT, type CodexAccountStatus } from "../src/upstream/codex-accounts.js";
import { listGoogleAccounts, probeGoogleAccount, type GoogleAccountStatus } from "../src/upstream/google-accounts.js";

/**
 * One overview of every account the Bridge can route to (`dswap`, or `npm run accounts --`).
 * In a terminal, bare `dswap` opens the dashboard (scripts/dswap-tui.ts); piped, it prints the table.
 * Every dashboard action is also a subcommand; see `dswap help`.
 * Claude accounts are stored by cswap; these commands only call it.
 */

export type Provider = "claude" | "codex" | "google";

/** One account as both the table and the dashboard show it. `selector` is what the CLI takes. */
export interface Account {
  provider: Provider;
  selector: string;
  label: string;
  email: string;
  plan: string;
  fiveHour?: number;
  weekly?: number;
  /** Time until the window that limits this account resets, e.g. `2d 6h`. */
  resets?: string;
  fiveHourResets?: string;
  weeklyResets?: string;
  status: string;
  detail?: string;
  active?: boolean;
  disabled?: boolean;
}

export interface AccountRow { provider: string; account: string; email: string; plan: string; fiveHour: string; weekly: string; resets: string; status: string }

const pct = (value?: number) => value === undefined ? "-" : `${Math.round(value)}%`;

export function countdown(resetsAtMs: number | undefined, now = Date.now()): string | undefined {
  if (resetsAtMs === undefined || Number.isNaN(resetsAtMs)) return undefined;
  const minutes = Math.max(0, Math.round((resetsAtMs - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** The reset that matters: a spent window first, otherwise the busier one. Idle accounts show none. */
function bindingReset(windows: Array<{ used?: number; resetsAtMs?: number }>, now: number): string | undefined {
  const known = windows.filter((window) => window.used !== undefined && window.resetsAtMs !== undefined);
  const spent = known.find((window) => window.used! >= 100);
  if (spent) return countdown(spent.resetsAtMs, now);
  const busiest = known.filter((window) => window.used! > 0).sort((a, b) => b.used! - a.used!)[0];
  return busiest ? countdown(busiest.resetsAtMs, now) : undefined;
}

export function claudeAccounts(accounts: ReturnType<typeof listAccounts>, now = Date.now()): Account[] {
  return accounts.map((account: any) => {
    const five = account.usage?.fiveHour, week = account.usage?.sevenDay;
    const used = Math.max(five?.pct ?? 0, week?.pct ?? 0);
    const status = account.disabled ? "disabled" : account.usageStatus === "ok" && used >= 100 ? "limited" : account.usageStatus ?? "unknown";
    const windows = [{ used: five?.pct, resetsAtMs: five?.resetsAt ? Date.parse(five.resetsAt) : undefined },
      { used: week?.pct, resetsAtMs: week?.resetsAt ? Date.parse(week.resetsAt) : undefined }];
    const resets = bindingReset(windows, now);
    const fiveHourResets = countdown(windows[0]!.resetsAtMs, now), weeklyResets = countdown(windows[1]!.resetsAtMs, now);
    return {
      provider: "claude", selector: String(account.number), label: account.alias ? `${account.number} ${account.alias}` : String(account.number),
      email: account.email ?? "", plan: account.organizationName ?? "",
      ...(typeof five?.pct === "number" ? { fiveHour: five.pct } : {}), ...(typeof week?.pct === "number" ? { weekly: week.pct } : {}),
      ...(resets ? { resets } : {}), ...(fiveHourResets ? { fiveHourResets } : {}), ...(weeklyResets ? { weeklyResets } : {}), status,
      ...(account.usageStatus === "relogin_required" ? { detail: "login expired: log in again, then cswap stores it" } : {}),
      active: account.active === true, disabled: account.disabled === true,
    } satisfies Account;
  });
}

export function codexAccounts(statuses: CodexAccountStatus[], now = Date.now()): Account[] {
  return statuses.map((status) => {
    const windows = [status.fiveHour, status.weekly].map((window) => ({ used: window?.usedPercent, resetsAtMs: window?.resetsAt ? window.resetsAt * 1000 : undefined }));
    const resets = bindingReset(windows, now);
    const fiveHourResets = countdown(windows[0]!.resetsAtMs, now), weeklyResets = countdown(windows[1]!.resetsAtMs, now);
    return {
      provider: "codex", selector: status.name, label: status.name, email: status.email ?? "", plan: status.plan ?? "",
      ...(status.fiveHour ? { fiveHour: status.fiveHour.usedPercent } : {}), ...(status.weekly ? { weekly: status.weekly.usedPercent } : {}),
      ...(resets ? { resets } : {}), ...(fiveHourResets ? { fiveHourResets } : {}), ...(weeklyResets ? { weeklyResets } : {}), status: status.status,
      ...(status.detail ? { detail: status.detail } : {}),
    } satisfies Account;
  });
}

export function googleAccounts(statuses: GoogleAccountStatus[], now = Date.now()): Account[] {
  return statuses.map((status) => {
    const windows = [status.fiveHour, status.weekly].map((window) => ({ used: window?.usedPercent, resetsAtMs: window?.resetsAt }));
    const resets = bindingReset(windows, now);
    const fiveHourResets = countdown(windows[0]!.resetsAtMs, now), weeklyResets = countdown(windows[1]!.resetsAtMs, now);
    const others = (status.groups ?? []).filter((group) => !/gemini/i.test(group.name))
      .map((group) => `${group.name}: ${[group.fiveHour && `5h ${Math.round(group.fiveHour.usedPercent)}%`, group.weekly && `week ${Math.round(group.weekly.usedPercent)}%`].filter(Boolean).join(" · ") || "-"}`);
    const detail = [status.detail, ...others].filter(Boolean).join(" · ");
    return {
      provider: "google", selector: status.name, label: status.name, email: "", plan: status.plan ?? "",
      ...(status.fiveHour ? { fiveHour: status.fiveHour.usedPercent } : {}), ...(status.weekly ? { weekly: status.weekly.usedPercent } : {}),
      ...(resets ? { resets } : {}), ...(fiveHourResets ? { fiveHourResets } : {}), ...(weeklyResets ? { weeklyResets } : {}), status: status.status,
      ...(detail ? { detail } : {}),
    } satisfies Account;
  });
}

export function toRow(account: Account): AccountRow {
  return {
    provider: account.provider, account: account.label, email: account.email, plan: account.plan,
    fiveHour: pct(account.fiveHour), weekly: pct(account.weekly), resets: account.resets ?? "",
    status: account.status === "error" ? `error: ${account.detail ?? ""}`.trim() : account.active ? `${account.status} (active)` : account.status,
  };
}

export const claudeRows = (accounts: ReturnType<typeof listAccounts>): AccountRow[] => claudeAccounts(accounts).map(toRow);
export const codexRows = (statuses: CodexAccountStatus[]): AccountRow[] => codexAccounts(statuses).map(toRow);

export function renderTable(rows: AccountRow[]): string {
  const header: AccountRow = { provider: "PROVIDER", account: "ACCOUNT", email: "EMAIL", plan: "PLAN", fiveHour: "5H", weekly: "WEEK", resets: "RESETS", status: "STATUS" };
  const keys = Object.keys(header) as Array<keyof AccountRow>;
  const width = Object.fromEntries(keys.map((key) => [key, Math.max(...[header, ...rows].map((row) => row[key].length))]));
  return [header, ...rows].map((row) => keys.map((key) => row[key].padEnd(width[key]!)).join("  ").trimEnd()).join("\n") + "\n";
}

export function loadClaude(): Account[] {
  try { return claudeAccounts(listAccounts()); }
  catch { return [{ provider: "claude", selector: "-", label: "-", email: "", plan: "", status: "cswap unavailable" }]; }
}

export async function loadCodex(): Promise<Account[]> {
  return codexAccounts(await Promise.all(listCodexAccounts().map((account) => probeCodexAccount(account))));
}

export async function loadGoogle(): Promise<Account[]> {
  return googleAccounts(await Promise.all(listGoogleAccounts().map((account) => probeGoogleAccount(account))));
}

async function overview(json: boolean): Promise<void> {
  const [codex, google] = await Promise.all([loadCodex(), loadGoogle()]);
  const accounts = [...loadClaude(), ...codex, ...google];
  process.stdout.write(json ? `${JSON.stringify(accounts.map((account) => ({ ...toRow(account), ...account })), null, 2)}\n` : renderTable(accounts.map(toRow)));
}

export function addCodex(name: string): number {
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

export function loginCodex(name = DEFAULT_CODEX_ACCOUNT): number {
  const account = listCodexAccounts().find((item) => item.name === name);
  if (!account) throw new Error(`No Codex account named ${name}. Add it with: dswap add codex ${name}`);
  process.stderr.write(`Logging in Codex account ${name} again (CODEX_HOME=${account.home}).\n`);
  if (!run(process.env.BRIDGE_CODEX_EXECUTABLE ?? "codex", ["login"], { ...process.env, CODEX_HOME: account.home })) throw new Error("codex login did not finish.");
  return 0;
}

export function removeCodex(name: string): number {
  if (name === DEFAULT_CODEX_ACCOUNT) throw new Error("`default` is your normal ~/.codex login; log it out with `codex logout` instead.");
  const account = listCodexAccounts().find((item) => item.name === name);
  if (!account) throw new Error(`No Codex account named ${name}.`);
  rmSync(account.home, { recursive: true, force: true });
  process.stderr.write(`Removed Codex account ${name}.\n`);
  return 0;
}

const cswapCommand = () => process.env.BRIDGE_CSWAP_EXECUTABLE ?? "cswap";

/**
 * Runs a quick cswap command. `capture` keeps the output off the terminal (the dashboard
 * owns it) and returns cswap's last line; stdin is closed so a prompt fails instead of hanging.
 */
export function cswap(args: string[], capture = false): string {
  if (!capture) {
    if (!run(cswapCommand(), args)) throw new Error(`cswap ${args.join(" ")} failed.`);
    return "";
  }
  const result = spawnSync(cswapCommand(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").map((line) => line.trim())
    .filter((line) => line && !/newer version of claude-swap/i.test(line));
  if (result.status !== 0) throw new Error(lines.at(-1) ?? `cswap ${args.join(" ")} failed.`);
  return lines.at(-1) ?? "";
}

/** cswap stores Claude accounts: log in with Claude Code, then let cswap add or renew that account. */
export function loginClaude(): number {
  process.stderr.write("Step 1/2: log in with Claude Code. Pick the account you want to add or renew.\n");
  if (!run(process.env.BRIDGE_CLAUDE_EXECUTABLE ?? "claude", ["auth", "login"])) throw new Error("claude auth login did not finish; cswap was not changed.");
  process.stderr.write("Step 2/2: storing it in cswap.\n");
  if (!run(cswapCommand(), ["add"])) throw new Error("cswap add failed.");
  return 0;
}

export const AUTO_UNIT = "cswap-auto.service";
const autoUnitPath = () => join(homedir(), ".config/systemd/user", AUTO_UNIT);

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

export type AutoState = "on" | "installed" | "off" | "unsupported";

export function autoState(): AutoState {
  if (process.platform !== "linux") return "unsupported";
  if (systemctl(["is-active", "--quiet", AUTO_UNIT], true) === 0) return "on";
  return existsSync(autoUnitPath()) ? "installed" : "off";
}

/** Recent `cswap auto` log lines (`HH:MM:SS  message`), newest last; empty when the service never ran. */
export function autoLog(lines = 40): string[] {
  if (process.platform !== "linux") return [];
  const result = spawnSync("journalctl", ["--user", "-u", AUTO_UNIT, "-n", String(lines), "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.split("\n").filter((line) => /^\d\d:\d\d:\d\d\s/.test(line)) : [];
}

/** `cswap auto` swaps ~/.claude's login while Claude Code keeps running, so bridge sessions on the plain models switch in place. */
export function auto(action?: string): number {
  if (process.platform !== "linux") throw new Error("dswap auto uses a systemd user service and needs Linux.");
  const unit = autoUnitPath();
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
    const state = autoState();
    process.stdout.write(`cswap auto: ${state === "installed" ? "installed but not running" : state}\n`);
    if (state === "on") spawnSync("journalctl", ["--user", "-u", AUTO_UNIT, "-n", "5", "--no-pager", "-o", "cat"], { stdio: "inherit" });
    return 0;
  }
  throw new Error("Usage: dswap auto on|off|status");
}

export const USAGE = [
  "Usage: dswap                          dashboard in a terminal (the table when piped); also: dswap tui",
  "       dswap demo                     the dashboard with made-up accounts (nothing runs)",
  "       dswap list [--json]            table of every account (--json: as JSON)",
  "       dswap switch [num|email|alias] make this the default Claude login (no account: next one)",
  "       dswap disable <num|email>      keep a Claude account out of rotation",
  "       dswap enable <num|email>       put it back",
  "       dswap alias <num|email> <name> short name for a Claude account (--unset to remove)",
  "       dswap login claude             add a Claude account or renew a dead one (claude auth login + cswap add)",
  "       dswap remove claude <num|email>",
  "       dswap add codex <name>         new Codex account (runs codex login)",
  "       dswap login codex [name]       log a Codex account in again (default: your ~/.codex)",
  "       dswap remove codex <name>",
  "       dswap add google <name>        new Google account (Google AI Pro / Ultra sign-in through Antigravity)",
  "       dswap login google <name>      sign a Google account in again",
  "       dswap remove google <name>",
  "       dswap rename google <old> <new>",
  "       dswap runtime google           install or update Google's Antigravity agent",
  "       dswap auto on|off|status       keep cswap auto running in the background (switches before a limit, same session)",
  "",
  "Claude commands also accept `claude` after the verb: dswap switch claude 4",
].join("\n");

class UsageError extends Error {}

export async function accounts(argv: string[], interactive = false): Promise<number> {
  const [action, ...rest] = argv;
  if ((!action && interactive) || action === "tui" || action === "ui" || action === "demo") {
    const { dashboard } = await import("./dswap-tui.js");
    const code = await dashboard({ demo: action === "demo" });
    // Codex probes still in flight would keep the process alive for up to their timeout.
    process.exit(code);
  }
  if (!action || action === "--json" || action === "list" || action === "ls") { await overview(action === "--json" || rest.includes("--json")); return 0; }
  if (action === "help" || action === "--help" || action === "-h") { process.stdout.write(`${USAGE}\n`); return 0; }
  if (action === "auto") return auto(rest[0]);

  const [provider, name] = rest;
  if (provider === "google" || (action === "runtime" && rest[0] === "google")) {
    const google = await import("./google.js");
    if (action === "runtime") { await google.installAntigravity(); return 0; }
    if (action === "add" && name) return google.loginGoogle(name, true);
    if (action === "login" && name) return google.loginGoogle(name, false);
    if ((action === "remove" || action === "rm") && name) return google.removeGoogle(name);
    if ((action === "rename" || action === "mv") && name && rest[2]) return google.renameGoogle(name, rest[2]);
  }
  if ((action === "add" || action === "remove") && provider === "codex" && name) return action === "add" ? addCodex(name) : removeCodex(name);
  if (action === "login" && provider === "codex") return loginCodex(name);
  if ((action === "login" || action === "add") && provider === "claude") return loginClaude();
  if ((action === "remove" || action === "rm") && provider === "claude" && name) { cswap(["remove", name]); return 0; }

  const quick = quickCswapArgs(argv);
  if (quick) { cswap(quick); return 0; }
  throw new UsageError(USAGE);
}

/** The Claude verbs that are one non-interactive cswap call (`claude` after the verb is optional), else undefined. */
export function quickCswapArgs(argv: string[]): string[] | undefined {
  const [action, ...rest] = argv;
  const args = rest[0] === "claude" ? rest.slice(1) : rest;
  if (action === "switch" || action === "use") return args[0] ? ["switch", args[0]] : ["switch"];
  if ((action === "enable" || action === "disable") && args[0]) return [action, args[0]];
  if (action === "alias" && args[0] && args[1]) return args[1] === "--unset" ? ["alias", args[0], "--unset"] : ["alias", args[0], args[1]];
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  accounts(process.argv.slice(2), process.stdout.isTTY === true && process.stdin.isTTY === true).then((code) => { process.exitCode = code; })
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : "accounts failed"); process.exitCode = error instanceof UsageError ? 2 : 1; });
}
