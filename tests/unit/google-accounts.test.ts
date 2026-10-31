import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { googleAccounts } from "../../scripts/accounts.js";
import { suggest } from "../../scripts/dswap-tui.js";
import { googleFromModelId, googleModels, providerFromModelId, validateModels } from "../../src/models.js";
import { antigravityArgs, antigravityEnv, googleSignedIn, listGoogleAccounts, parseUsageReport, pickGoogleAccount, usageError, type GoogleAccountStatus } from "../../src/upstream/google-accounts.js";

const REPORT = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  - **5-Hour Limit Remaining:** 40% remaining (resets Oct 31, 2026, 15:00 UTC)
  - **Weekly Limit Remaining:** 91% remaining (resets Nov 06, 2026, 08:22 UTC)
- **Claude and GPT models**
  - **Weekly Limit Remaining:** 100% remaining`;

describe("Google model ids", () => {
  it("routes google:<account>:<model> to the Google runtime", () => {
    expect(googleFromModelId("google:main:gemini-3.8-pro-high")).toEqual({ account: "main", model: "gemini-3.8-pro-high" });
    expect(googleFromModelId("google:bad")).toBeUndefined();
    expect(providerFromModelId("google:auto:gemini-3.8-flash-low")).toBe("google");
  });

  it("names menu entries by account only when there are several", () => {
    expect(googleModels(["gemini-3.8-flash-low"], ["main"]).map((model) => model.displayName)).toEqual(["Google · gemini-3.8-flash-low"]);
    const two = googleModels(["m"], ["main", "auto"]);
    expect(two.map((model) => model.id)).toEqual(["google:main:m", "google:auto:m"]);
    expect(two.map((model) => model.displayName)).toEqual(["Google · m · main", "Google · m · auto"]);
    expect(two.every((model) => model.provider === "google")).toBe(true);
  });

  it("rejects a Google entry whose id and model disagree", () => {
    expect(() => validateModels([{ id: "google:main:a", model: "b", displayName: "x", provider: "google" }])).toThrow(/google:<account>:<model>/);
  });
});

describe("Google accounts", () => {
  it("parses the agent's /usage report into windows", () => {
    const [gemini, other] = parseUsageReport(REPORT);
    expect(gemini).toMatchObject({ name: "Gemini Models", fiveHour: { usedPercent: 60, resetsAt: Date.UTC(2026, 9, 31, 15, 0) }, weekly: { usedPercent: 9, resetsAt: Date.UTC(2026, 10, 6, 8, 22) } });
    expect(other).toMatchObject({ name: "Claude and GPT models", weekly: { usedPercent: 0 } });
    expect(other!.weekly!.resetsAt).toBeUndefined();
    expect(usageError("### Quota Limits\n- Unable to retrieve quota status (User not onboarded (no project ID))")).toBe("User not onboarded (no project ID)");
  });

  it("lists account homes and sees a sign-in only by the token file's presence", () => {
    const dir = mkdtempSync(join(tmpdir(), "google-accounts-"));
    for (const name of ["work", "main", "bad name", "auto"]) mkdirSync(join(dir, name), { recursive: true });
    mkdirSync(join(dir, "main", "antigravity-acp"), { recursive: true });
    writeFileSync(join(dir, "main", "antigravity-acp", "acp_token.json"), "{}");
    const accounts = listGoogleAccounts({ BRIDGE_GOOGLE_ACCOUNTS_DIR: dir });
    expect(accounts.map((account) => account.name)).toEqual(["main", "work"]);
    expect(accounts.map((account) => googleSignedIn(account.home))).toEqual([true, false]);
  });

  it("gives each agent its own home and no ambient Google keys", () => {
    const env = antigravityEnv("/h/main", { PATH: "/bin", GEMINI_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/c", GEMINI_HOME: "/other" });
    expect(env).toEqual({ PATH: "/bin", GEMINI_HOME: "/h/main", GEMINI_FORCE_FILE_STORAGE: "true" });
    expect(antigravityArgs("linux")).toEqual(["--uid="]);
    expect(antigravityArgs("darwin")).toEqual([]);
  });

  it("picks the usable account with the most room", () => {
    const status = (name: string, used: number, state: GoogleAccountStatus["status"] = "ok"): GoogleAccountStatus => ({ name, home: `/h/${name}`, status: state, weekly: { usedPercent: used } });
    expect(pickGoogleAccount([status("a", 80), status("b", 20), status("c", 5, "logged_out")])).toBe("b");
    expect(pickGoogleAccount([status("a", 80)], new Set(["a"]))).toBeUndefined();
  });

  it("shows plan, limits and the other model group in dswap", () => {
    const [row] = googleAccounts([{ name: "main", home: "/h", status: "ok", plan: "Google AI Pro", groups: parseUsageReport(REPORT),
      fiveHour: { usedPercent: 60, resetsAt: Date.UTC(2026, 9, 31, 15, 0) }, weekly: { usedPercent: 9, resetsAt: Date.UTC(2026, 10, 6, 8, 22) } }], Date.UTC(2026, 9, 31, 12, 0));
    expect(row).toMatchObject({ provider: "google", selector: "main", plan: "Google AI Pro", fiveHour: 60, weekly: 9, resets: "3h 0m", fiveHourResets: "3h 0m" });
    expect(row!.detail).toBe("Claude and GPT models: week 0%");
  });

  it("suggests Google accounts in the command box", () => {
    const google = googleAccounts([{ name: "main", home: "/h", status: "ok", plan: "Google AI Pro" }, { name: "alt", home: "/h2", status: "ok" }]);
    expect(suggest("remove google m", [], [], google).map((item) => item.label)).toEqual(["remove google main"]);
    expect(suggest("rename google alt", [], [], google)[0]).toMatchObject({ completion: "rename google alt ", runnable: false });
  });
});
