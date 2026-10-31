import { describe, expect, it } from "vitest";
import type { Account } from "../../scripts/accounts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTRO_MS, box, clip, demoData, introFrame, logoAnimation, markLogoAnimationShown, normalize, setLogoAnimation, shouldShowLogoAnimation, suggest, visible } from "../../scripts/dswap-tui.js";

const claude: Account[] = [
  { provider: "claude", selector: "2", label: "2 work", email: "w@example.com", plan: "", status: "ok" },
  { provider: "claude", selector: "4", label: "4", email: "me@example.com", plan: "", status: "ok", active: true },
];
const codex: Account[] = [
  { provider: "codex", selector: "default", label: "default", email: "c@example.com", plan: "plus", status: "ok" },
  { provider: "codex", selector: "spare", label: "spare", email: "", plan: "", status: "logged_out" },
];

describe("dswap command box", () => {
  it("accepts /, bare and pasted `dswap` commands alike", () => {
    expect(normalize("/switch  2")).toBe("switch 2");
    expect(normalize("dswap remove claude 3")).toBe("remove claude 3");
    expect(normalize(" alias 4 main ")).toBe("alias 4 main");
  });

  it("completes command names, then offers accounts", () => {
    const [first] = suggest("/sw", claude, codex);
    expect(first).toMatchObject({ label: "switch <account>", completion: "switch ", runnable: false });
    expect(suggest("switch ", claude, codex).map((item) => item.completion)).toEqual(["switch 2", "switch 4"]);
    expect(suggest("switch w", claude, codex).map((item) => item.label)).toEqual(["switch 2"]);
    expect(suggest("alias 4", claude, codex)[0]).toMatchObject({ completion: "alias 4 ", runnable: false });
  });

  it("never offers to remove the default Codex login", () => {
    expect(suggest("remove codex ", claude, codex).map((item) => item.label)).toEqual(["remove codex spare"]);
    expect(suggest("login codex ", claude, codex)).toHaveLength(2);
  });

  it("matches the second word of two-word commands", () => {
    expect(suggest("codex", claude, codex).map((item) => item.label)).toEqual(["login codex [name]", "add codex <name>", "remove codex <name>"]);
  });
});

describe("dswap layout helpers", () => {
  it("clips colored text by visible width", () => {
    const colored = "\x1b[38;2;1;2;3mhello\x1b[39m world";
    expect(visible(colored)).toBe(11);
    expect(visible(clip(colored, 7))).toBe(7);
  });

  it("draws boxes whose every line has the same visible width", () => {
    const lines = box("Title", ["short", "a much longer line that will be clipped to fit inside"], 30, { right: "r" });
    expect(new Set(lines.map(visible))).toEqual(new Set([30]));
  });
});

describe("dswap demo", () => {
  it("uses only made-up accounts, one default Claude login, and an auto log in journal format", () => {
    const demo = demoData(new Date(2026, 9, 31, 12, 0, 0));
    const all = [...demo.claude, ...demo.codex, ...demo.google];
    expect(all.every((account) => !account.email || account.email.endsWith("@example.com"))).toBe(true);
    expect(demo.claude.filter((account) => account.active)).toHaveLength(1);
    expect(demo.journal.every((line) => /^\d\d:\d\d:\d\d\s/.test(line) && !/@(?!example\.com)/.test(line))).toBe(true);
    expect(demo.journal.at(-1)).toMatch(/^12:00:00 /);
  });
});

describe("dswap intro", () => {
  const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  const logoRows = (lines: string[]) => lines.map((line, index) => ({ index, text: strip(line) })).filter((row) => row.text.trim());

  it("draws the logo in the middle, then ends where the dashboard puts it", () => {
    const start = logoRows(introFrame(0, 100, 30));
    expect(start).toHaveLength(2);
    expect(start[0]!.index).toBe(14);
    expect(start[0]!.text.trim()).toHaveLength(1);
    const drawn = logoRows(introFrame(INTRO_MS.reveal, 100, 30));
    expect(drawn[0]!.text).toBe(`${" ".repeat(39)}█▀▄ █▀ █ █ █ ▄▀█ █▀█`);
    const end = logoRows(introFrame(INTRO_MS.reveal + INTRO_MS.hold + INTRO_MS.move, 100, 30));
    expect(end.map((row) => row.index)).toEqual([0, 1]);
    expect(end[1]!.text).toBe("  █▄▀ ▄█ ▀▄▀▄▀ █▀█ █▀▀");
  });
});

describe("dswap intro placement and setting", () => {
  const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  it("centers over the dashboard, not a wide terminal", () => {
    const row = introFrame(INTRO_MS.reveal, 300, 30).map(strip).find((line) => line.trim())!;
    expect(row.indexOf("█")).toBe(60);
  });

  it("follows Droid's rule: once plays one time, always keeps playing, off never", () => {
    const env = { DSWAP_SETTINGS: join(mkdtempSync(join(tmpdir(), "dswap-settings-")), "settings.json") };
    expect(logoAnimation(env)).toBe("once");
    expect(shouldShowLogoAnimation(env)).toBe(true);
    markLogoAnimationShown(env);
    expect(logoAnimation(env)).toBe("off");
    expect(shouldShowLogoAnimation(env)).toBe(false);
    setLogoAnimation("always", env);
    markLogoAnimationShown(env);
    expect(shouldShowLogoAnimation(env)).toBe(true);
    expect(() => setLogoAnimation("sometimes", env)).toThrow(/once, always or off/);
  });
});
