import { randomBytes, timingSafeEqual } from "node:crypto";
import { timeout } from "./files";
import type { AgentSession } from "./sessions";

/**
 * The in-process API other daemon plugins use to call a registered server's tools. Plugins do not import each other, so it is
 * offered on `globalThis[Symbol.for("paseo.mcp-proxy")]`; callers repeat the `McpProxyApi` shape below.
 */
export const PLUGIN_API_KEY = Symbol.for("paseo.mcp-proxy");

/** Header naming the calling plugin; it becomes `plugin:<caller>` in the audit log. */
export const PLUGIN_CALLER_HEADER = "x-paseo-plugin";

export interface ToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface CallOptions {
  /** The calling plugin's id, for the audit log (lowercase letters, digits and dashes). */
  caller?: string;
  /** Default 30 s. */
  timeoutMs?: number;
}

export interface McpProxyApi {
  version: 1;
  /**
   * Call one tool of a registered server with the credentials MCP Proxy holds for it, through its own endpoint (so `allowTools`, the
   * OAuth refresh and the audit log apply as for agents). Resolves with the tool result, `isError` included; rejects when the server
   * cannot be reached, needs a sign-in or key, or answers a JSON-RPC error.
   */
  callTool(server: string, tool: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolResult>;
}

/**
 * A capability that exists only in this process, never on disk or in an agent's environment. The endpoint accepts it for every
 * registered server, explicitOnly ones included: a plugin runs in the daemon and could already read the secrets file.
 */
export class PluginCapability {
  readonly token = randomBytes(24).toString("base64url");

  session(bearer: string | undefined, server: string, caller: string | string[] | undefined): AgentSession | null {
    if (!bearer) return null;
    const a = Buffer.from(bearer);
    const b = Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const name = typeof caller === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(caller) ? caller : "unknown";
    return { servers: [server], agentId: `plugin:${name}`, createdAt: 0 };
  }
}

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  result?: any;
  error?: { code?: number; message?: string };
}

/** The JSON-RPC answer to `id` in a JSON or SSE body. */
function answerTo(id: number, contentType: string, text: string): JsonRpcMessage | undefined {
  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // not JSON: a keep-alive or comment
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return undefined;
    }
  }
  return messages.find((m): m is JsonRpcMessage => !!m && typeof m === "object" && (m as JsonRpcMessage).id === id);
}

export function createPluginApi(endpoint: () => string | null, capability: PluginCapability, fetchImpl: typeof fetch = fetch): McpProxyApi {
  return {
    version: 1,
    async callTool(server, tool, args = {}, options = {}) {
      const base = endpoint();
      if (!base) throw new Error("MCP Proxy: the endpoint is not running");
      const url = `${base}/s/${encodeURIComponent(server.toLowerCase())}/mcp`;
      const signal = timeout(options.timeoutMs ?? 30_000);
      const headers: Record<string, string> = {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [PLUGIN_CALLER_HEADER]: options.caller ?? "unknown",
      };
      const post = async (body: object, id?: number): Promise<JsonRpcMessage | undefined> => {
        const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`MCP Proxy: ${server} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (id === undefined) return undefined;
        const sessionId = res.headers.get("mcp-session-id");
        if (sessionId) headers["mcp-session-id"] = sessionId;
        const answer = answerTo(id, res.headers.get("content-type") ?? "", text);
        if (!answer) throw new Error(`MCP Proxy: ${server} sent no answer to ${tool}`);
        if (answer.error) throw new Error(`MCP Proxy: ${server}: ${answer.error.message ?? "error"}`);
        return answer;
      };
      try {
        const init = await post(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `paseo-plugin-${options.caller ?? "unknown"}`, version: "1" } } },
          1,
        );
        headers["mcp-protocol-version"] = String(init?.result?.protocolVersion ?? PROTOCOL_VERSION);
        await post({ jsonrpc: "2.0", method: "notifications/initialized" });
        const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, 2);
        return call!.result as ToolResult;
      } finally {
        if (headers["mcp-session-id"]) void fetchImpl(url, { method: "DELETE", headers }).then((r) => r.body?.cancel(), () => {});
      }
    },
  };
}

/** Offer `api` on the global slot; the cleanup removes it only while it is still this one. */
export function registerPluginApi(api: McpProxyApi, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): () => void {
  target[PLUGIN_API_KEY] = api;
  return () => {
    if (target[PLUGIN_API_KEY] === api) delete target[PLUGIN_API_KEY];
  };
}
