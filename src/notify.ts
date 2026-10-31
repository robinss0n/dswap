import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Logger } from "./logging.js";

/**
 * Desktop notifications for things the user must know without watching logs,
 * such as a model losing "Droid's prompt only" because a fallback kicked in.
 * Best effort: a missing notifier never affects a request.
 */
export type Notify = (title: string, body: string) => void;

const WINDOWS_POWERSHELL = "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/** A PowerShell single-quoted string. */
const psQuote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** Windows toast from WSL, through Windows PowerShell's own app id (no module needed). */
export function windowsToastScript(title: string, body: string): string {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$x = $t.GetElementsByTagName('text')",
    `$x.Item(0).AppendChild($t.CreateTextNode(${psQuote(title)})) > $null`,
    `$x.Item(1).AppendChild($t.CreateTextNode(${psQuote(body)})) > $null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join("\n");
}

/** The command that shows a notification on this machine, or undefined if there is none. */
export function notificationCommand(title: string, body: string, platform: NodeJS.Platform = process.platform, wsl = isWsl()): [string, string[]] | undefined {
  if (platform === "darwin") {
    const quote = (text: string) => JSON.stringify(text);
    return ["osascript", ["-e", `display notification ${quote(body)} with title ${quote(title)}`]];
  }
  if (platform === "linux" && wsl && existsSync(WINDOWS_POWERSHELL)) {
    const encoded = Buffer.from(windowsToastScript(title, body), "utf16le").toString("base64");
    return [WINDOWS_POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]];
  }
  if (platform === "linux") return ["notify-send", [title, body]];
  return undefined;
}

export function desktopNotify(logger?: Logger): Notify {
  return (title, body) => {
    const command = notificationCommand(title, body);
    if (!command) return;
    try {
      const child = spawn(command[0], command[1], { stdio: "ignore", detached: true });
      child.on("error", () => logger?.warn("desktop_notification_failed", { command: command[0] }));
      child.unref();
    } catch {
      logger?.warn("desktop_notification_failed", { command: command[0] });
    }
  };
}

/**
 * One alert per fallback per bridge run: logged as `fallback_alert` and shown
 * on the desktop. `key` identifies the fallback (e.g. "google-patch-failed").
 */
export class FallbackAlerts {
  private readonly sent = new Set<string>();
  constructor(private readonly logger: Logger, private readonly notify: Notify = desktopNotify(logger)) {}

  alert(key: string, title: string, body: string): void {
    if (this.sent.has(key)) return;
    this.sent.add(key);
    this.logger.warn("fallback_alert", { key, title, body });
    this.notify(title, body);
  }
}
