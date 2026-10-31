import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../types.js";

/**
 * Multi-account routing through claude-swap (`cswap`). cswap owns every stored
 * login and its token refresh; Bridge never reads or copies a credential. A
 * route with an account starts Claude Code through `cswap run <account>`,
 * which points CLAUDE_CONFIG_DIR at that account's profile. History is shared
 * (`--share-history`) so a conversation can resume after switching accounts.
 */

/** `auto` picks the stored account with the most headroom when each native process starts. */
export const AUTO_ACCOUNT = "auto";

/** Wrapper used as the Claude Code executable for account routes. */
export const CSWAP_LAUNCHER = fileURLToPath(new URL("../../scripts/cswap-claude.sh", import.meta.url));

const accountPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validAccount(value: string): boolean {
  return accountPattern.test(value);
}

interface CswapWindow { pct?: number }
interface CswapAccount {
  number: number;
  alias?: string;
  usageStatus?: string;
  disabled?: boolean;
  usage?: { fiveHour?: CswapWindow; sevenDay?: CswapWindow } | null;
}

/** Highest usage across the 5-hour and 7-day windows, 0-100. Unknown usage sorts last. */
function load(account: CswapAccount): number {
  const windows = [account.usage?.fiveHour?.pct, account.usage?.sevenDay?.pct].filter((pct): pct is number => typeof pct === "number");
  return windows.length ? Math.max(...windows) : 101;
}

/** Choose the usable account with the lowest load; ties go to the lower slot number. */
export function pickAccount(accounts: CswapAccount[], exclude: ReadonlySet<string> = new Set()): string | undefined {
  const usable = accounts.filter((account) => account.usageStatus === "ok" && account.disabled !== true
    && !exclude.has(String(account.number)) && load(account) < 100);
  usable.sort((a, b) => load(a) - load(b) || a.number - b.number);
  return usable[0] ? String(usable[0].number) : undefined;
}

export function listAccounts(command = process.env.BRIDGE_CSWAP_EXECUTABLE ?? "cswap"): CswapAccount[] {
  let output: string;
  try {
    output = execFileSync(command, ["list", "--json"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new BridgeError(503, "cswap_unavailable", "cswap list --json failed. Check that claude-swap is installed and has accounts.");
  }
  const parsed = JSON.parse(output) as { accounts?: unknown };
  if (!Array.isArray(parsed.accounts)) throw new BridgeError(503, "cswap_unavailable", "cswap list --json returned no account list.");
  return parsed.accounts as CswapAccount[];
}

/** Resolve a route's account to a concrete cswap selector (slot number, alias or email). */
export function resolveAccount(account: string, exclude?: ReadonlySet<string>): string {
  if (account !== AUTO_ACCOUNT) return account;
  const picked = pickAccount(listAccounts(), exclude);
  if (!picked) throw new BridgeError(429, "no_account_available", "Every cswap account is rate limited, disabled or needs a new login.");
  return picked;
}
