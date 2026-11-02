import { afterEach, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsRoot, migrateSettingsSidecars, moveLegacyFolder, preferExisting, SESSION_MARKER_PATTERN } from "../../src/names.js";
import { redactValue } from "../../src/security/redact.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "dswap-names-")); roots.push(root); return root; };

it("prefers the dswap folder and falls back to the legacy one until it moves", () => {
  const home = temp();
  const env = { HOME: home };
  expect(accountsRoot(env)).toBe(join(home, ".local/share/dswap-accounts"));
  mkdirSync(join(home, ".local/share/factory-cc-accounts"), { recursive: true });
  expect(accountsRoot(env)).toBe(join(home, ".local/share/factory-cc-accounts"));
  expect(moveLegacyFolder(join(home, ".local/share/dswap-accounts"), join(home, ".local/share/factory-cc-accounts"))).toBe("moved");
  expect(accountsRoot(env)).toBe(join(home, ".local/share/dswap-accounts"));
  expect(lstatSync(join(home, ".local/share/factory-cc-accounts")).isSymbolicLink()).toBe(true);
  expect(moveLegacyFolder(join(home, ".local/share/dswap-accounts"), join(home, ".local/share/factory-cc-accounts"))).toBe("already");
  expect(preferExisting(join(home, "a"), join(home, "b"))).toBe(join(home, "a"));
});

it("never merges two real folders", () => {
  const root = temp();
  mkdirSync(join(root, "new")); mkdirSync(join(root, "old"));
  expect(moveLegacyFolder(join(root, "new"), join(root, "old"))).toBe("both-exist");
  expect(lstatSync(join(root, "old")).isDirectory()).toBe(true);
});

it("renames legacy Droid-side files once, without overwriting new ones", () => {
  const root = temp();
  const settings = join(root, "settings.json");
  writeFileSync(`${settings}.relay-bridge.models.json`, "legacy");
  writeFileSync(`${settings}.relay-bridge.bak`, "old-backup");
  writeFileSync(`${settings}.dswap.bak`, "new-backup");
  migrateSettingsSidecars(settings);
  expect(readFileSync(`${settings}.dswap.models.json`, "utf8")).toBe("legacy");
  expect(readFileSync(`${settings}.dswap.bak`, "utf8")).toBe("new-backup");
  expect(existsSync(`${settings}.relay-bridge.bak`)).toBe(true);
});

it("reads both session markers and redacts both", () => {
  const token = "a".repeat(64);
  const text = `x [dswap-session:${token}] y [factory-cc-session:${token}] z`;
  expect([...text.matchAll(SESSION_MARKER_PATTERN)].map((match) => match[1])).toEqual([token, token]);
  expect(redactValue(text)).toBe("x [dswap-session:redacted] y [factory-cc-session:redacted] z");
});
