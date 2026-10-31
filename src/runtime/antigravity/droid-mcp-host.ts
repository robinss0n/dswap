import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Serves each bridge session's Droid tools to its Antigravity agent as an MCP
 * server over HTTP on 127.0.0.1. Every session gets an unguessable path; a tool
 * call is held open until Droid has run the tool and sent the result back.
 */

export interface HostedTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export type HostedResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType?: string }>; isError?: boolean };
export interface ToolSession {
  tools(): HostedTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HostedResult>;
}

interface Registered { session: ToolSession; transports: Map<string, StreamableHTTPServerTransport> }

export class DroidMcpHost {
  private http?: HttpServer;
  private listening?: Promise<number>;
  private readonly sessions = new Map<string, Registered>();

  /** Registers one session; the returned URL is all the agent needs. */
  async register(session: ToolSession): Promise<{ url: string; dispose: () => void }> {
    const port = await this.start();
    const key = randomBytes(24).toString("hex");
    this.sessions.set(key, { session, transports: new Map() });
    return {
      url: `http://127.0.0.1:${port}/mcp/${key}`,
      dispose: () => {
        const registered = this.sessions.get(key);
        this.sessions.delete(key);
        for (const transport of registered?.transports.values() ?? []) void transport.close().catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      for (const transport of this.sessions.get(key)?.transports.values() ?? []) await transport.close().catch(() => {});
      this.sessions.delete(key);
    }
    const http = this.http;
    this.http = undefined;
    this.listening = undefined;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private start(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const http = createServer((req, res) => { void this.route(req, res); });
      // Tool calls can wait for a Droid approval; never time the held request out here.
      http.requestTimeout = 0;
      http.headersTimeout = 60_000;
      http.keepAliveTimeout = 120_000;
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => resolve((http.address() as AddressInfo).port));
      this.http = http;
    });
    return this.listening;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = /^\/mcp\/([0-9a-f]{48})\/?$/.exec((req.url ?? "").split("?")[0]!)?.[1];
    const registered = key ? this.sessions.get(key) : undefined;
    if (!registered) { res.writeHead(404).end(); return; }
    try {
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? registered.transports.get(sessionId) : undefined;
      if (existing) { await existing.handleRequest(req, res); return; }
      if (req.method !== "POST") { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No MCP session" }, id: null })); return; }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { registered.transports.set(id, transport); },
      });
      transport.onclose = () => { if (transport.sessionId) registered.transports.delete(transport.sessionId); };
      await this.server(registered.session).connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "MCP host error" }, id: null }));
    }
  }

  private server(session: ToolSession): Server {
    const server = new Server({ name: "droid", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: session.tools().map((tool) => ({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema as any })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      session.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, extra.signal) as any);
    return server;
  }
}
