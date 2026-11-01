import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * When Droid runs on another machine, this machine has no Droid session files, so the
 * bridge marks each request here and priming's "pause without Droid" rule reads it.
 */
export function droidActivityFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DSWAP_BRIDGE_ACTIVITY_FILE) return env.DSWAP_BRIDGE_ACTIVITY_FILE;
  return env.HOME ? join(env.HOME, ".local/state/factory-cc/droid-activity") : undefined;
}

let lastMark = 0;
/** At most one write a minute: the pause rule works in hours. */
export function markDroidActivity(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  const file = droidActivityFile(env);
  if (!file || now - lastMark < 60_000) return;
  lastMark = now;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
  } catch { /* a missing marker only makes priming pause sooner */ }
}

export function droidActivityMarkTime(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const file = droidActivityFile(env);
  if (!file) return undefined;
  try { return statSync(file).mtimeMs; } catch { return undefined; }
}
