import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../../scripts/dswap-tui.js";
import { parseRemotePrime, remoteStatusScript, remoteToggleScript, sshArgs } from "../../src/upstream/remote-prime.js";

const date = new Date(2026, 9, 31, 14, 0);

describe("priming on a server", () => {
  it("reads the server's state and today's pings", () => {
    const output = [
      "priming: on",
      "accounts: claude, codex, google · quiet: 03:00-05:00",
      "__DSWAP_LOG__",
      "2026-10-30 23:10:00 primed claude 2 (window ended, haiku); next reset ~04:10",
      "2026-10-31 13:05:00 primed codex default (window not started, default model, low effort); next reset ~18:05",
    ].join("\n");
    expect(parseRemotePrime("my-server", output, date)).toEqual({
      host: "my-server", state: "on", log: ["13:05:00 primed codex default (window not started, default model, low effort); next reset ~18:05"],
    });
    expect(parseRemotePrime("my-server", "priming: off\n__DSWAP_LOG__\n", date).state).toBe("off");
  });

  it("tells a missing dswap from an unreachable server", () => {
    expect(parseRemotePrime("my-server", "__DSWAP_MISSING__\n", date).state).toBe("missing");
    expect(parseRemotePrime("my-server", "bash: node: command not found\n", date)).toMatchObject({ state: "unreachable", detail: "bash: node: command not found" });
  });

  it("never lets a background check wait on an SSH prompt", () => {
    expect(sshArgs("my-server", "x")).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "my-server", "x"]);
    expect(sshArgs("my-server", "x", true)[0]).toBe("-t");
    expect(remoteStatusScript()).toContain('PATH="$HOME/.local/bin:$PATH"');
    expect(remoteToggleScript(false)).toMatch(/prime off$/);
  });

  it("stores and clears the server in dswap's settings", () => {
    const env = { DSWAP_SETTINGS: join(mkdtempSync(join(tmpdir(), "dswap-settings-")), "settings.json") };
    saveSettings({ logoAnimation: "off" }, env);
    saveSettings({ primeServer: "my-server" }, env);
    expect(loadSettings(env)).toEqual({ logoAnimation: "off", primeServer: "my-server" });
    saveSettings({ primeServer: undefined }, env);
    expect(JSON.parse(readFileSync(env.DSWAP_SETTINGS, "utf8"))).toEqual({ logoAnimation: "off" });
  });
});
