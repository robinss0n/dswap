import { emitKeypressEvents, type Key } from "node:readline";
import { DEFAULT_CODEX_ACCOUNT } from "../src/upstream/codex-accounts.js";
import { accounts as runCli, addCodex, auto, autoLog, autoState, cswap, loadClaude, loadCodex, loadGoogle, loginClaude, loginCodex, quickCswapArgs, removeCodex, type Account, type AutoState } from "./accounts.js";

/**
 * `dswap` in a terminal, laid out like Droid: banner, rounded panels, a command box
 * with a suggestion list, and a status bar. Every action is a plain dswap subcommand,
 * shown next to its key, and anything typed in the command box runs as one.
 */

// ── theme ──────────────────────────────────────────────────────────────────────
type RGB = readonly [number, number, number];
const THEME = {
  blue: [59, 130, 246], sky: [96, 165, 250], cyan: [56, 189, 248], ice: [186, 230, 253],
  border: [46, 74, 122], borderHi: [96, 165, 250], muted: [125, 141, 170], text: [226, 232, 240],
  ok: [74, 222, 128], warn: [250, 204, 21], bad: [248, 113, 113], selBg: [20, 38, 70], track: [40, 52, 72], tagBg: [37, 99, 235],
  green: [74, 222, 128], purple: [192, 132, 252], claude: [251, 146, 60], codex: [45, 212, 191],
  gBlue: [66, 133, 244], gRed: [234, 67, 53], gYellow: [251, 188, 5], gGreen: [52, 168, 83],
} satisfies Record<string, RGB>;

type ColorMode = "none" | "256" | "true";
export function colorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR || env.TERM === "dumb") return "none";
  if (env.DSWAP_COLORS === "256" || env.TERM === "linux") return "256";
  return "true";
}
const mode256 = (rgb: RGB) => 16 + 36 * Math.round((rgb[0] / 255) * 5) + 6 * Math.round((rgb[1] / 255) * 5) + Math.round((rgb[2] / 255) * 5);
const COLORS = colorMode();
const paint = (rgb: RGB, layer: 38 | 48) => (text: string) => COLORS === "none" ? text
  : `\x1b[${layer};${COLORS === "true" ? `2;${rgb.join(";")}` : `5;${mode256(rgb)}`}m${text}\x1b[${layer + 1}m`;
const fg = (rgb: RGB) => paint(rgb, 38);
const bg = (rgb: RGB) => paint(rgb, 48);
const bold = (text: string) => COLORS === "none" ? text : `\x1b[1m${text}\x1b[22m`;
const c = {
  blue: fg(THEME.blue), sky: fg(THEME.sky), cyan: fg(THEME.cyan), ice: fg(THEME.ice), muted: fg(THEME.muted), text: fg(THEME.text),
  ok: fg(THEME.ok), warn: fg(THEME.warn), bad: fg(THEME.bad), border: fg(THEME.border), borderHi: fg(THEME.borderHi), track: fg(THEME.track),
  green: fg(THEME.green), purple: fg(THEME.purple), claude: fg(THEME.claude), codex: fg(THEME.codex),
};
const GOOGLE_COLORS = [THEME.gBlue, THEME.gRed, THEME.gYellow, THEME.gBlue, THEME.gGreen, THEME.gRed];
/** "Google" in its own letter colors, other providers in theirs. */
export function providerName(provider: string, text = provider): string {
  if (provider === "claude") return c.claude(text);
  if (provider === "codex") return c.codex(text);
  if (provider === "google") return [...text].map((char, index) => fg(GOOGLE_COLORS[index % GOOGLE_COLORS.length]!)(char)).join("");
  return c.sky(text);
}

// ── layout helpers ─────────────────────────────────────────────────────────────
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visible = (line: string) => [...line.replace(ANSI, "")].length;

/** Cuts a colored line to `width` visible characters so it never wraps; colors are reset after a cut. */
export function clip(line: string, width: number): string {
  let count = 0, out = "";
  for (let index = 0; index < line.length;) {
    const escape = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(index));
    if (escape) { out += escape[0]; index += escape[0].length; continue; }
    if (count >= width) return `${out}${COLORS === "none" ? "" : "\x1b[0m"}`;
    const char = String.fromCodePoint(line.codePointAt(index)!);
    out += char; index += char.length; count += 1;
  }
  return out;
}
const pad = (line: string, width: number) => { const size = visible(line); return size > width ? clip(line, width) : line + " ".repeat(width - size); };
const fit = (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);

/** Rounded panel, Droid style. `right` sits in the top border. */
export function box(title: string, lines: string[], width: number, options: { right?: string; focus?: boolean; fill?: number; titleColor?: (text: string) => string } = {}): string[] {
  const edge = options.focus ? c.borderHi : c.border, inner = width - 4;
  const head = title ? ` ${bold((options.titleColor ?? c.sky)(title))} ` : "", right = options.right ? ` ${options.right} ` : "";
  const run = Math.max(0, width - 3 - visible(head) - visible(right));
  const body = [...lines];
  while (options.fill && body.length < options.fill) body.push("");
  return [
    edge(`╭─`) + head + edge("─".repeat(run)) + right + edge("╮"),
    ...body.map((line) => `${edge("│")} ${pad(line, inner)} ${edge("│")}`),
    edge(`╰${"─".repeat(width - 2)}╯`),
  ];
}

const side = (left: string[], right: string[], leftWidth: number) => Array.from({ length: Math.max(left.length, right.length) },
  (_, index) => `${pad(left[index] ?? "", leftWidth)} ${right[index] ?? ""}`);

const LOGO = ["█▀▄ █▀ █ █ █ ▄▀█ █▀█", "█▄▀ ▄█ ▀▄▀▄▀ █▀█ █▀▀"];
function gradient(text: string): string {
  if (COLORS === "none") return text;
  const chars = [...text], stops: RGB[] = [THEME.blue, THEME.cyan, THEME.green];
  return chars.map((char, index) => {
    const t = (chars.length > 1 ? index / (chars.length - 1) : 0) * (stops.length - 1);
    const from = stops[Math.min(Math.floor(t), stops.length - 2)]!, to = stops[Math.min(Math.floor(t), stops.length - 2) + 1]!, local = t - Math.min(Math.floor(t), stops.length - 2);
    return char === " " ? char : fg([0, 1, 2].map((part) => Math.round(from[part]! + (to[part]! - from[part]!) * local)) as unknown as RGB)(char);
  }).join("");
}

function usageColor(value: number): (text: string) => string {
  return value >= 90 ? c.bad : value >= 70 ? c.warn : c.green;
}

export function bar(value: number | undefined, cells = 10): string {
  if (value === undefined) return `${c.track("─".repeat(cells))} ${c.muted("   -")}`;
  const filled = Math.max(0, Math.min(cells, Math.round((value / 100) * cells)));
  const color = usageColor(value);
  return `${color("█".repeat(filled))}${c.track("█".repeat(cells - filled))} ${color(`${Math.round(value)}%`.padStart(4))}`;
}

const STATUS_TEXT: Record<string, string> = { relogin_required: "login expired", logged_out: "logged out", limited: "limited", disabled: "disabled", ok: "ok" };
const statusText = (account: Account) => account.status === "ok" && account.active ? "ok · default" : STATUS_TEXT[account.status] ?? account.status;

function statusCell(account: Account): string {
  const text = statusText(account);
  if (account.status === "ok") return c.ok(`● ${text}`);
  if (account.status === "limited") return c.warn(`◐ ${text}`);
  if (account.status === "disabled") return c.muted(`○ ${text}`);
  return c.bad(`✕ ${text}`);
}

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// ── commands ───────────────────────────────────────────────────────────────────
interface Command { name: string; args: string; about: string }
export const COMMANDS: Command[] = [
  { name: "switch", args: "<account>", about: "make a Claude account the default login" },
  { name: "disable", args: "<account>", about: "keep a Claude account out of rotation" },
  { name: "enable", args: "<account>", about: "put a Claude account back in rotation" },
  { name: "alias", args: "<account> <name>", about: "short name for a Claude account (--unset removes)" },
  { name: "login claude", args: "", about: "add a Claude account or renew an expired one" },
  { name: "login codex", args: "[name]", about: "log a Codex account in again" },
  { name: "add codex", args: "<name>", about: "new Codex account (runs codex login)" },
  { name: "remove claude", args: "<account>", about: "remove a Claude account from cswap" },
  { name: "remove codex", args: "<name>", about: "remove a Codex login" },
  { name: "add google", args: "<name>", about: "new Google account (Google AI Pro / Ultra sign-in)" },
  { name: "login google", args: "<name>", about: "sign a Google account in again" },
  { name: "rename google", args: "<old> <new>", about: "rename a Google account" },
  { name: "remove google", args: "<name>", about: "remove a Google account and its sign-in" },
  { name: "runtime google", args: "", about: "install or update Google's Antigravity agent" },
  { name: "auto on", args: "", about: "run cswap auto in the background" },
  { name: "auto off", args: "", about: "stop cswap auto" },
  { name: "refresh", args: "", about: "reload every account" },
  { name: "help", args: "", about: "every key and command" },
  { name: "quit", args: "", about: "leave dswap" },
];

/** Typed text as argv: a leading `/` or `dswap ` is optional, so pasted CLI commands work. */
export const normalize = (input: string) => input.trim().replace(/^\//, "").replace(/^dswap\s+/, "").replace(/\s+/g, " ");

export interface Suggestion { label: string; about: string; completion: string; runnable: boolean }

/** What the list under the command box shows for the text typed so far. */
export function suggest(input: string, claude: Account[], codex: Account[], google: Account[] = []): Suggestion[] {
  const raw = input.replace(/^\//, "").replace(/^dswap\s+/, "").replace(/^\s+/, "");
  const accountVerb = /^(switch|use|enable|disable|alias|remove claude) (\S*)$/.exec(raw);
  if (accountVerb) {
    const [, verb, typed] = accountVerb;
    return claude.filter((account) => account.selector !== "-" && (account.selector.startsWith(typed!) || account.label.includes(typed!) || account.email.startsWith(typed!)))
      .map((account) => ({ label: `${verb} ${account.selector}`, about: `${account.label}${account.email ? ` · ${account.email}` : ""} · ${statusText(account)}`,
        completion: `${verb} ${account.selector}${verb === "alias" ? " " : ""}`, runnable: verb !== "alias" }));
  }
  const codexVerb = /^(login codex|remove codex) (\S*)$/.exec(raw);
  if (codexVerb) {
    const [, verb, typed] = codexVerb;
    return codex.filter((account) => account.selector.startsWith(typed!) && !(verb === "remove codex" && account.selector === DEFAULT_CODEX_ACCOUNT))
      .map((account) => ({ label: `${verb} ${account.selector}`, about: `${account.email || "no login"} · ${statusText(account)}`, completion: `${verb} ${account.selector}`, runnable: true }));
  }
  const googleVerb = /^(login google|remove google|rename google) (\S*)$/.exec(raw);
  if (googleVerb) {
    const [, verb, typed] = googleVerb;
    return google.filter((account) => account.selector.startsWith(typed!))
      .map((account) => ({ label: `${verb} ${account.selector}`, about: `${account.plan || "Google"} · ${statusText(account)}`,
        completion: `${verb} ${account.selector}${verb === "rename google" ? " " : ""}`, runnable: verb !== "rename google" }));
  }
  const query = raw.trimEnd();
  return COMMANDS.filter((command) => !query || command.name.startsWith(query) || command.name.split(" ").some((word) => word.startsWith(query)) || query.startsWith(`${command.name} `))
    .map((command) => ({ label: `${command.name}${command.args ? ` ${command.args}` : ""}`, about: command.about,
      completion: `${command.name}${command.args ? " " : ""}`, runnable: !command.args || command.args.startsWith("[") }));
}

// ── dashboard ──────────────────────────────────────────────────────────────────
interface Action { keys: string[]; hint: string; label: string; cli: string; run: () => void | Promise<void> }
type Mode =
  | { kind: "normal" }
  | { kind: "command"; value: string; pick: number }
  | { kind: "input"; label: string; value: string; submit: (value: string) => void | Promise<void> }
  | { kind: "choice"; label: string; choices: Record<string, () => void | Promise<void>> };
type Tone = "ok" | "error" | "info" | "busy";

/** Made-up accounts for `dswap demo`: safe to screenshot, nothing real is read. */
export function demoData(now = new Date()): { claude: Account[]; codex: Account[]; google: Account[]; journal: string[] } {
  const claude: Account[] = [
    { provider: "claude", selector: "1", label: "1 work", email: "ada@example.com", plan: "Max 20x", fiveHour: 57, weekly: 31, resets: "4h 12m", fiveHourResets: "4h 12m", weeklyResets: "3d 6h", status: "ok", active: true },
    { provider: "claude", selector: "2", label: "2 side", email: "grace@example.com", plan: "Max 5x", fiveHour: 0, weekly: 100, resets: "3d 23h", weeklyResets: "3d 23h", status: "limited" },
    { provider: "claude", selector: "3", label: "3 team", email: "linus@example.com", plan: "Team", fiveHour: 29, weekly: 69, resets: "2d 5h", fiveHourResets: "3h 4m", weeklyResets: "2d 5h", status: "ok" },
  ];
  const codex: Account[] = [
    { provider: "codex", selector: "default", label: "default", email: "ada@example.com", plan: "plus", fiveHour: 6, weekly: 66, resets: "5d 6h", fiveHourResets: "3h 12m", weeklyResets: "5d 6h", status: "ok" },
  ];
  const google: Account[] = [
    { provider: "google", selector: "main", label: "main", email: "", plan: "Google AI Pro", fiveHour: 12, weekly: 4, resets: "4h 40m", fiveHourResets: "4h 40m", weeklyResets: "6d 20h", status: "ok", detail: "Claude and GPT models: 5h 0% · week 0%" },
    { provider: "google", selector: "spare", label: "spare", email: "", plan: "Antigravity Starter Quota", weekly: 2, resets: "6d 23h", weeklyResets: "6d 23h", status: "ok", detail: "Claude and GPT models: week 0%" },
  ];
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toTimeString().slice(0, 8);
  const journal = [
    `${at(30)} Account-2 (grace@example.com): 90% used (switch at 90%)`,
    `${at(29)} switching to Account-1 (ada@example.com) → most room left`,
    ...[24, 18, 12, 6, 0].map((ago, index) => `${at(ago)} Account-1 (ada@example.com): ${33 + index * 6}% used (switch at 90%) | others: #2: 7d 100%, #3: 5h 29% · 7d 69%`),
  ];
  return { claude, codex, google, journal };
}

export async function dashboard(options: { demo?: boolean } = {}): Promise<number> {
  const demo = options.demo === true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The dashboard needs a terminal. Use `dswap list` for the table.");
  const stdin = process.stdin, stdout = process.stdout;

  let claude: Account[] = [];
  let codex: Account[] = [];
  let google: Account[] = [];
  let codexLoading = true;
  let autoNow: AutoState = "off";
  let selected = "";
  let mode: Mode = { kind: "normal" };
  let help = false;
  let message: { text: string; tone: Tone } | undefined;
  const events: Array<{ time: string; text: string; tone: Tone }> = [];
  let journal: string[] = [];
  let generation = 0;
  let spinner = 0;
  let running = false;
  let busy = false;
  let finish: (code: number) => void = () => {};

  const selectable = () => [...claude, ...codex, ...google].filter((account) => account.selector !== "-");
  const keyOf = (account: Account) => `${account.provider}:${account.selector}`;
  const current = () => selectable().find((account) => keyOf(account) === selected);

  function ensureSelection(): void {
    const items = selectable();
    if (items.some((account) => keyOf(account) === selected)) return;
    const preferred = items.find((account) => account.active) ?? items[0];
    selected = preferred ? keyOf(preferred) : "";
  }

  function move(delta: number): void {
    const items = selectable();
    if (!items.length) return;
    const index = Math.max(0, items.findIndex((account) => keyOf(account) === selected));
    selected = keyOf(items[(index + delta + items.length) % items.length]!);
  }

  const clock = () => new Date().toTimeString().slice(0, 8);
  const say = (text: string, tone: Tone = "info") => {
    message = { text, tone };
    if (tone === "ok" || tone === "error") events.push({ time: clock(), text, tone });
    if (events.length > 50) events.shift();
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  async function refresh(): Promise<void> {
    if (demo) {
      ({ claude, codex, google, journal } = demoData());
      autoNow = "on";
      codexLoading = false;
      ensureSelection();
      render();
      return;
    }
    const mine = ++generation;
    claude = loadClaude();
    autoNow = autoState();
    journal = autoNow === "on" || autoNow === "installed" ? autoLog() : [];
    codexLoading = true;
    ensureSelection();
    render();
    const [probedCodex, probedGoogle] = await Promise.all([loadCodex(), loadGoogle()]);
    if (mine !== generation) return;
    codex = probedCodex;
    google = probedGoogle;
    codexLoading = false;
    ensureSelection();
    render();
  }

  /** Quick cswap commands run while the dashboard stays up. */
  async function quick(cli: string, args: string[], done: string): Promise<void> {
    if (demo) { say(`demo: would run ${cli}`); return; }
    say(`running ${cli} …`, "busy");
    render();
    try {
      const output = cswap(args, true);
      say(`${done}${output ? ` · ${output}` : ""}`, "ok");
    } catch (error) {
      say(errorText(error), "error");
    }
    await refresh();
  }

  /** Logins need the real terminal: leave the dashboard, run, come back. */
  async function suspended(cli: string, work: () => unknown, done: string): Promise<void> {
    if (demo) { say(`demo: would run ${cli}`); return; }
    leave();
    stdout.write(`\n${bg(THEME.tagBg)(bold(c.text(" DSWAP ")))} ${c.muted("›")} ${bold(c.sky(cli))}\n\n`);
    let failed: string | undefined;
    try { await work(); } catch (error) { failed = errorText(error); }
    stdout.write(`\n${failed ? c.bad(`✕ ${failed}`) : c.ok(`✓ ${done}`)}\n${c.muted("Press any key to go back to dswap.")}`);
    await anyKey();
    enter();
    say(failed ?? done, failed ? "error" : "ok");
    await refresh();
  }

  function anyKey(): Promise<void> {
    return new Promise((resolveKey) => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once("data", () => { stdin.setRawMode(false); stdin.pause(); resolveKey(); });
    });
  }

  function confirm(label: string, yes: () => void | Promise<void>): void {
    mode = { kind: "choice", label: `${label}  ${bold(c.sky("y"))} ${c.muted("yes · any other key: no")}`, choices: { y: demo ? () => say("demo: nothing was removed") : yes } };
  }

  const loginClaudeNow = () => suspended("dswap login claude", () => { loginClaude(); }, "Claude login stored in cswap.");
  const removeClaudeNow = (account: Account) => confirm(`Remove claude ${account.label}${account.email ? ` (${account.email})` : ""}?`,
    () => suspended(`dswap remove claude ${account.selector}`, () => { cswap(["remove", account.selector]); }, `Removed claude ${account.label}.`));
  const removeGoogleNow = (name: string) => confirm(`Remove Google account ${name} and its sign-in?`, async () => {
    try { const googleCli = await import("./google.js"); googleCli.removeGoogle(name); say(`Removed Google account ${name}.`, "ok"); } catch (error) { say(errorText(error), "error"); }
    await refresh();
  });
  const addGoogleNow = () => { mode = { kind: "input", label: "name for the new Google account", value: "", submit: (name) => name.trim()
    ? suspended(`dswap add google ${name.trim()}`, async () => { const googleCli = await import("./google.js"); await googleCli.loginGoogle(name.trim(), true); }, `Google account ${name.trim()} added.`)
    : say("No name given; nothing added.") }; };
  const removeCodexNow = (name: string) => confirm(`Remove Codex account ${name}?`, async () => {
    try { removeCodex(name); say(`Removed Codex account ${name}.`, "ok"); } catch (error) { say(errorText(error), "error"); }
    await refresh();
  });

  function accountActions(account: Account | undefined): Action[] {
    if (!account) return [];
    const id = account.selector;
    if (account.provider === "claude") return [
      { keys: ["return", "s"], hint: "⏎ s", label: account.active ? "already the default" : "make default login", cli: `dswap switch ${id}`,
        run: () => account.active ? say(`claude ${account.label} is already the default login.`) : quick(`dswap switch ${id}`, ["switch", id], `Default Claude login is now ${account.label}`) },
      { keys: ["l"], hint: "l", label: account.status === "relogin_required" ? "log in again (expired)" : "log in / renew", cli: "dswap login claude", run: loginClaudeNow },
      account.disabled
        ? { keys: ["e"], hint: "e", label: "enable", cli: `dswap enable ${id}`, run: () => quick(`dswap enable ${id}`, ["enable", id], `Enabled ${account.label}`) }
        : { keys: ["e"], hint: "e", label: "disable", cli: `dswap disable ${id}`, run: () => quick(`dswap disable ${id}`, ["disable", id], `Disabled ${account.label}`) },
      { keys: ["a"], hint: "a", label: "set alias", cli: `dswap alias ${id} <name>`,
        run: () => { mode = { kind: "input", label: `alias for claude ${account.label}`, value: "", submit: (name) => name.trim()
          ? quick(`dswap alias ${id} ${name.trim()}`, ["alias", id, name.trim()], `Alias set to ${name.trim()}`)
          : quick(`dswap alias ${id} --unset`, ["alias", id, "--unset"], "Alias removed") }; } },
      { keys: ["x"], hint: "x", label: "remove", cli: `dswap remove claude ${id}`, run: () => removeClaudeNow(account) },
    ];
    if (account.provider === "google") return [
      { keys: ["return", "l"], hint: "⏎ l", label: account.status === "ok" ? "sign in again" : `sign in (${STATUS_TEXT[account.status] ?? account.status})`, cli: `dswap login google ${id}`,
        run: () => suspended(`dswap login google ${id}`, async () => { const google = await import("./google.js"); await google.loginGoogle(id, false); }, `Google ${id} signed in.`) },
      { keys: ["m"], hint: "m", label: "rename", cli: `dswap rename google ${id} <new>`,
        run: () => { mode = { kind: "input", label: `new name for google ${id}`, value: "", submit: async (name) => {
          if (!name.trim()) { say("No name given; nothing renamed."); return; }
          if (demo) { say(`demo: would run dswap rename google ${id} ${name.trim()}`); return; }
          try { const googleCli = await import("./google.js"); googleCli.renameGoogle(id, name.trim()); selected = `google:${name.trim()}`; say(`Renamed Google account ${id} to ${name.trim()}.`, "ok"); } catch (error) { say(errorText(error), "error"); }
          await refresh();
        } }; } },
      { keys: ["x"], hint: "x", label: "remove", cli: `dswap remove google ${id}`, run: () => removeGoogleNow(id) },
    ];
    return [
      { keys: ["return", "l"], hint: "⏎ l", label: account.status === "ok" ? "log in again" : `log in (${STATUS_TEXT[account.status] ?? account.status})`, cli: `dswap login codex ${id}`,
        run: () => suspended(`dswap login codex ${id}`, () => { loginCodex(id); }, `Codex ${id} logged in.`) },
      ...(id === DEFAULT_CODEX_ACCOUNT ? [] : [{ keys: ["x"], hint: "x", label: "remove", cli: `dswap remove codex ${id}`, run: () => removeCodexNow(id) }]),
    ];
  }

  function generalActions(): Action[] {
    const autoOn = autoNow === "on";
    return [
      { keys: ["/", ":"], hint: "/", label: "type a command", cli: "", run: () => { mode = { kind: "command", value: "", pick: 0 }; } },
      { keys: ["n"], hint: "n", label: "add an account", cli: "dswap login claude",
        run: () => { mode = { kind: "choice", label: `Add which account?  ${bold(c.sky("c"))} Claude   ${bold(c.sky("o"))} Codex   ${bold(c.sky("g"))} Google   ${c.muted("any other key cancels")}`, choices: {
          c: loginClaudeNow,
          g: addGoogleNow,
          o: () => { mode = { kind: "input", label: "name for the new Codex account", value: "", submit: (name) => name.trim()
            ? suspended(`dswap add codex ${name.trim()}`, () => { addCodex(name.trim()); }, `Codex account ${name.trim()} added.`)
            : say("No name given; nothing added.") }; },
        } }; } },
      ...(autoNow === "unsupported" ? [] : [{ keys: ["t"], hint: "t", label: autoOn ? "cswap auto off" : "cswap auto on", cli: `dswap auto ${autoOn ? "off" : "on"}`,
        run: () => suspended(`dswap auto ${autoOn ? "off" : "on"}`, () => { auto(autoOn ? "off" : "on"); }, `cswap auto is ${autoOn ? "off" : "on"}.`) }]),
      { keys: ["r"], hint: "r", label: "refresh", cli: "dswap list", run: async () => { say("Refreshed.", "ok"); await refresh(); } },
      { keys: ["?"], hint: "?", label: "help", cli: "dswap help", run: () => { help = !help; } },
      { keys: ["q", "escape"], hint: "q", label: "quit", cli: "", run: () => quit() },
    ];
  }

  /** Runs one typed command line. */
  async function runCommand(input: string): Promise<void> {
    const line = normalize(input);
    const argv = line.split(" ").filter(Boolean);
    const [verb, target, name] = argv;
    if (!verb) return;
    if (verb === "refresh" || verb === "list" || verb === "ls") { say("Refreshed.", "ok"); return refresh(); }
    if (verb === "help" || verb === "?") { help = true; return; }
    if (verb === "quit" || verb === "exit" || verb === "q") return quit();
    if (verb === "tui" || verb === "ui") { say("You are in the dashboard already."); return; }
    const quickArgs = quickCswapArgs(argv);
    if (quickArgs) return quick(`dswap ${line}`, quickArgs, `Done: dswap ${line}`);
    if ((verb === "remove" || verb === "rm") && target === "codex" && name) return removeCodexNow(name);
    if ((verb === "remove" || verb === "rm") && target === "google" && name) return removeGoogleNow(name);
    if ((verb === "rename" || verb === "mv") && target === "google" && name && argv[3]) {
      if (demo) { say(`demo: would run dswap ${line}`); return; }
      try { const googleCli = await import("./google.js"); googleCli.renameGoogle(name, argv[3]); say(`Renamed Google account ${name} to ${argv[3]}.`, "ok"); } catch (error) { say(errorText(error), "error"); }
      return refresh();
    }
    if ((verb === "add" || verb === "login" || verb === "runtime") && target === "google") return suspended(`dswap ${line}`, () => runCli(argv), `dswap ${line} finished.`);
    if ((verb === "remove" || verb === "rm") && target === "claude" && name) {
      const account = claude.find((item) => item.selector === name || item.email === name || item.label.split(" ")[1] === name);
      return account ? removeClaudeNow(account) : say(`No Claude account ${name}.`, "error");
    }
    if ((verb === "login" || verb === "add") && target === "claude") return loginClaudeNow();
    if (verb === "login" || verb === "add" || verb === "auto") return suspended(`dswap ${line}`, () => runCli(argv), `dswap ${line} finished.`);
    say(`Unknown command: ${line}. Type / to see them all.`, "error");
  }

  // ── render ───────────────────────────────────────────────────────────────────
  function accountsPanel(width: number): string[] {
    const inner = width - 4, all = [...claude, ...codex, ...google];
    const labelW = Math.max(7, ...all.map((account) => account.label.length));
    let emailW = Math.min(28, Math.max(5, ...all.map((account) => account.email.length)));
    const planW = Math.min(22, Math.max(4, ...all.map((account) => account.plan.length)));
    const statusW = 16, resetW = 7;
    const need = (bars: boolean, plan: boolean) => 4 + labelW + 2 + emailW + 2 + (plan ? planW + 2 : 0) + 2 * ((bars ? 15 : 4) + 2) + resetW + 2 + statusW;
    const showBars = need(true, false) <= inner, showPlan = need(true, true) <= inner;
    if (need(showBars, showPlan) > inner) emailW = Math.max(10, emailW - (need(showBars, showPlan) - inner));
    const usageW = showBars ? 15 : 4;
    const usage = (value?: number) => showBars ? bar(value) : value === undefined ? c.muted("   -") : usageColor(value)(`${Math.round(value)}%`.padStart(4));
    const lines: string[] = [];
    lines.push(c.muted(`    ${fit("ACCOUNT", labelW)}  ${fit("EMAIL", emailW)}  ${showPlan ? `${fit("PLAN", planW)}  ` : ""}${fit("5H", usageW)}  ${fit("WEEK", usageW)}  ${fit("RESETS", resetW)}  STATUS`));

    const row = (account: Account) => {
      const chosen = keyOf(account) === selected;
      const muted = account.disabled || account.status === "relogin_required" || account.status === "logged_out";
      const text = (value: string) => muted ? c.muted(value) : c.text(value);
      const pointer = chosen ? bold(c.cyan("❯")) : " ";
      const dot = account.active ? c.ok("●") : " ";
      const label = chosen ? bold(c.ice(fit(account.label, labelW))) : text(fit(account.label, labelW));
      const line = ` ${pointer}${dot} ${label}  ${text(fit(account.email, emailW))}  ${showPlan ? `${c.muted(fit(account.plan, planW))}  ` : ""}${usage(account.fiveHour)}  ${usage(account.weekly)}  ${c.purple(fit(account.resets ?? "", resetW))}  ${statusCell(account)}`;
      return chosen ? bg(THEME.selBg)(pad(line, inner)) : line;
    };
    const section = (name: string, note: string) => `${bold(providerName(name.toLowerCase(), name))}  ${c.muted(note)}`;

    lines.push(section("CLAUDE", "stored by cswap · ● default login"));
    if (!claude.length) lines.push(c.muted("    no accounts yet · press n to add one"));
    for (const account of claude) lines.push(account.selector === "-" ? `    ${c.bad(account.status)}` : row(account));
    lines.push(section("CODEX", "the bridge picks the one with the most room"));
    if (!codex.length && codexLoading) lines.push(c.muted("    checking Codex logins…"));
    for (const account of codex) lines.push(row(account));
    lines.push(section("GOOGLE", "Antigravity sign-in · Gemini limits shown"));
    if (!google.length) lines.push(c.muted(codexLoading ? "    checking Google sign-ins…" : "    no accounts yet · press n, then g"));
    for (const account of google) lines.push(row(account));

    const right = codexLoading ? `${c.cyan(SPIN[spinner % SPIN.length]!)} ${c.muted("checking")}` : c.muted(`${selectable().length} accounts`);
    return box("Accounts", lines, width, { right, focus: mode.kind === "normal" });
  }

  function detailPanel(account: Account | undefined, width: number): string[] {
    if (!account) return box("Details", [c.muted("No account selected.")], width);
    const cells = Math.max(6, Math.min(24, width - 30));
    const windowLine = (name: string, value: number | undefined, resets: string | undefined) =>
      `${c.muted(name.padEnd(7))} ${bar(value, cells)}${resets ? `${c.muted("  in ")}${c.purple(resets)}` : ""}`;
    const lines = [
      bold(c.text(account.email || (account.provider === "google" ? (account.status === "logged_out" ? "signed out" : "Google sign-in") : "no login"))),
      c.muted(account.plan || (account.provider === "codex" ? "Codex" : account.provider === "google" ? "Google" : "")),
      "",
      windowLine("5-hour", account.fiveHour, account.fiveHourResets),
      windowLine("weekly", account.weekly, account.weeklyResets),
      "",
      `${c.muted("status ")} ${statusCell(account)}${account.disabled ? c.muted("  (out of rotation)") : ""}`,
    ];
    if (account.detail) lines.push(account.status === "error" ? c.bad(account.detail) : c.warn(account.detail));
    return box(`${account.provider} ${account.label}`, lines, width, { titleColor: (text) => providerName(account.provider, text) });
  }

  function actionsPanel(account: Account | undefined, width: number, compact: boolean): string[] {
    const inner = width - 4;
    const line = (action: Action) => {
      const left = `${bold(c.cyan(fit(action.hint, 4)))}${c.text(fit(action.label, 22))}`;
      return action.cli && inner >= 40 ? `${left} ${c.green("$")} ${c.muted(fit(action.cli, inner - 29))}` : left;
    };
    const lines = accountActions(account).map(line);
    if (!compact) {
      lines.push(c.border("─".repeat(inner)));
      lines.push(...generalActions().map(line));
    }
    return box("Actions", lines, width);
  }

  function helpPanel(width: number): string[] {
    const keys = [
      ["↑ ↓  j k", "move between accounts"], ["⏎", "default action (switch / log in)"], ["/  :", "command box (type any dswap command)"],
      ["tab", "complete the suggestion"], ["esc", "close the command box / help"], ["?", "toggle this help"],
    ];
    const lines = [bold(c.sky("Keys")), ...keys.map(([key, about]) => `  ${bold(c.cyan(fit(key!, 10)))}${c.text(about!)}`), "", bold(c.sky("Commands")) + c.muted("  same in the command box and in your shell (dswap …)"),
      ...COMMANDS.map((command) => `  ${c.green(fit(`${command.name} ${command.args}`.trim(), 30))}${c.muted(command.about)}`)];
    return box("Help", lines, width, { right: c.muted("? or esc to close"), focus: true });
  }

  function commandBox(width: number): string[] {
    const cursor = COLORS === "none" ? "_" : bg(THEME.sky)(" ");
    let content: string;
    if (mode.kind === "command") content = `${bold(c.cyan("›"))} ${c.text(mode.value)}${cursor}`;
    else if (mode.kind === "input") content = `${c.sky(mode.label)} ${bold(c.cyan("›"))} ${c.text(mode.value)}${cursor}  ${c.muted("⏎ ok · esc cancel")}`;
    else if (mode.kind === "choice") content = mode.label;
    else content = `${c.muted("›")} ${c.muted("press / to type a command, e.g. switch 2  ·  ? for help")}`;
    return box("", [content], width, { focus: mode.kind !== "normal" });
  }

  function suggestionLines(width: number, max: number): string[] {
    if (mode.kind !== "command") return [];
    const list = suggest(mode.value, claude, codex, google);
    if (!list.length) return [c.muted("   no matching command")];
    const pick = Math.min(mode.pick, list.length - 1);
    const start = Math.max(0, Math.min(pick - max + 1, list.length - max));
    return list.slice(start, start + max).map((item, offset) => {
      const chosen = start + offset === pick;
      const line = ` ${chosen ? bold(c.cyan("❯")) : " "} ${chosen ? bold(c.ice(fit(item.label, 32))) : c.green(fit(item.label, 32))} ${c.muted(item.about)}`;
      return chosen ? bg(THEME.selBg)(pad(line, width)) : line;
    });
  }

  function statusBar(width: number): string {
    const tag = bg(THEME.tagBg)(bold(c.text(" DSWAP ")));
    const autoText = autoNow === "on" ? c.ok("● auto on") : autoNow === "installed" ? c.warn("● auto stopped") : autoNow === "unsupported" ? c.muted("auto n/a") : c.muted("○ auto off");
    const active = claude.find((account) => account.active);
    const left = ` ${tag} ${autoText}  ${c.muted("·")}  ${c.muted("default")} ${bold(c.claude(active?.label ?? "-"))}  ${c.muted("·")}  ${c.claude(String(claude.filter((a) => a.selector !== "-").length))} ${c.muted("claude ·")} ${c.codex(String(codex.length))} ${c.muted("codex ·")} ${providerName("google", String(google.length))} ${c.muted("google")}`;
    const right = mode.kind === "command" ? c.muted("⏎ run · tab complete · ↑↓ pick · esc close ") : c.muted("/ command · ? help · q quit ");
    return `${left}${" ".repeat(Math.max(1, width - visible(left) - visible(right)))}${right}`;
  }

  /** Your dswap actions and cswap auto's log, newest first; repeated auto lines collapse into one. */
  function activityPanel(width: number, height: number): string[] {
    const entries: Array<{ time: string; text: string; source: "you" | "auto"; count: number; tone: Tone }> = [];
    for (const line of journal) {
      const time = line.slice(0, 8), text = line.slice(8).trim();
      const same = entries.find((entry) => entry.source === "auto" && entry.text === text);
      if (same) { same.count += 1; same.time = time; continue; }
      entries.push({ time, text, source: "auto", count: 1, tone: /error|fail|denied/i.test(text) ? "error" : /switch(ed|ing) to|→/i.test(text) ? "ok" : "info" });
    }
    for (const event of events) entries.push({ ...event, source: "you", count: 1 });
    entries.sort((a, b) => b.time.localeCompare(a.time));
    const lines = entries.slice(0, Math.max(0, height - 2)).map((entry) => {
      const text = entry.tone === "error" ? c.bad(entry.text) : entry.tone === "ok" ? c.ok(entry.text) : entry.source === "you" ? c.text(entry.text) : c.muted(entry.text);
      return `${c.muted(entry.time)}  ${entry.source === "you" ? c.cyan("you ") : c.purple("auto")}  ${text}${entry.count > 1 ? c.muted(` ×${entry.count}`) : ""}`;
    });
    if (!lines.length) lines.push(c.muted(autoNow === "on" ? "No cswap auto activity yet." : "Nothing yet. Turn on cswap auto (t) to see its switches here."));
    return box("Activity", lines, width, { right: c.muted(autoNow === "on" ? "cswap auto log" : "this session"), fill: height - 2, titleColor: c.purple });
  }

  function toast(): string {
    if (!message) return "";
    const icon = message.tone === "error" ? c.bad("✕") : message.tone === "ok" ? c.ok("✓") : message.tone === "busy" ? c.cyan(SPIN[spinner % SPIN.length]!) : c.sky("›");
    const text = message.tone === "error" ? c.bad(message.text) : message.tone === "ok" ? c.ok(message.text) : c.muted(message.text);
    return `  ${icon} ${text}`;
  }

  function render(): void {
    if (!running) return;
    const columns = stdout.columns || 100, rows = stdout.rows || 40;
    const width = Math.min(columns - 1, 140);
    const account = current();

    const suggestions = suggestionLines(width, 6);
    const bottom = [toast(), ...commandBox(width), ...suggestions, statusBar(width)];
    const accountsBox = accountsPanel(width);
    const banner = [`  ${gradient(LOGO[0]!)}   ${c.muted("account switcher for the Droid bridge")}`,
      `  ${gradient(LOGO[1]!)}   ${providerName("claude")} ${c.muted("·")} ${providerName("codex")} ${c.muted("·")} ${providerName("google")}`, ""];

    let middle: string[];
    if (help) middle = helpPanel(width);
    else {
      const sideBySide = width >= 104;
      const build = (compact: boolean) => sideBySide
        ? side(detailPanel(account, 46), actionsPanel(account, width - 47, compact), 46)
        : [...detailPanel(account, width), ...actionsPanel(account, width, compact)];
      middle = build(false);
      const room = rows - bottom.length - accountsBox.length;
      if (middle.length > room) middle = build(true);
      if (middle.length > room) middle = sideBySide ? middle : actionsPanel(account, width, true);
    }
    const top = rows - bottom.length - accountsBox.length - middle.length >= banner.length ? banner : [];
    let lines = [...top, ...accountsBox, ...middle];
    const space = rows - bottom.length;
    if (!help && space - lines.length >= 5) lines.push(...activityPanel(width, space - lines.length));
    if (lines.length > space) lines = lines.slice(0, Math.max(0, space));
    while (lines.length < space) lines.push("");
    lines.push(...bottom);
    stdout.write(`\x1b[H${lines.slice(0, rows).map((line) => `${clip(line, columns - 1)}\x1b[K`).join("\n")}\x1b[J`);
  }

  // ── input ────────────────────────────────────────────────────────────────────
  async function onKey(text: string | undefined, key: Key | undefined): Promise<void> {
    if (key?.ctrl && key.name === "c") return quit();
    const printable = text && !key?.ctrl && !key?.meta && /^[\x20-\x7e]+$/.test(text) ? text : undefined;

    if (mode.kind === "command") {
      const command = mode;
      const list = suggest(command.value, claude, codex, google);
      const pick = list[Math.min(command.pick, list.length - 1)];
      if (key?.name === "escape") { mode = { kind: "normal" }; return; }
      if (key?.name === "up") { command.pick = Math.max(0, command.pick - 1); return; }
      if (key?.name === "down") { command.pick = Math.min(list.length - 1, command.pick + 1); return; }
      if (key?.name === "tab") { if (pick) { command.value = pick.completion; command.pick = 0; } return; }
      if (key?.name === "return") {
        if (pick && normalize(pick.completion) !== normalize(command.value)) {
          if (!pick.runnable) { command.value = pick.completion; command.pick = 0; return; }
          mode = { kind: "normal" };
          return runCommand(pick.completion);
        }
        mode = { kind: "normal" };
        return runCommand(command.value);
      }
      if (key?.name === "backspace") { if (!command.value) mode = { kind: "normal" }; else command.value = command.value.slice(0, -1); command.pick = 0; return; }
      if (key?.ctrl && key.name === "u") { command.value = ""; command.pick = 0; return; }
      if (printable) { command.value += printable; command.pick = 0; }
      return;
    }
    if (mode.kind === "input") {
      const input = mode;
      if (key?.name === "escape") { mode = { kind: "normal" }; say("Cancelled."); }
      else if (key?.name === "return") { mode = { kind: "normal" }; await input.submit(input.value); }
      else if (key?.name === "backspace") input.value = input.value.slice(0, -1);
      else if (printable) input.value += printable;
      return;
    }
    if (mode.kind === "choice") {
      const choice = mode.choices[(text ?? "").toLowerCase()];
      mode = { kind: "normal" };
      if (choice) await choice(); else say("Cancelled.");
      return;
    }
    if (help && (key?.name === "escape" || text === "?" || text === "q")) { help = false; return; }
    message = undefined;
    const name = text === "?" || text === "/" || text === ":" ? text : key?.name ?? text ?? "";
    if (name === "up" || name === "k") { move(-1); return; }
    if (name === "down" || name === "j" || name === "tab") { move(1); return; }
    if (name === "home" || name === "g") { const first = selectable()[0]; if (first) selected = keyOf(first); return; }
    if (name === "end") { const last = selectable().at(-1); if (last) selected = keyOf(last); return; }
    const action = [...accountActions(current()), ...generalActions()].find((item) => item.keys.includes(name));
    if (action) { help = false; await action.run(); }
  }

  const handler = (text: string | undefined, key: Key | undefined) => {
    if (busy) return;
    busy = true;
    onKey(text, key).catch((error) => say(errorText(error), "error")).finally(() => { busy = false; render(); });
  };

  const restore = () => { if (running) stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); };
  function enter(): void {
    running = true;
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", handler);
    render();
  }
  function leave(): void {
    stdin.off("keypress", handler);
    stdin.setRawMode(false);
    stdin.pause();
    restore();
    running = false;
  }
  function quit(): void {
    leave();
    finish(0);
  }

  emitKeypressEvents(stdin);
  process.on("exit", restore);
  const onResize = () => render();
  stdout.on("resize", onResize);
  const ticker = setInterval(() => { if (codexLoading || message?.tone === "busy") { spinner += 1; render(); } }, 120);
  const refresher = setInterval(() => { if (mode.kind === "normal" && running && !busy) void refresh(); }, 60_000);

  enter();
  void refresh().catch((error) => { say(errorText(error), "error"); render(); });
  const code = await new Promise<number>((resolveCode) => { finish = resolveCode; });
  clearInterval(ticker);
  clearInterval(refresher);
  stdout.off("resize", onResize);
  process.off("exit", restore);
  return code;
}
