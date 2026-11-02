import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDroid, DROID_MAX_OUTPUT_TOKENS } from "../../scripts/configure-droid.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("writes the output ceiling and the measured Codex window", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-configure-limits-"));
  directories.push(directory);
  const settings = join(directory, "settings.json");
  const catalog = [
    { id: "codex:default:gpt-6.1-sol", model: "gpt-6.1-sol", provider: "codex" as const, displayName: "Codex · gpt-6.1-sol" },
    { id: "codex:default:gpt-6-astra", model: "gpt-6-astra", provider: "codex" as const, displayName: "Codex · gpt-6-astra" },
  ];
  configureDroid(["--settings", settings, "--manifest", join(directory, "manifest.env"), "--preserve-selections"], { BRIDGE_CLIENT_TOKEN: "test" }, catalog);
  const models = JSON.parse(readFileSync(settings, "utf8")).customModels as Array<Record<string, unknown>>;
  expect(models.map((model) => model.maxOutputTokens)).toEqual([DROID_MAX_OUTPUT_TOKENS, DROID_MAX_OUTPUT_TOKENS]);
  expect(models[0]).toMatchObject({ baseModelId: "gpt-6.1-sol", maxContextLimit: 475_000 });
  // Not measured yet: Droid keeps its default.
  expect(models[1]).not.toHaveProperty("maxContextLimit");
});
