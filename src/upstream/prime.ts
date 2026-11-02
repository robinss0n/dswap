import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountsRoot } from "../names.js";
import { droidActivityMarkTime } from "../activity.js";

/**
 * Window priming: a 5-hour limit window starts with an account's first message, so a tiny ping
 * the moment a window ends keeps windows rolling back-to-back and moves every reset as early as
 * it can be. Pings skip quiet hours, pause while Droid has been unused for a long time, and leave
 * accounts alone that are disabled, signed out or near their weekly limit.
 */

export type PrimeProvider = "claude" | "codex" | "google";
export const PRIME_PROVIDERS: PrimeProvider[] = ["claude", "codex", "google"];
export const WINDOW_MS = 5 * 60 * 60_000;

export interface PrimeWindow { usedPercent?: number; resetsAt?: number }
export interface PrimeTarget {
  provider: PrimeProvider;
  /** What the ping needs to reach the account: cswap slot, Codex or Google account name. */
  account: string;
  label: string;
  usable: boolean;
  /** Why the account is not usable (signed out, disabled, error). */
  problem?: string;
  fiveHour?: PrimeWindow;
  weekly?: PrimeWindow;
}

export interface PrimeConfig {
  providers: Record<PrimeProvider, boolean>;
  /** Local `HH:MM-HH:MM` with no pings (may wrap past midnight), or undefined for none. */
  quiet?: string;
  /** Hours without Droid use after which pinging pauses; undefined never pauses. */
  idleHours?: number;
  /** Weekly use (percent) at or above which an account is not primed. */
  weeklyCap: number;
}

export const DEFAULT_PRIME_CONFIG: PrimeConfig = { providers: { claude: true, codex: true, google: true }, quiet: "03:00-05:00", idleHours: 8, weeklyCap: 90 };

export interface PrimeState {
  /** Last ping per `provider:account`, epoch ms. */
  lastPing: Record<string, number>;
  /** Known end of a running window per `provider:account`, epoch ms, so it is not probed again before then. */
  runningUntil: Record<string, number>;
  lastProbe: Record<string, number>;
}

export const targetKey = (target: Pick<PrimeTarget, "provider" | "account">) => `${target.provider}:${target.account}`;

/**
 * Whether the 5-hour window is not running: no reset time, a reset in the past, or (Google) an
 * unused window whose reset keeps drifting about 5 hours ahead of now.
 */
export function windowIdle(window: PrimeWindow | undefined, now: number): boolean {
  if (!window || window.resetsAt === undefined) return true;
  if (window.resetsAt <= now) return true;
  return (window.usedPercent ?? 0) === 0 && window.resetsAt - now >= WINDOW_MS - 3 * 60_000;
}

const minutes = (text: string) => { const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim()); return match ? Number(match[1]) * 60 + Number(match[2]) : undefined; };

export function parseQuiet(value: string): string {
  const match = /^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/.exec(value.trim());
  const norm = (part: string) => (part.includes(":") ? part : `${part}:00`).padStart(5, "0");
  if (!match) throw new Error(`Quiet hours look like 03:00-05:00 or 3-5, not ${value}.`);
  const [from, to] = [norm(match[1]!), norm(match[2]!)];
  const [a, b] = [minutes(from), minutes(to)];
  if (a === undefined || b === undefined || a >= 24 * 60 || b > 24 * 60 || a === b) throw new Error(`Quiet hours ${value} are not a time range.`);
  return `${from}-${to}`;
}

/** Whether a local time falls into `HH:MM-HH:MM` (end exclusive, may wrap past midnight). */
export function inQuiet(date: Date, quiet: string | undefined): boolean {
  if (!quiet) return false;
  const [from, to] = quiet.split("-").map(minutes);
  if (from === undefined || to === undefined) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export type Decision = { ping: true; reason: string } | { ping: false; reason: string };

/** Whether one account needs a ping now; the reason is shown in `dswap prime` and the log. */
export function decide(target: PrimeTarget, state: PrimeState, config: PrimeConfig, now: number): Decision {
  if (!config.providers[target.provider]) return { ping: false, reason: `${target.provider} priming is off` };
  if (!target.usable) return { ping: false, reason: target.problem ?? "not usable" };
  const weekly = target.weekly?.usedPercent;
  if (weekly !== undefined && weekly >= config.weeklyCap) return { ping: false, reason: `week at ${Math.round(weekly)}% (cap ${config.weeklyCap}%)` };
  if (!windowIdle(target.fiveHour, now)) return { ping: false, reason: `window running, resets in ${duration(target.fiveHour!.resetsAt! - now)}` };
  const last = state.lastPing[targetKey(target)];
  // A ping that did not visibly start the window (usage rounds to 0%) must not repeat every few minutes.
  if (last !== undefined && now - last < WINDOW_MS - 2 * 60_000) return { ping: false, reason: `pinged ${duration(now - last)} ago` };
  return { ping: true, reason: target.fiveHour?.resetsAt && target.fiveHour.resetsAt <= now ? "window ended" : "window not started" };
}

/** Why no account is pinged right now (quiet hours, Droid unused), or undefined. */
export function globalPause(config: PrimeConfig, now: Date, lastActivity: number | undefined): string | undefined {
  if (inQuiet(now, config.quiet)) return `quiet hours ${config.quiet}`;
  if (config.idleHours !== undefined && lastActivity !== undefined && now.getTime() - lastActivity > config.idleHours * 3_600_000)
    return `Droid unused for ${duration(now.getTime() - lastActivity)} (pause after ${config.idleHours}h)`;
  return undefined;
}

/**
 * Whether an account must be probed again: unknown, its known window has ended, or the last probe
 * is over an hour old. Keeps a 5-minute timer from probing providers every 5 minutes.
 */
export function needsProbe(key: string, state: PrimeState, now: number): boolean {
  const until = state.runningUntil[key], probed = state.lastProbe[key];
  if (until === undefined || probed === undefined) return true;
  return now >= until - 60_000 || now - probed > 60 * 60_000;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), mins = total % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}

// ── files ─────────────────────────────────────────────────────────────────────
export function primeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_PRIME_DIR ?? join(accountsRoot(env), "prime");
}

function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) } : fallback; } catch { return fallback; }
}

export function loadPrimeConfig(env: NodeJS.ProcessEnv = process.env): PrimeConfig {
  const config = readJson(join(primeDir(env), "config.json"), DEFAULT_PRIME_CONFIG);
  return { ...config, providers: { ...DEFAULT_PRIME_CONFIG.providers, ...config.providers } };
}

export function savePrimeConfig(config: PrimeConfig, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(primeDir(env), { recursive: true });
  writeFileSync(join(primeDir(env), "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export function loadPrimeState(env: NodeJS.ProcessEnv = process.env): PrimeState {
  return readJson<PrimeState>(join(primeDir(env), "state.json"), { lastPing: {}, runningUntil: {}, lastProbe: {} });
}

export function savePrimeState(state: PrimeState, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(primeDir(env), { recursive: true });
  writeFileSync(join(primeDir(env), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

const stamp = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toTimeString().slice(0, 8)}`;

export function primeLog(text: string, env: NodeJS.ProcessEnv = process.env, date = new Date()): void {
  mkdirSync(primeDir(env), { recursive: true });
  appendFileSync(join(primeDir(env), "prime.log"), `${stamp(date)} ${text}\n`);
}

/** Today's log lines as `HH:MM:SS message`, newest last. */
export function readPrimeLog(lines = 40, env: NodeJS.ProcessEnv = process.env, date = new Date()): string[] {
  const path = join(primeDir(env), "prime.log");
  return existsSync(path) ? primeLogLines(readFileSync(path, "utf8"), lines, date) : [];
}

/** Today's lines of a priming log, without the date. */
export function primeLogLines(text: string, lines = 40, date = new Date()): string[] {
  const today = stamp(date).slice(0, 10);
  return text.split("\n").filter((line) => line.startsWith(today)).slice(-lines).map((line) => line.slice(11));
}

/**
 * Last time Droid was used: the newest change among Droid's session files (only their times are
 * read, never their contents), or the bridge's mark for a Droid on another machine.
 * Undefined when neither exists.
 */
export function lastDroidActivity(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const root = env.DSWAP_ACTIVITY_DIR ?? join(env.HOME ?? homedir(), ".factory/sessions");
  const marked = droidActivityMarkTime(env) ?? 0;
  if (!existsSync(root)) return marked || undefined;
  let newest = marked;
  const visit = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      try {
        if (entry.isDirectory()) { if (depth < 1) visit(path, depth + 1); continue; }
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch { /* a session file removed while scanning */ }
    }
  };
  visit(root, 0);
  return newest || undefined;
}
