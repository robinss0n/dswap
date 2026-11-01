import { describe, expect, it } from "vitest";
import { codexModels, modelsFromIds } from "../../src/models.js";
import { chooseProvider, combinedLoad, conversationKey, ModelRouter, routeModels, routeTarget, routeTier, type ProviderLoads } from "../../src/routing.js";
import type { MessagesRequest } from "../../src/types.js";

const catalog = [...modelsFromIds(["sonnet", "opus", "haiku"], "claude-config"), ...codexModels(["gpt-6.1-sol"], ["default"]), ...routeModels()];
const request = (first: string, later: string[] = []): MessagesRequest => ({ model: "route:medium", max_tokens: 1,
  messages: [{ role: "user", content: first }, ...later.flatMap((text) => [{ role: "assistant" as const, content: "ok" }, { role: "user" as const, content: text }])] });

describe("quota routing", () => {
  it("averages each window over all accounts and reports the fuller window", () => {
    // Today's accounts: Claude 1 (0% / 100%), 2 (23% / 36%), 3 (0% / 93%).
    const claude = combinedLoad([{ fiveHour: 0, week: 100 }, { fiveHour: 23, week: 36 }, { fiveHour: 0, week: 93 }])!;
    expect(claude.fiveHour).toBeCloseTo(7.67, 1);
    expect(claude.week).toBeCloseTo(76.33, 1);
    expect(claude.load).toBeCloseTo(76.33, 1);
    expect(combinedLoad([])).toBeUndefined();
  });

  it("prefers Codex below 77%, then whichever pool has more room", () => {
    expect(chooseProvider(76, 10)).toBe("codex");
    expect(chooseProvider(88, 76.3)).toBe("claude");
    expect(chooseProvider(80, 90)).toBe("codex");
    expect(chooseProvider(undefined, 50)).toBe("claude");
    expect(chooseProvider(40, undefined)).toBe("codex");
  });

  it("maps tiers to the menu, keeping validators and the fallback on Claude", () => {
    expect(routeTier("route:heavy")).toBe("heavy");
    expect(routeTier("route:other")).toBeUndefined();
    expect(routeTarget("medium", "codex", catalog)).toBe("codex:default:gpt-6.1-sol");
    expect(routeTarget("validator", "codex", catalog)).toBe("opus");
    expect(routeTarget("light", "claude", catalog)).toBe("haiku");
    expect(routeTarget("heavy", "claude", catalog)).toBe("opus");
    expect(routeTarget("medium", "codex", catalog.filter((model) => model.provider !== "codex"))).toBe("sonnet");
  });

  it("keeps one conversation on its first choice while quota changes", async () => {
    let loads: ProviderLoads = { codex: { accounts: 1, load: 20 }, claude: { accounts: 3, load: 50 } };
    let now = 0;
    const router = new ModelRouter(() => catalog, async () => loads, () => now, 1000);
    const key = conversationKey(request("task A"), "/project");
    expect((await router.resolve("route:medium", key))?.target).toBe("codex:default:gpt-6.1-sol");
    loads = { codex: { accounts: 1, load: 95 }, claude: { accounts: 3, load: 50 } };
    now = 5000;
    // The same conversation, one turn later, sends the same first message.
    const later = conversationKey(request("task A", ["next step"]), "/project");
    expect(later).toBe(key);
    expect(await router.resolve("route:medium", later)).toMatchObject({ target: "codex:default:gpt-6.1-sol", reused: true });
    expect(await router.resolve("route:medium", conversationKey(request("task B"), "/project"))).toMatchObject({ target: "sonnet", provider: "claude", reused: false });
    expect(await router.resolve("sonnet", key)).toBeUndefined();
  });
});
