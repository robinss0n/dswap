import { describe, expect, it } from "vitest";
import { FallbackAlerts, notificationCommand, windowsToastScript } from "../../src/notify.js";

const logger = { info() {}, warn() {}, error() {} };

describe("notificationCommand", () => {
  it("uses osascript on macOS and notify-send on plain Linux", () => {
    expect(notificationCommand("T", "B", "darwin", false)).toEqual(["osascript", ["-e", 'display notification "B" with title "T"']]);
    expect(notificationCommand("T", "B", "linux", false)).toEqual(["notify-send", ["T", "B"]]);
  });

  it("escapes single quotes in the Windows toast script", () => {
    const script = windowsToastScript("it's", "Droid's prompt");
    expect(script).toContain("CreateTextNode('it''s')");
    expect(script).toContain("CreateTextNode('Droid''s prompt')");
  });
});

describe("FallbackAlerts", () => {
  it("shows each fallback once per bridge run", () => {
    const shown: string[] = [];
    const alerts = new FallbackAlerts(logger, (title, body) => shown.push(`${title}|${body}`));
    alerts.alert("google-patch-failed", "T", "B");
    alerts.alert("google-patch-failed", "T", "B");
    alerts.alert("codex-catalog-default", "T2", "B2");
    expect(shown).toEqual(["T|B", "T2|B2"]);
  });
});
