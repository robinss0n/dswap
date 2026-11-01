import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { primeUnits } from "../../scripts/prime.js";
import { markDroidActivity } from "../../src/activity.js";
import {
  DEFAULT_PRIME_CONFIG, WINDOW_MS, decide, globalPause, inQuiet, lastDroidActivity, needsProbe, parseQuiet, primeLog, readPrimeLog, windowIdle,
  type PrimeState, type PrimeTarget,
} from "../../src/upstream/prime.js";

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const empty = (): PrimeState => ({ lastPing: {}, runningUntil: {}, lastProbe: {} });
const target = (extra: Partial<PrimeTarget> = {}): PrimeTarget => ({ provider: "claude", account: "2", label: "claude 2", usable: true, ...extra });

describe("window priming rules", () => {
  it("sees an idle window: none, no reset, reset passed, or Google's drifting 0% window", () => {
    expect(windowIdle(undefined, NOW)).toBe(true);
    expect(windowIdle({ usedPercent: 0 }, NOW)).toBe(true);
    expect(windowIdle({ usedPercent: 40, resetsAt: NOW - 1 }, NOW)).toBe(true);
    expect(windowIdle({ usedPercent: 0, resetsAt: NOW + WINDOW_MS }, NOW)).toBe(true);
    expect(windowIdle({ usedPercent: 0, resetsAt: NOW + 2 * 3_600_000 }, NOW)).toBe(false);
    expect(windowIdle({ usedPercent: 12, resetsAt: NOW + WINDOW_MS - 60_000 }, NOW)).toBe(false);
  });

  it("pings only usable accounts with room whose window is idle, once per window", () => {
    const state = empty();
    expect(decide(target({ fiveHour: { usedPercent: 0 } }), state, DEFAULT_PRIME_CONFIG, NOW)).toEqual({ ping: true, reason: "window not started" });
    expect(decide(target({ fiveHour: { usedPercent: 50, resetsAt: NOW - 5 } }), state, DEFAULT_PRIME_CONFIG, NOW).reason).toBe("window ended");
    expect(decide(target({ fiveHour: { usedPercent: 50, resetsAt: NOW + 3_600_000 } }), state, DEFAULT_PRIME_CONFIG, NOW)).toMatchObject({ ping: false, reason: "window running, resets in 1h 0m" });
    expect(decide(target({ weekly: { usedPercent: 95 } }), state, DEFAULT_PRIME_CONFIG, NOW)).toMatchObject({ ping: false, reason: "week at 95% (cap 90%)" });
    expect(decide(target({ usable: false, problem: "disabled" }), state, DEFAULT_PRIME_CONFIG, NOW)).toMatchObject({ ping: false, reason: "disabled" });
    expect(decide(target(), state, { ...DEFAULT_PRIME_CONFIG, providers: { claude: false, codex: true, google: true } }, NOW).ping).toBe(false);
    state.lastPing["claude:2"] = NOW - 60_000;
    expect(decide(target({ fiveHour: { usedPercent: 0, resetsAt: NOW + WINDOW_MS } }), state, DEFAULT_PRIME_CONFIG, NOW)).toMatchObject({ ping: false, reason: "pinged 1m ago" });
    state.lastPing["claude:2"] = NOW - WINDOW_MS;
    expect(decide(target(), state, DEFAULT_PRIME_CONFIG, NOW).ping).toBe(true);
  });

  it("keeps quiet hours, also across midnight, and pauses when Droid sat unused", () => {
    expect(parseQuiet("3-5")).toBe("03:00-05:00");
    expect(parseQuiet("23:30-6")).toBe("23:30-06:00");
    expect(() => parseQuiet("5")).toThrow();
    expect(inQuiet(new Date(2026, 9, 31, 4, 10), "03:00-05:00")).toBe(true);
    expect(inQuiet(new Date(2026, 9, 31, 5, 0), "03:00-05:00")).toBe(false);
    expect(inQuiet(new Date(2026, 9, 31, 1, 0), "23:30-06:00")).toBe(true);
    expect(inQuiet(new Date(2026, 9, 31, 12, 0), "23:30-06:00")).toBe(false);
    const noon = new Date(2026, 9, 31, 12, 0);
    expect(globalPause(DEFAULT_PRIME_CONFIG, noon, noon.getTime() - 9 * 3_600_000)).toMatch(/Droid unused for 9h/);
    expect(globalPause(DEFAULT_PRIME_CONFIG, noon, noon.getTime() - 3_600_000)).toBeUndefined();
    expect(globalPause(DEFAULT_PRIME_CONFIG, noon, undefined)).toBeUndefined();
    expect(globalPause({ ...DEFAULT_PRIME_CONFIG, idleHours: undefined }, noon, 0)).toBeUndefined();
  });

  it("probes an account again only when its window may have ended", () => {
    const state = empty();
    expect(needsProbe("codex:a", state, NOW)).toBe(true);
    state.runningUntil["codex:a"] = NOW + 3_600_000; state.lastProbe["codex:a"] = NOW - 10 * 60_000;
    expect(needsProbe("codex:a", state, NOW)).toBe(false);
    expect(needsProbe("codex:a", state, NOW + 3_600_000)).toBe(true);
    state.lastProbe["codex:a"] = NOW - 61 * 60_000;
    expect(needsProbe("codex:a", state, NOW)).toBe(true);
  });

  it("logs today's lines for the dashboard and reads Droid activity from file times only", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-"));
    const env = { BRIDGE_PRIME_DIR: dir, DSWAP_ACTIVITY_DIR: join(dir, "none") };
    primeLog("old", env, new Date(2026, 9, 30, 9, 0, 0));
    primeLog("primed claude 2", env, new Date(2026, 9, 31, 9, 15, 0));
    expect(readPrimeLog(40, env, new Date(2026, 9, 31, 18, 0))).toEqual(["09:15:00 primed claude 2"]);
    expect(lastDroidActivity(env)).toBeUndefined();
    expect(lastDroidActivity({ DSWAP_ACTIVITY_DIR: dir })).toBeGreaterThan(0);
  });

  it("counts the bridge's mark for a Droid on another machine", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-"));
    const env = { DSWAP_ACTIVITY_DIR: join(dir, "none"), DSWAP_BRIDGE_ACTIVITY_FILE: join(dir, "state/droid-activity") };
    expect(lastDroidActivity(env)).toBeUndefined();
    markDroidActivity(env, Date.now());
    expect(lastDroidActivity(env)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("runs from a oneshot service on a 5-minute timer that catches up after sleep", () => {
    const { service, timer } = primeUnits("/usr/bin/node", "/usr/bin:/bin");
    expect(service).toMatch(/Type=oneshot/);
    expect(service).toMatch(/accounts\.ts" prime --service/);
    expect(timer).toMatch(/OnCalendar=\*:0\/5/);
    expect(timer).toMatch(/Persistent=true/);
  });
});
