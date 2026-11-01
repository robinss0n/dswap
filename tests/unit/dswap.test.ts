import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accounts, claudeAccounts, codexAccounts, countdown, poolSummary, renderTable, toRow } from "../../scripts/accounts.js";

const NOW = Date.parse("2026-10-31T10:00:00Z");

describe("dswap account model", () => {
  it("formats reset countdowns", () => {
    expect(countdown(NOW + 45 * 60_000, NOW)).toBe("45m");
    expect(countdown(NOW + (4 * 60 + 39) * 60_000, NOW)).toBe("4h 39m");
    expect(countdown(NOW + (2 * 1440 + 6 * 60 + 10) * 60_000, NOW)).toBe("2d 6h");
    expect(countdown(undefined, NOW)).toBeUndefined();
  });

  it("marks the active Claude login and shows the busier window's reset", () => {
    const [active, idle, expired] = claudeAccounts([
      { number: 4, email: "a@example.com", organizationName: "Org", active: true, usageStatus: "ok",
        usage: { fiveHour: { pct: 5, resetsAt: "2026-10-31T14:39:00Z" }, sevenDay: { pct: 67, resetsAt: "2026-11-02T16:00:00Z" } } },
      { number: 2, alias: "work", email: "b@example.com", usageStatus: "ok", usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 0, resetsAt: "2026-11-06T18:00:00Z" } } },
      { number: 3, email: "c@example.com", usageStatus: "relogin_required", usage: null },
    ] as any, NOW);
    expect(active).toMatchObject({ selector: "4", active: true, fiveHour: 5, weekly: 67, resets: "2d 6h", status: "ok" });
    expect(idle).toMatchObject({ selector: "2", label: "2 work", active: false });
    expect(idle!.resets).toBeUndefined();
    expect(expired).toMatchObject({ status: "relogin_required" });
    expect(expired!.detail).toMatch(/log in again/);
    expect(toRow(active!).status).toBe("ok (active)");
  });

  it("shows a spent Codex window's reset before the busier one", () => {
    const [codex] = codexAccounts([{ name: "default", home: "/x", status: "limited", email: "c@example.com", plan: "plus",
      fiveHour: { usedPercent: 100, resetsAt: NOW / 1000 + 30 * 60 }, weekly: { usedPercent: 65, resetsAt: NOW / 1000 + 3 * 86_400 } }], NOW);
    expect(codex).toMatchObject({ resets: "30m", fiveHour: 100, weekly: 65 });
    const lines = renderTable([toRow(codex!)]).split("\n");
    expect(lines[0]).toMatch(/5H\s+WEEK\s+RESETS\s+STATUS$/);
    expect(lines[1]).toMatch(/100%\s+65%\s+30m\s+limited$/);
  });
});

describe("dswap subcommands call cswap", () => {
  const saved = process.env.BRIDGE_CSWAP_EXECUTABLE;
  afterEach(() => { process.env.BRIDGE_CSWAP_EXECUTABLE = saved; });

  function fakeCswap(): string {
    const dir = mkdtempSync(join(tmpdir(), "fake-cswap-")), log = join(dir, "calls"), path = join(dir, "cswap");
    writeFileSync(path, `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(path, 0o755);
    process.env.BRIDGE_CSWAP_EXECUTABLE = path;
    return log;
  }

  it("maps switch, enable, disable, alias and remove, with or without `claude`", async () => {
    const log = fakeCswap();
    for (const argv of [["switch", "4"], ["switch"], ["use", "claude", "2"], ["disable", "3"], ["enable", "claude", "3"],
      ["alias", "2", "work"], ["alias", "claude", "2", "--unset"], ["remove", "claude", "3"]]) {
      expect(await accounts(argv)).toBe(0);
    }
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "switch 4", "switch", "switch 2", "disable 3", "enable 3", "alias 2 work", "alias 2 --unset", "remove 3",
    ]);
  });

  it("prints usage for unknown or incomplete commands", async () => {
    fakeCswap();
    await expect(accounts(["disable"])).rejects.toThrow(/Usage: dswap/);
    await expect(accounts(["frobnicate"])).rejects.toThrow(/dswap switch/);
  });
});

describe("pool summary", () => {
  it("averages usable accounts per provider and names the provider tier models use", () => {
    const base = { selector: "1", label: "1", email: "", plan: "" };
    const summary = poolSummary([
      { ...base, provider: "claude", fiveHour: 0, weekly: 100, status: "limited" },
      { ...base, provider: "claude", fiveHour: 23, weekly: 36, status: "ok" },
      { ...base, provider: "claude", fiveHour: 0, weekly: 93, status: "ok" },
      { ...base, provider: "claude", fiveHour: 0, weekly: 0, status: "disabled", disabled: true },
      { ...base, provider: "codex", fiveHour: 22, weekly: 88, status: "ok" },
    ]);
    expect(summary).toContain("claude combined (3): 5h 8% · week 76%");
    expect(summary).toContain("codex combined (1): 5h 22% · week 88%");
    expect(summary).toContain("now go to claude");
  });
});
