import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * dswap started as a fork of factory-cc (Relay Bridge) and was renamed. Folders and
 * files on disk still carry the old name on machines installed before the rename.
 * Readers prefer the dswap name and fall back to the legacy one until
 * `npm run desktop -- restart` moves it (leaving a symlink behind).
 */
export const PRODUCT = "dswap";
export const LEGACY_PRODUCT = "factory-cc";

/** The dswap path if it exists, else the legacy path if that exists, else the dswap path. */
export function preferExisting(current: string, legacy: string): string {
  if (existsSync(current) || !existsSync(legacy)) return current;
  return legacy;
}

function share(env: NodeJS.ProcessEnv, name: string): string {
  return join(env.HOME ?? homedir(), ".local/share", name);
}

/** Per-account homes (Codex, Google), priming state and probe caches. */
export function accountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return preferExisting(share(env, "dswap-accounts"), share(env, "factory-cc-accounts"));
}

/** Downloaded helper runtimes (cswap, Antigravity). */
export function runtimesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return preferExisting(share(env, "dswap-runtimes"), share(env, "factory-cc-runtimes"));
}

/** The desktop service's state folder: tokens, launcher, logs and bridge data. */
export function stateRoot(home: string, platform: string = process.platform): { current: string; legacy: string } {
  return platform === "linux"
    ? { current: join(home, ".local/state/dswap"), legacy: join(home, ".local/state/factory-cc") }
    : { current: join(home, "Library/Application Support/dswap"), legacy: join(home, "Library/Application Support/factory-cc") };
}

export type MoveResult = "moved" | "already" | "absent" | "both-exist";

/**
 * Move a legacy folder to its dswap name once, then leave a symlink at the old path so
 * anything still using it (another machine's scripts, a running process) keeps working.
 */
export function moveLegacyFolder(current: string, legacy: string): MoveResult {
  const legacyIsLink = (() => { try { return lstatSync(legacy).isSymbolicLink(); } catch { return false; } })();
  if (!existsSync(legacy) || legacyIsLink) return existsSync(current) ? "already" : "absent";
  if (existsSync(current)) return "both-exist";
  mkdirSync(dirname(current), { recursive: true });
  renameSync(legacy, current);
  symlinkSync(current, legacy);
  return "moved";
}

/** Files Droid-side configuration keeps next to Droid's settings.json. */
export function settingsSidecars(settingsPath: string) {
  return {
    backup: `${settingsPath}.dswap.bak`, absent: `${settingsPath}.dswap.bak.absent`, metadata: `${settingsPath}.dswap.models.json`,
    legacy: { backup: `${settingsPath}.relay-bridge.bak`, absent: `${settingsPath}.relay-bridge.bak.absent`, metadata: `${settingsPath}.relay-bridge.models.json` },
  };
}

/** Rename legacy sidecars in place, once, so configure-droid keeps ownership of its entries. */
export function migrateSettingsSidecars(settingsPath: string): void {
  const sidecars = settingsSidecars(settingsPath);
  for (const key of ["backup", "absent", "metadata"] as const) {
    const legacy = sidecars.legacy[key];
    if (existsSync(legacy) && !existsSync(sidecars[key])) renameSync(legacy, sidecars[key]);
  }
}

/** Hook context marker binding a Droid session to its bridge host. The legacy form is still read. */
export const SESSION_MARKER = "dswap-session";
export const SESSION_MARKER_PATTERN = /\[(?:dswap|factory-cc)-session:([a-f0-9]{64})\]/g;
