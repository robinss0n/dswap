import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCodexAccounts, pickCodexAccount, probeCodexAccount, type CodexAccountStatus } from "../../src/upstream/codex-accounts.js";
import { claudeRows, codexRows, renderTable } from "../../scripts/accounts.js";

/** A fake `codex app-server`: answers by CODEX_HOME's FAKE file, never touching the network. */
function fakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-")), path = join(dir, "codex");
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs"); const mode = fs.readFileSync(process.env.CODEX_HOME + "/FAKE", "utf8").trim();
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === "initialize") return send({ id: m.id, result: { codexHome: process.env.CODEX_HOME } });
  if (m.method === "account/read") return send({ id: m.id, result: { account: mode === "out" ? null : { type: "chatgpt", email: mode + "@example.com", planType: "plus" } } });
  if (m.method === "account/rateLimits/read") return send({ id: m.id, result: { rateLimits: { primary: { usedPercent: mode === "full" ? 100 : 20, windowDurationMins: 300 }, secondary: { usedPercent: mode === "busy" ? 70 : 10, windowDurationMins: 10080 } } } });
  send({ id: m.id, error: { code: -32601, message: "unknown" } }); });
`);
  chmodSync(path, 0o755);
  return path;
}

function homes(modes: Record<string, string>): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "codex-accounts-")), dir = join(root, "accounts");
  const env: NodeJS.ProcessEnv = { HOME: root, CODEX_HOME: join(root, "default-home"), BRIDGE_CODEX_ACCOUNTS_DIR: dir };
  for (const [name, mode] of Object.entries(modes)) {
    const home = name === "default" ? env.CODEX_HOME! : join(dir, name);
    mkdirSync(home, { recursive: true }); writeFileSync(join(home, "FAKE"), mode);
  }
  return env;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("Codex accounts", () => {
  it("lists the default login first, then named accounts", () => {
    const env = homes({ default: "a", work: "b", "bad name": "c" });
    expect(listCodexAccounts(env).map((account) => account.name)).toEqual(["default", "work"]);
  });

  it("probes each account through its own CODEX_HOME and picks the one with headroom", async () => {
    vi.stubEnv("BRIDGE_CODEX_EXECUTABLE", fakeCodex());
    const env = homes({ default: "full", work: "busy", spare: "fresh", gone: "out" });
    const statuses = await Promise.all(listCodexAccounts(env).map((account) => probeCodexAccount(account)));
    const byName = Object.fromEntries(statuses.map((status) => [status.name, status]));
    expect(byName.default).toMatchObject({ status: "limited", email: "full@example.com", plan: "plus", fiveHour: { usedPercent: 100 } });
    expect(byName.gone!.status).toBe("logged_out");
    expect(pickCodexAccount(statuses)).toBe("spare");
    expect(pickCodexAccount(statuses, new Set(["spare"]))).toBe("work");
  });
});

describe("account overview table", () => {
  it("renders Claude and Codex rows in aligned columns", () => {
    const codex: CodexAccountStatus[] = [{ name: "default", home: "/x", status: "ok", email: "c@example.com", plan: "plus", fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 40 } }];
    const rows = [...claudeRows([{ number: 4, alias: "main", email: "a@example.com", organizationName: "Org", usageStatus: "ok", usage: { fiveHour: { pct: 100 }, sevenDay: { pct: 5 } } }] as any), ...codexRows(codex)];
    expect(rows.map((row) => row.status)).toEqual(["limited", "ok"]);
    const lines = renderTable(rows).trimEnd().split("\n");
    expect(lines[0]).toMatch(/^PROVIDER\s+ACCOUNT\s+EMAIL/);
    expect(lines[1]).toContain("4 main"); expect(lines[2]).toContain("12%");
    expect(lines[1]!.indexOf("a@example.com")).toBe(lines[2]!.indexOf("c@example.com"));
  });
});
