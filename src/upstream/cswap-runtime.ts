import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * dswap's own copy of claude-swap. Claude accounts are stored through it, so dswap pins the
 * version it was tested with and keeps it in a private folder: `cswap upgrade` or
 * `uv tool upgrade` on the user's PATH cannot change it. Account data stays in cswap's
 * normal storage, so existing accounts carry over.
 */

export const CSWAP_VERSION = "0.26.0";

export function cswapRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".local/share/factory-cc-runtimes/cswap");
}

export function privateCswap(env: NodeJS.ProcessEnv = process.env): string {
  return join(cswapRuntimeDir(env), "cswap");
}

/** BRIDGE_CSWAP_EXECUTABLE wins, then dswap's private copy, then whatever `cswap` is on PATH. */
export function cswapExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_CSWAP_EXECUTABLE ?? (existsSync(privateCswap(env)) ? privateCswap(env) : "cswap");
}

/** claude-swap prints an update hint after every command; this launcher switches that check off. */
export function cswapWrapper(python: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh
exec ${quote(python)} -c 'import sys
import claude_swap.update_check as u
u.check_for_update = lambda version: None
from claude_swap.cli import main
sys.argv[0] = "cswap"
sys.exit(main())' "$@"
`;
}

export function cswapInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(privateCswap(env));
}

/** Installs the pinned version into its own virtualenv. Throws with a plain message on failure. */
export function installCswap(log: (line: string) => void = (line) => process.stderr.write(`${line}\n`), env: NodeJS.ProcessEnv = process.env): string {
  const root = cswapRuntimeDir(env), venv = join(root, "venv"), python = join(venv, "bin", "python");
  if (process.platform === "win32") throw new Error("dswap's private cswap install needs Linux or macOS; install claude-swap yourself.");
  log(`Installing claude-swap ${CSWAP_VERSION} for dswap (one time)…`);
  rmSync(venv, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const ok = (command: string, args: string[]) => spawnSync(command, args, { stdio: "ignore", env: process.env }).status === 0;
  const spec = `claude-swap==${CSWAP_VERSION}`;
  const viaUv = ok("uv", ["venv", "--python", "3.12", venv]) && ok("uv", ["pip", "install", "--python", python, spec]);
  const viaPip = viaUv || (ok("python3", ["-m", "venv", venv]) && ok(python, ["-m", "pip", "install", "--quiet", spec]));
  if (!viaPip) {
    rmSync(venv, { recursive: true, force: true });
    throw new Error("Could not install claude-swap. Install uv (https://docs.astral.sh/uv/), which fetches the Python 3.12 it needs, then run: dswap runtime claude");
  }
  const launcher = privateCswap(env);
  writeFileSync(launcher, cswapWrapper(python), { mode: 0o755 });
  chmodSync(launcher, 0o755);
  log(`claude-swap ${CSWAP_VERSION} is installed (${root}).`);
  return launcher;
}

/** Installs the private copy once when it is missing; on failure dswap falls back to PATH. */
export function ensureCswap(env: NodeJS.ProcessEnv = process.env): void {
  if (env.BRIDGE_CSWAP_EXECUTABLE || cswapInstalled(env) || process.platform === "win32") return;
  try { installCswap(undefined, env); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\nUsing the cswap on your PATH instead.\n`); }
}
