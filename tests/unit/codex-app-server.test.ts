import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../../src/runtime/codex/app-server.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(),
  });
}

describe("CodexAppServer stderr", () => {
  it("retains a bounded byte tail even without a logging callback", () => {
    const child = fakeChild();
    const server = new CodexAppServer({ spawnProcess: () => child as unknown as ChildProcess });
    child.stderr.write("discard-me" + "x".repeat(20_000) + "panic: config error\n");
    expect(Buffer.byteLength(server.stderrTail())).toBe(8192);
    expect(server.stderrTail()).not.toContain("discard-me");
    expect(server.stderrTail()).toMatch(/panic: config error\n$/);
    server.close();
  });

  it("emits complete lines, split UTF-8, and an unterminated final diagnostic", async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const server = new CodexAppServer({ spawnProcess: () => child as unknown as ChildProcess, onStderr: (line) => lines.push(line) });
    child.stderr.write("warn");
    child.stderr.write("ing\r\nnext ");
    const unicode = Buffer.from("é");
    child.stderr.write(unicode.subarray(0, 1));
    child.stderr.write(unicode.subarray(1));
    child.stderr.end(" panic");
    await new Promise<void>((resolve) => child.stderr.once("end", resolve));
    expect(lines).toEqual(["warning", "next é panic"]);
    server.close();
  });

  it("includes final stderr in pending and subsequent requests after a real child exits", async () => {
    const server = new CodexAppServer({
      spawnProcess: () => spawn(process.execPath, ["-e", `
        process.stdin.once("data", () => {
          process.stderr.write("x".repeat(256 * 1024) + "\\nunknown key: bad_config\\n", () => process.exit(7));
        });
      `], { stdio: ["pipe", "pipe", "pipe"] }),
    });
    await expect(server.request("thread/start")).rejects.toThrow(/exited \(7\)[\s\S]*unknown key: bad_config/);
    await server.exited;
    expect(Buffer.byteLength(server.stderrTail())).toBe(8192);
    await expect(server.request("turn/start")).rejects.toThrow("unknown key: bad_config");
  });

  it("handles process spawn errors", async () => {
    const server = new CodexAppServer({ executable: "/tmp/codex-app-server-does-not-exist" });
    await expect(server.request("initialize")).rejects.toThrow(/ENOENT/);
    await server.exited;
  });
});
