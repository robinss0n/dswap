import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Minimal Agent Client Protocol client (JSON-RPC 2.0, newline-delimited over
 * stdio) for Google's Antigravity ACP agent. One process serves one GEMINI_HOME,
 * which is how Google accounts are kept apart: each account is its own home
 * with its own sign-in.
 */

export interface AcpMessage { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: unknown } }
export type AcpRequestHandler = (method: string, params: any) => Promise<unknown>;
export type AcpNotificationHandler = (method: string, params: any) => void;

export class AcpRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) { super(`${method}: ${message}`); }
}

export interface AcpClientOptions {
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onRequest?: AcpRequestHandler;
  onNotification?: AcpNotificationHandler;
  /** Where the agent's stderr goes; `inherit` shows sign-in links to the user. Default: ignored. */
  stderr?: "ignore" | "inherit" | ((chunk: string) => void);
  /** Injected for tests. */
  spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; stderr: "ignore" | "inherit" | "pipe" }) => ChildProcess;
}

export class AcpClient {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly waiting = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
  private exitError?: Error;
  readonly exited: Promise<void>;

  constructor(private readonly options: AcpClientOptions) {
    const stderr = typeof options.stderr === "function" ? "pipe" : options.stderr ?? "ignore";
    const env = options.env ?? process.env;
    this.child = (options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", opts.stderr] })))(
      options.executable, options.args ?? [], { env, cwd: options.cwd, stderr });
    if (typeof options.stderr === "function") {
      const sink = options.stderr;
      this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => sink(chunk));
    }
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => { this.fail(new Error(`Antigravity agent exited (${signal ?? code})`)); resolve(); });
      this.child.once("error", (error) => { this.fail(error); resolve(); });
    });
    this.child.stdin?.on("error", () => {});
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      let message: AcpMessage;
      try { message = JSON.parse(line) as AcpMessage; } catch { return; }
      void this.receive(message);
    });
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.waiting.delete(id); reject(new AcpRpcError(method, undefined, `no answer in ${timeoutMs} ms`)); }, timeoutMs) : undefined;
      this.waiting.set(id, { method, resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); }, reject: (error) => { if (timer) clearTimeout(timer); reject(error); } });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** SIGINT lets the agent shut down quietly; SIGTERM makes it print a crash report. */
  close(): void {
    this.fail(new Error("Antigravity agent closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGINT");
    const force = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 3_000);
    force.unref();
  }

  get pid(): number | undefined { return this.child.pid; }

  private write(message: AcpMessage): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async receive(message: AcpMessage): Promise<void> {
    if (message.method && message.id !== undefined) {
      try {
        if (!this.options.onRequest) throw new Error(`unhandled ${message.method}`);
        this.write({ jsonrpc: "2.0", id: message.id, result: (await this.options.onRequest(message.method, message.params)) ?? null });
      } catch (error) {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "request failed" } });
      }
      return;
    }
    if (message.method) { this.options.onNotification?.(message.method, message.params); return; }
    if (typeof message.id !== "number") return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new AcpRpcError(waiter.method, message.error.code, message.error.message ?? "error"));
    else waiter.resolve(message.result);
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }
}
