import { spawn, spawnSync } from "node:child_process";
import { primeLogLines } from "./prime.js";

/**
 * Priming on another machine, reached over SSH. Only its state and today's log are read; the
 * accounts and sign-ins on that machine stay there.
 */

export type RemotePrimeState = "on" | "off" | "unsupported" | "missing" | "unreachable";
export interface RemotePrime { host: string; state: RemotePrimeState; log: string[]; detail?: string }

const MISSING = "__DSWAP_MISSING__", LOG = "__DSWAP_LOG__";
/** Non-interactive SSH skips the login profile, so dswap's Node in ~/.local/bin is put on PATH here. */
const REMOTE_ENV = 'export PATH="$HOME/.local/bin:$PATH"; d="$HOME/.local/bin/dswap"';

export function remoteStatusScript(): string {
  return `${REMOTE_ENV}; [ -x "$d" ] || { echo ${MISSING}; exit 0; }; "$d" prime status; echo ${LOG}; tail -n 300 "$HOME/.local/share/factory-cc-accounts/prime/prime.log" 2>/dev/null; exit 0`;
}

export function remoteToggleScript(on: boolean): string {
  return `${REMOTE_ENV}; [ -x "$d" ] || { echo "dswap is not installed on this machine (~/.local/bin/dswap)." >&2; exit 1; }; "$d" prime ${on ? "on" : "off"}`;
}

/** SSH never asks for a password or a host key here: a dashboard refresh must not hang on a prompt. */
export const sshArgs = (host: string, script: string, terminal = false): string[] =>
  [...(terminal ? ["-t"] : ["-o", "BatchMode=yes"]), "-o", "ConnectTimeout=6", host, script];

export function parseRemotePrime(host: string, output: string, date = new Date()): RemotePrime {
  if (output.includes(MISSING)) return { host, state: "missing", log: [], detail: "dswap is not installed there" };
  const [status = "", log = ""] = output.split(LOG);
  const state = /^priming: (on|off|unsupported)\b/m.exec(status)?.[1] as RemotePrimeState | undefined;
  if (!state) return { host, state: "unreachable", log: [], detail: status.trim().split("\n").at(-1) || "no answer" };
  return { host, state, log: primeLogLines(log, 40, date) };
}

export function fetchRemotePrime(host: string, timeoutMs = 15_000): Promise<RemotePrime> {
  return new Promise((resolve) => {
    const child = spawn("ssh", sshArgs(host, remoteStatusScript()), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ host, state: "unreachable", log: [], detail: error.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve({ host, state: "unreachable", log: [], detail: err.trim().split("\n").at(-1) || `ssh exited with ${code}` }); return; }
      resolve(parseRemotePrime(host, out));
    });
  });
}

/** Turns priming on or off on the server, in this terminal (so SSH can ask for anything it needs). */
export function setRemotePrime(host: string, on: boolean): void {
  const result = spawnSync("ssh", sshArgs(host, remoteToggleScript(on), true), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ssh ${host} exited with ${result.status}.`);
}
