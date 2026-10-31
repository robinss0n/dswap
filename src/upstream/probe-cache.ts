import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Account checks shared between processes on this machine. Several dashboards and the priming
 * timer would otherwise each start Codex and Google's agent to read the same limits. A fresh
 * result on disk is reused; otherwise one process holds the account's lock and checks, and the
 * others wait for its result. Results hold plan, email and limits, never a token.
 */

export const DEFAULT_TTL_MS = 120_000;
const LOCK_STALE_MS = 3 * 60_000;
const WAIT_MS = 90_000;

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSWAP_CACHE_DIR ?? join(env.HOME ?? homedir(), ".local/share/factory-cc-accounts/cache");
}

const fileName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Entry<T> { at: number; value: T }

function read<T>(path: string): Entry<T> | undefined {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Entry<T> : undefined; } catch { return undefined; }
}

export interface CacheOptions<T> {
  /** How old a shared result may be and still be used. */
  ttlMs?: number;
  /** Results that must not be shared (e.g. a failed check), so the next caller tries again. */
  keep?: (value: T) => boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function cachedProbe<T>(key: string, probe: () => Promise<T>, options: CacheOptions<T> = {}): Promise<T> {
  const dir = cacheDir(options.env), now = options.now ?? Date.now, ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${fileName(key)}.json`), lock = join(dir, `${fileName(key)}.lock`);
  const fresh = (since: number) => { const entry = read<T>(path); return entry && entry.at >= since ? entry : undefined; };

  const cached = fresh(now() - ttl);
  if (cached) return cached.value;
  const started = now(), deadline = started + WAIT_MS;
  while (true) {
    try {
      mkdirSync(lock);
    } catch {
      // Another process is checking this account: use its result once it lands.
      const landed = fresh(started);
      if (landed) return landed.value;
      try { if (now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock); } catch { /* lock just released */ }
      if (now() > deadline) break;
      await sleep(250);
      continue;
    }
    try {
      // A result written while this caller waited counts, even with ttl 0.
      const raced = fresh(Math.min(now() - ttl, started));
      if (raced) return raced.value;
      const value = await probe();
      if (options.keep?.(value) ?? true) {
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ at: now(), value } satisfies Entry<T>), { mode: 0o600 });
        renameSync(temp, path);
      }
      return value;
    } finally {
      try { rmdirSync(lock); } catch { /* already gone */ }
    }
  }
  return probe();
}

/** Drop an account's shared result, e.g. after a ping changed its window. */
export function forgetProbe(key: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(cacheDir(env), `${fileName(key)}.json`), { force: true });
}
