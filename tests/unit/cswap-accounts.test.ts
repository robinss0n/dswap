import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { accountFromModelId, modelsFromIds, resolveRequestModel, withAccounts } from "../../src/models.js";
import { CSWAP_LAUNCHER, pickAccount, resolveAccount } from "../../src/upstream/cswap.js";

const usage = (five: number, seven: number) => ({ fiveHour: { pct: five }, sevenDay: { pct: seven } });

describe("cswap account picking", () => {
  it("takes the usable account with the most headroom", () => {
    expect(pickAccount([
      { number: 2, usageStatus: "ok", usage: usage(0, 100) },
      { number: 3, usageStatus: "relogin_required", usage: null },
      { number: 4, usageStatus: "ok", usage: usage(40, 20) },
      { number: 5, usageStatus: "ok", usage: usage(10, 60) },
      { number: 6, usageStatus: "ok", disabled: true, usage: usage(0, 0) },
    ])).toBe("4");
  });

  it("skips excluded accounts and returns nothing when all are spent", () => {
    const accounts = [{ number: 2, usageStatus: "ok", usage: usage(0, 10) }, { number: 4, usageStatus: "ok", usage: usage(100, 0) }];
    expect(pickAccount(accounts, new Set(["2"]))).toBeUndefined();
  });
});

describe("account model ids", () => {
  it("parses acct:<account>:<model> and rejects malformed ids", () => {
    expect(accountFromModelId("acct:work:opus")).toEqual({ account: "work", model: "opus" });
    expect(accountFromModelId("acct:auto:claude-opus-5-5")).toEqual({ account: "auto", model: "claude-opus-5-5" });
    expect(accountFromModelId("acct::opus")).toBeUndefined();
    expect(accountFromModelId("opus")).toBeUndefined();
    expect(() => modelsFromIds(["acct:bad"], "subscription")).toThrow();
  });

  it("adds one entry per account and keeps the plain ones", () => {
    const models = withAccounts(modelsFromIds(["opus", "sonnet"], "subscription"), ["auto", "4"]);
    expect(models.map((item) => item.id)).toEqual(["opus", "sonnet", "acct:auto:opus", "acct:auto:sonnet", "acct:4:opus", "acct:4:sonnet"]);
    expect(models[2]).toEqual({ id: "acct:auto:opus", model: "opus", displayName: "Claude Opus · auto" });
    expect(() => withAccounts(models, ["auto", "auto"])).toThrow();
  });

  it("routes carry the account, and the route key changes with it", () => {
    const config = loadConfig({ mode: "sdk", authMode: "subscription", models: withAccounts(modelsFromIds(["opus"], "subscription"), ["2", "4"]) });
    const two = resolveRequestModel(config, "acct:2:opus"), four = resolveRequestModel(config, "acct:4:opus"), plain = resolveRequestModel(config, "opus");
    expect([two.account, two.model, plain.account]).toEqual(["2", "opus", undefined]);
    expect(new Set([two.routeKey, four.routeKey, plain.routeKey]).size).toBe(3);
  });
});

describe("cswap launcher", () => {
  const saved = process.env.BRIDGE_CSWAP_EXECUTABLE;
  afterEach(() => { if (saved === undefined) delete process.env.BRIDGE_CSWAP_EXECUTABLE; else process.env.BRIDGE_CSWAP_EXECUTABLE = saved; });

  function fakeCswap(listJson: string): string {
    const dir = mkdtempSync(join(tmpdir(), "fake-cswap-")), path = join(dir, "cswap");
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = list ]; then printf '%s' '${listJson}'; else printf '%s\\n' "$@"; fi\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("runs the chosen account with shared history and passes the SDK arguments through", () => {
    const fake = fakeCswap("{}");
    const out = execFileSync(CSWAP_LAUNCHER, ["--output-format", "stream-json"], { encoding: "utf8", env: { ...process.env, BRIDGE_CSWAP_EXECUTABLE: fake, BRIDGE_CSWAP_ACCOUNT: "4" } });
    expect(out.trim().split("\n")).toEqual(["run", "4", "--share-history", "--", "--output-format", "stream-json"]);
  });

  it("resolves auto from cswap list --json", () => {
    process.env.BRIDGE_CSWAP_EXECUTABLE = fakeCswap(JSON.stringify({ accounts: [{ number: 2, usageStatus: "ok", usage: usage(0, 100) }, { number: 4, usageStatus: "ok", usage: usage(5, 30) }] }));
    expect(resolveAccount("auto")).toBe("4");
    expect(resolveAccount("work")).toBe("work");
  });
});
