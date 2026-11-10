import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAccounts } from "../src/upstream/cswap.js";
import { cswapExecutable } from "../src/upstream/cswap-runtime.js";
import { listCodexAccounts, probeCodexAccount } from "../src/upstream/codex-accounts.js";
import { listGoogleAccounts, pingGoogleAccount, probeGoogleAccount } from "../src/upstream/google-accounts.js";
import {
  PRIME_PROVIDERS, WINDOW_MS, decide, duration, globalPause, lastDroidActivity, loadPrimeConfig, loadPrimeState, needsProbe, parseQuiet,
  primeDir, primeLog, savePrimeConfig, savePrimeState, targetKey, windowIdle, type PrimeConfig, type PrimeProvider, type PrimeState, type PrimeTarget,
} from "../src/upstream/prime.js";
import { cachedProbe, forgetProbe } from "../src/upstream/probe-cache.js";
import { systemctl } from "./accounts.js";

const PROMPT = "Reply with just: OK";
export const PRIME_TIMER = "dswap-prime.timer";
const PRIME_SERVICE = "dswap-prime.service";
const unitDir = () => join(homedir(), ".config/systemd/user");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Keys that would bill an API instead of the subscription; a ping never inherits them. */
const API_KEYS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY)$/;
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !API_KEYS.test(key))), ...extra });
const workDir = () => { const dir = join(primeDir(), "work"); mkdirSync(dir, { recursive: true }); return dir; };
const ms = (value: number | undefined) => value === undefined ? undefined : value < 1e12 ? value * 1000 : value;

interface Row { target: PrimeTarget; ping: boolean; reason: string }

/** Every account with its 5-hour window. Codex and Google are only probed when their window may have ended. */
async function gather(config: PrimeConfig, state: PrimeState, now: number): Promise<{ targets: PrimeTarget[]; cached: Row[] }> {
  const targets: PrimeTarget[] = [], cached: Row[] = [];
  if (config.providers.claude) {
    try {
      for (const account of listAccounts()) {
        const five = account.usage?.fiveHour as { pct?: number; resetsAt?: string } | undefined, week = account.usage?.sevenDay;
        targets.push({
          provider: "claude", account: String(account.number), label: `claude ${account.number}${account.alias ? ` ${account.alias}` : ""}`,
          usable: account.usageStatus === "ok" && account.disabled !== true, problem: account.disabled ? "disabled" : account.usageStatus,
          ...(five ? { fiveHour: { usedPercent: five.pct, ...(five.resetsAt ? { resetsAt: Date.parse(five.resetsAt) } : {}) } } : {}),
          ...(typeof week?.pct === "number" ? { weekly: { usedPercent: week.pct } } : {}),
        });
      }
    } catch (error) { primeLog(`claude: ${error instanceof Error ? error.message : error}`); }
  }
  const remember = (target: PrimeTarget) => {
    const key = targetKey(target);
    state.lastProbe[key] = now;
    if (target.usable && !windowIdle(target.fiveHour, now)) state.runningUntil[key] = target.fiveHour!.resetsAt!;
    else delete state.runningUntil[key];
  };
  const skipCached = (provider: PrimeProvider, account: string) => {
    const key = `${provider}:${account}`;
    if (needsProbe(key, state, now)) return false;
    cached.push({ target: { provider, account, label: `${provider} ${account}`, usable: true }, ping: false, reason: `window running, resets in ${duration(state.runningUntil[key]! - now)}` });
    return true;
  };
  if (config.providers.codex) {
    for (const ref of listCodexAccounts()) {
      if (skipCached("codex", ref.name)) continue;
      const status = await cachedProbe(`codex-${ref.name}`, () => probeCodexAccount(ref), { keep: (result) => result.status !== "error" });
      const target: PrimeTarget = {
        provider: "codex", account: ref.name, label: `codex ${ref.name}`, usable: status.status !== "logged_out" && status.status !== "error" && !!status.fiveHour,
        problem: status.fiveHour || status.status !== "ok" ? status.detail ?? status.status : "no 5-hour limit on this login",
        ...(status.fiveHour ? { fiveHour: { usedPercent: status.fiveHour.usedPercent, resetsAt: ms(status.fiveHour.resetsAt) } } : {}),
        ...(status.weekly ? { weekly: { usedPercent: status.weekly.usedPercent } } : {}),
      };
      remember(target);
      targets.push(target);
    }
  }
  if (config.providers.google) {
    for (const ref of listGoogleAccounts()) {
      if (skipCached("google", ref.name)) continue;
      const status = await cachedProbe(`google-${ref.name}`, () => probeGoogleAccount(ref), { keep: (result) => result.status !== "error" });
      const target: PrimeTarget = {
        provider: "google", account: ref.name, label: `google ${ref.name}`, usable: status.status !== "logged_out" && status.status !== "error" && !!status.fiveHour,
        problem: status.fiveHour || status.status !== "ok" ? status.detail ?? status.status : "no 5-hour limit on this plan",
        ...(status.fiveHour ? { fiveHour: status.fiveHour } : {}), ...(status.weekly ? { weekly: { usedPercent: status.weekly.usedPercent } } : {}),
      };
      remember(target);
      targets.push(target);
    }
  }
  return { targets, cached };
}

/** Sends the one-line prompt as that account; returns the model used. */
async function ping(target: PrimeTarget): Promise<string> {
  if (target.provider === "claude") {
    const result = spawnSync(cswapExecutable(), ["run", target.account, "--", "-p", PROMPT, "--model", "haiku", "--no-session-persistence"],
      { cwd: workDir(), env: cleanEnv(), encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "claude did not answer").trim().split("\n").at(-1));
    return "haiku";
  }
  if (target.provider === "codex") {
    const home = listCodexAccounts().find((account) => account.name === target.account)?.home;
    if (!home) throw new Error(`no Codex account ${target.account}`);
    const result = spawnSync(process.env.BRIDGE_CODEX_EXECUTABLE ?? "codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-C", workDir(), "-c", "model_reasoning_effort=\"low\"", PROMPT],
      { env: cleanEnv({ CODEX_HOME: home }), encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "codex did not answer").trim().split("\n").at(-1));
    return "default model, low effort";
  }
  const ref = listGoogleAccounts().find((account) => account.name === target.account);
  if (!ref) throw new Error(`no Google account ${target.account}`);
  return (await pingGoogleAccount(ref, PROMPT)).model ?? "default model";
}

/** One pass: decide for every account and ping the ones whose window is not running. */
export async function primeOnce(options: { dryRun?: boolean; force?: boolean; service?: boolean } = {}): Promise<Row[]> {
  const config = loadPrimeConfig(), state = loadPrimeState(), now = Date.now();
  const pause = options.force ? undefined : globalPause(config, new Date(now), lastDroidActivity());
  if (pause) {
    if (options.service && !options.dryRun) primeLog(`paused: ${pause}`);
    if (!options.service) process.stdout.write(`Not priming now: ${pause}.\n`);
    return [];
  }
  const { targets, cached } = await gather(config, state, now);
  const rows: Row[] = [...cached];
  for (const target of targets) {
    const decision = decide(target, state, config, now);
    rows.push({ target, ...decision });
    if (!decision.ping || options.dryRun) continue;
    const key = targetKey(target);
    try {
      const model = await ping(target);
      state.lastPing[key] = Date.now();
      state.runningUntil[key] = Date.now() + WINDOW_MS;
      forgetProbe(`${target.provider}-${target.account}`);
      primeLog(`primed ${target.label} (${decision.reason}, ${model}); next reset ~${new Date(Date.now() + WINDOW_MS).toTimeString().slice(0, 5)}`);
    } catch (error) {
      // Counts as a ping so a failing account is retried once per window, not every 5 minutes.
      state.lastPing[key] = Date.now();
      primeLog(`failed to prime ${target.label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  savePrimeState(state);
  if (!options.service) {
    const width = Math.max(...rows.map((row) => row.target.label.length), 8);
    for (const row of rows) process.stdout.write(`${row.target.label.padEnd(width)}  ${row.ping ? (options.dryRun ? "would ping" : "pinged") : "skip"}  ${row.reason}\n`);
    if (!rows.length) process.stdout.write("No accounts to prime.\n");
  }
  return rows;
}

// ── service ───────────────────────────────────────────────────────────────────
export function primeUnits(node: string, path: string): { service: string; timer: string } {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return {
    service: `[Unit]
Description=dswap window priming (starts each account's 5-hour window as soon as the last one ends)

[Service]
Type=oneshot
ExecStart=${quote(node)} ${quote(join(REPO, "node_modules/tsx/dist/cli.mjs"))} ${quote(join(REPO, "scripts/accounts.ts"))} prime --service
Environment=${quote(`PATH=${path}`)}
`,
    timer: `[Unit]
Description=dswap window priming every 5 minutes (catches up after sleep)

[Timer]
OnStartupSec=30s
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export type PrimeServiceState = "on" | "off" | "unsupported";
export function primeServiceState(): PrimeServiceState {
  if (process.platform !== "linux") return "unsupported";
  return systemctl(["is-active", "--quiet", PRIME_TIMER], true) === 0 ? "on" : "off";
}

function describe(config: PrimeConfig): string {
  const providers = PRIME_PROVIDERS.filter((provider) => config.providers[provider]).join(", ") || "none";
  return `accounts: ${providers} · quiet: ${config.quiet ?? "none"} · pause after ${config.idleHours === undefined ? "never" : `${config.idleHours}h without Droid`} · skip at week ≥ ${config.weeklyCap}%`;
}

export const PRIME_USAGE = [
  "Usage: dswap prime                   ping every account whose 5-hour window is not running (keeps resets early)",
  "       dswap prime --dry-run         show what would be pinged",
  "       dswap prime --force           ignore quiet hours and the away pause",
  "       dswap prime on|off|status     run it every 5 minutes in the background (systemd user timer)",
  "       dswap prime quiet 3-5|off     no pings in these local hours",
  "       dswap prime idle 8|off        pause after this many hours without Droid use",
  "       dswap prime cap 90            skip accounts whose week is at least this full",
  "       dswap prime only claude,codex,google",
  "       dswap prime server <ssh-name>|off  show (and toggle with P) priming on that machine in the dashboard",
  "       dswap prime server            priming state on that machine",
].join("\n");

async function primeServerCommand(value: string | undefined): Promise<number> {
  const { loadSettings, saveSettings } = await import("./dswap-tui.js");
  if (value === "off") { saveSettings({ primeServer: undefined }); process.stdout.write("No priming server.\n"); return 0; }
  if (value) {
    if (!/^[A-Za-z0-9._@-]+$/.test(value)) throw new Error("dswap prime server takes an SSH host name, e.g. my-server.");
    saveSettings({ primeServer: value });
  }
  const host = loadSettings().primeServer;
  if (!host) { process.stdout.write("No priming server. Set one with: dswap prime server <ssh-name>\n"); return 0; }
  const { fetchRemotePrime } = await import("../src/upstream/remote-prime.js");
  const remote = await fetchRemotePrime(host);
  process.stdout.write(`${host}: priming ${remote.state}${remote.detail ? ` (${remote.detail})` : ""}\n`);
  for (const line of remote.log.slice(-5)) process.stdout.write(`  ${line}\n`);
  if (remote.state === "on" && primeServiceState() === "on") process.stdout.write(`Priming is on here and on ${host}; one is enough (dswap prime off).\n`);
  return 0;
}

export async function prime(args: string[]): Promise<number> {
  const [action, value] = args;
  const config = loadPrimeConfig();
  if (!action || action.startsWith("--")) { await primeOnce({ dryRun: args.includes("--dry-run"), force: args.includes("--force"), service: args.includes("--service") }); return 0; }
  if (action === "help") { process.stdout.write(`${PRIME_USAGE}\n`); return 0; }
  if (action === "server") return primeServerCommand(value);
  if (action === "quiet" && value) { config.quiet = value === "off" ? undefined : parseQuiet(value); }
  else if (action === "idle" && value) {
    const hours = Number(value);
    if (value !== "off" && !(hours > 0)) throw new Error("dswap prime idle takes hours, e.g. 8, or off.");
    config.idleHours = value === "off" ? undefined : hours;
  } else if (action === "cap" && value) {
    const cap = Number(value);
    if (!(cap > 0 && cap <= 100)) throw new Error("dswap prime cap takes a percent from 1 to 100.");
    config.weeklyCap = cap;
  } else if (action === "only" && value) {
    const chosen = value.split(",").map((item) => item.trim());
    const unknown = chosen.filter((item) => !PRIME_PROVIDERS.includes(item as PrimeProvider));
    if (unknown.length) throw new Error(`Unknown provider ${unknown.join(", ")}; use claude, codex, google.`);
    config.providers = { claude: chosen.includes("claude"), codex: chosen.includes("codex"), google: chosen.includes("google") };
  } else if (action === "on") {
    if (process.platform !== "linux") throw new Error("dswap prime on uses a systemd user timer and needs Linux.");
    const units = primeUnits(process.execPath, process.env.PATH ?? "/usr/bin:/bin");
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), PRIME_SERVICE), units.service, { mode: 0o644 });
    writeFileSync(join(unitDir(), PRIME_TIMER), units.timer, { mode: 0o644 });
    if (systemctl(["daemon-reload"]) !== 0 || systemctl(["enable", "--now", PRIME_TIMER]) !== 0) throw new Error("systemctl could not start the priming timer.");
    process.stderr.write(`Priming is on: every 5 minutes, and right after the computer wakes. ${describe(config)}\nLog: ${join(primeDir(), "prime.log")}\n`);
    return 0;
  } else if (action === "off") {
    systemctl(["disable", "--now", PRIME_TIMER], true);
    for (const unit of [PRIME_TIMER, PRIME_SERVICE]) rmSync(join(unitDir(), unit), { force: true });
    systemctl(["daemon-reload"], true);
    process.stderr.write("Priming is off.\n");
    return 0;
  } else if (action === "status") {
    process.stdout.write(`priming: ${primeServiceState()}\n${describe(config)}\n`);
    const state = loadPrimeState();
    for (const [key, at] of Object.entries(state.lastPing)) process.stdout.write(`  last ping ${key}: ${duration(Date.now() - at)} ago\n`);
    if (existsSync(join(primeDir(), "prime.log"))) process.stdout.write(`log: ${join(primeDir(), "prime.log")}\n`);
    return 0;
  } else { process.stdout.write(`${PRIME_USAGE}\n`); return 2; }
  savePrimeConfig(config);
  process.stdout.write(`${describe(config)}\n`);
  return 0;
}
