import { mkdirSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedProbe, forgetProbe } from "../../src/upstream/probe-cache.js";

const setup = () => ({ DSWAP_CACHE_DIR: mkdtempSync(join(tmpdir(), "probe-cache-")) });
const counter = (value = "ok", delay = 50) => {
  let calls = 0;
  return { probe: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, delay)); return { status: value, n: calls }; }, calls: () => calls };
};

describe("shared account checks", () => {
  it("lets callers at the same time share one check", async () => {
    const env = setup(), check = counter();
    const results = await Promise.all([1, 2, 3].map(() => cachedProbe("google-main", check.probe, { env, ttlMs: 0 })));
    expect(check.calls()).toBe(1);
    expect(results.every((result) => result.n === 1)).toBe(true);
  });

  it("reuses a fresh result and checks again once it is too old", async () => {
    const env = setup(), check = counter();
    let now = 1_000_000;
    await cachedProbe("codex-a", check.probe, { env, now: () => now });
    now += 60_000;
    await cachedProbe("codex-a", check.probe, { env, now: () => now, ttlMs: 120_000 });
    expect(check.calls()).toBe(1);
    now += 61_000;
    await cachedProbe("codex-a", check.probe, { env, now: () => now, ttlMs: 120_000 });
    expect(check.calls()).toBe(2);
    forgetProbe("codex-a", env);
    await cachedProbe("codex-a", check.probe, { env, now: () => now, ttlMs: 120_000 });
    expect(check.calls()).toBe(3);
  });

  it("does not share a failed check and recovers from a lock left by a crashed dswap", async () => {
    const env = setup(), failing = counter("error", 0);
    await cachedProbe("google-x", failing.probe, { env, keep: (result) => result.status !== "error" });
    await cachedProbe("google-x", failing.probe, { env, keep: (result) => result.status !== "error" });
    expect(failing.calls()).toBe(2);

    const lock = join(env.DSWAP_CACHE_DIR, "codex-b.lock");
    mkdirSync(lock);
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(lock, old, old);
    const check = counter("ok", 0);
    await expect(cachedProbe("codex-b", check.probe, { env })).resolves.toMatchObject({ status: "ok" });
    expect(() => statSync(lock)).toThrow();
  });
});
