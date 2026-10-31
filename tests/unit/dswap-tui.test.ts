import { describe, expect, it } from "vitest";
import type { Account } from "../../scripts/accounts.js";
import { box, clip, demoData, normalize, suggest, visible } from "../../scripts/dswap-tui.js";

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
