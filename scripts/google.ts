import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import {
  antigravityExecutable, antigravityRuntimeDir, GOOGLE_AUTH_METHOD, googleAccountsDir, googleSignedIn, initializeAgent, listGoogleAccounts, openAgent, validGoogleAccount,
} from "../src/upstream/google-accounts.js";

/**
 * Google accounts for `dswap`: install Google's Antigravity ACP agent from the
 * official ACP registry, then sign each account in with "Log in with Google".
 */

const REGISTRY = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

function platformKey(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${os}-${arch}`;
}

/** Download the registry's build for this machine, check its SHA-256, and point `current` at it. */
export async function installAntigravity(log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Promise<string> {
  const entry = await (await fetch(REGISTRY)).json() as { version: string; distribution: { binary: Record<string, { archive: string; sha256: string }> } };
  const build = entry.distribution.binary[platformKey()];
  if (!build) throw new Error(`Antigravity has no build for ${platformKey()}.`);
  const root = antigravityRuntimeDir(), dir = join(root, entry.version), current = join(root, "current");
  if (!existsSync(join(dir, "agy_acp_server.par")) && !existsSync(join(dir, "agy_acp_server.exe"))) {
    log(`Downloading Antigravity ${entry.version} (${platformKey()}, about 1 GB unpacked)…`);
    const response = await fetch(build.archive);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== build.sha256) throw new Error(`Checksum mismatch for ${build.archive}; nothing was installed.`);
    mkdirSync(dir, { recursive: true });
    const zip = join(tmpdir(), `agy-${entry.version}-${process.pid}.zip`);
    writeFileSync(zip, data);
    const unzip = spawnSync("unzip", ["-q", "-o", zip, "-d", dir], { stdio: "inherit" });
    rmSync(zip, { force: true });
    if (unzip.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error("unzip failed (is unzip installed?)."); }
    for (const file of ["agy_acp_server.par", "localharness_external"]) if (existsSync(join(dir, file))) chmodSync(join(dir, file), 0o755);
  }
  try { unlinkSync(current); } catch { /* first install */ }
  symlinkSync(entry.version, current);
  log(`Antigravity ${entry.version} is installed (${dir}).`);
  return entry.version;
}

export function antigravityInstalled(): boolean {
  return existsSync(antigravityExecutable());
}

/**
 * Opens a URL once in the user's browser. On WSL, Windows' URL handler takes the link as one
 * argument, so `&` in OAuth links survives (explorer.exe would open Documents instead).
 */
export function openBrowser(url: string): boolean {
  const [command, args] = isWsl() ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const isWsl = () => Boolean(process.env.WSL_DISTRO_NAME) || (() => { try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; } })();

/**
 * Sign one account in. The agent prints a Google link and waits on a 127.0.0.1 listener.
 * If the browser cannot reach it (another machine), pasting the final address here finishes it.
 */
export async function loginGoogle(name: string, create: boolean): Promise<number> {
  if (!validGoogleAccount(name)) throw new Error("Account names use letters, digits, dot, dash or underscore (not `auto`).");
  if (!antigravityInstalled()) await installAntigravity();
  const home = join(googleAccountsDir(), name);
  const existed = existsSync(home);
  if (create && existed) throw new Error(`Google account ${name} already exists. Log it in again with: dswap login google ${name}`);
  if (!create && !existed) throw new Error(`No Google account named ${name}. Add it with: dswap add google ${name}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);

  const out = (line: string) => process.stderr.write(`${line}\n`);
  out(`Signing in Google account ${name} (GEMINI_HOME=${home}).`);
  out("Use the Google account that has your Google AI Pro / Ultra plan.");
  let shownLink = false;
  const client = openAgent(home, {
    // The agent's own browser call is a no-op (`true`); dswap opens the link exactly once below.
    env: { ...process.env, BROWSER: "true" },
    stderr: (chunk) => {
      const link = /https:\/\/accounts\.google\.com\/\S+/.exec(chunk)?.[0];
      if (link && !shownLink) {
        shownLink = true;
        const opened = openBrowser(link);
        out(`\n${opened ? "Your browser should open the sign-in page. If it does not, open" : "Open"} this link to sign in:\n`);
        out(link);
        out("\nIf the last page fails to load, copy its whole address (starting http://127.0.0.1) and paste it here, then press Enter.\n");
      }
    },
  });
  const paste = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined;
  paste?.on("line", (line) => {
    const url = line.trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) { if (url) out("That is not the http://127.0.0.1 address from the last page."); return; }
    fetch(url).then(() => out("Sent. Finishing sign-in…")).catch((error) => out(`Could not hand the address to the sign-in listener: ${error instanceof Error ? error.message : error}`));
  });
  try {
    await initializeAgent(client);
    const auth = await client.request("authenticate", { methodId: GOOGLE_AUTH_METHOD }, 15 * 60_000);
    if (!googleSignedIn(home)) throw new Error("Sign-in finished but no login was saved.");
    const tier = auth?._meta?.antigravity?.tier?.name;
    out(`\nGoogle account ${name} is signed in${tier ? ` (${tier})` : ""}.`);
    return 0;
  } catch (error) {
    if (create && !googleSignedIn(home)) rmSync(home, { recursive: true, force: true });
    throw new Error(`Google sign-in did not finish${create ? "; nothing was kept" : ""}: ${error instanceof Error ? error.message : error}`);
  } finally {
    paste?.close();
    client.close();
  }
}

export function renameGoogle(from: string, to: string): number {
  const account = listGoogleAccounts().find((item) => item.name === from);
  if (!account) throw new Error(`No Google account named ${from}.`);
  if (!validGoogleAccount(to)) throw new Error("Account names use letters, digits, dot, dash or underscore (not `auto`).");
  const target = join(googleAccountsDir(), to);
  if (existsSync(target)) throw new Error(`Google account ${to} already exists.`);
  renameSync(account.home, target);
  process.stderr.write(`Renamed Google account ${from} to ${to}.\n`);
  return 0;
}

export function removeGoogle(name: string): number {
  const account = listGoogleAccounts().find((item) => item.name === name);
  if (!account) throw new Error(`No Google account named ${name}.`);
  rmSync(account.home, { recursive: true, force: true });
  process.stderr.write(`Removed Google account ${name} (its saved sign-in is deleted).\n`);
  return 0;
}
