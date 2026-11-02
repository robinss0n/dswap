import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

/**
 * Minimal JSON-RPC client for `codex app-server` (newline-delimited JSON over
 * stdio). One process serves one CODEX_HOME, which is how Codex accounts are
 * kept apart: each account is its own CODEX_HOME with its own `codex login`.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } }
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

export class CodexRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) { super(`${method}: ${message}`); }
}

export interface AppServerOptions {
  codexHome?: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Process-level `-c key=value` overrides. Some settings (model_catalog_json) are read only at startup. */
  configOverrides?: string[];
  onRequest?: ServerRequestHandler;
  onNotification?: NotificationHandler;
  onStderr?: (line: string) => void;
  /** Injected for tests; production spawns `codex app-server`. */
  spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildProcess;
}

export class CodexAppServer {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly waiting = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
  private exitError?: Error;
  private stderr = Buffer.alloc(0);
  readonly exited: Promise<void>;

  constructor(private readonly options: AppServerOptions = {}) {
    const env = { ...(options.env ?? process.env), ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) };
    const command = options.executable ?? process.env.BRIDGE_CODEX_EXECUTABLE ?? "codex";
    this.child = (options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] })))(command, [...(options.configOverrides ?? []).flatMap((item) => ["-c", item]), "app-server"], { env, cwd: options.cwd });
    let pendingLine = "";
    const decoder = new StringDecoder("utf8");
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stderr = Buffer.from(Buffer.concat([this.stderr, bytes]).subarray(-8192));
      if (!options.onStderr) return;
      const lines = (pendingLine + decoder.write(bytes)).split("\n");
      pendingLine = lines.pop()!.slice(-8192);
      for (const line of lines) options.onStderr(line.replace(/\r$/, ""));
    });
    this.child.stderr?.once("end", () => {
      pendingLine += decoder.end();
      if (pendingLine) options.onStderr?.(pendingLine);
    });
    this.exited = new Promise((resolve) => {
      // close follows stderr EOF, so even the last diagnostic is included.
      this.child.once("close", (code, signal) => { this.fail(this.withStderr(new Error(`codex app-server exited (${signal ?? code})`))); resolve(); });
      this.child.once("error", (error) => { this.fail(this.withStderr(error)); resolve(); });
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      void this.receive(message);
    });
  }

  /** Handshake. `experimentalApi` is needed for dynamic tools. */
  async initialize(): Promise<{ codexHome?: string; userAgent?: string }> {
    const result = await this.request("initialize", { clientInfo: { name: "dswap", title: "dswap bridge", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
    return result as { codexHome?: string; userAgent?: string };
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new CodexRpcError(method, undefined, `no answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.write({ id, method, ...(params === undefined ? {} : { params: params as Json }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params: params as Json }) });
  }

  close(): void {
    this.fail(new Error("codex app-server closed"));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  get pid(): number | undefined { return this.child.pid; }

  stderrTail(): string { return this.stderr.toString("utf8"); }

  private withStderr(error: Error): Error {
    const tail = this.stderrTail();
    return tail ? new Error(`${error.message}\nstderr:\n${tail}`, { cause: error }) : error;
  }

  private write(message: RpcMessage): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private async receive(message: RpcMessage): Promise<void> {
    if (message.method && message.id !== undefined) {
      // A request from Codex (tool call, approval). Unknown ones get an error, never silence.
      try {
        if (!this.options.onRequest) throw new Error(`unhandled ${message.method}`);
        this.write({ id: message.id, result: (await this.options.onRequest(message.method, message.params)) as Json });
      } catch (error) {
        this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "request failed" } });
      }
      return;
    }
    if (message.method) { this.options.onNotification?.(message.method, message.params); return; }
    if (typeof message.id !== "number") return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new CodexRpcError(waiter.method, message.error.code, message.error.message ?? "error"));
    else waiter.resolve(message.result);
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }
}
