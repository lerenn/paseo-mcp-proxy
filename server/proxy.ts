import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { AuditLog } from "./audit";
import type { AgentSession, SessionStore } from "./sessions";
import type { ServerRecord, ServerStore } from "./store";
import { AuthRequired, type Credentials } from "./upstream";

const MAX_BODY = 10_000_000;

/** Request headers that describe the MCP exchange and are safe to pass on. Everything else, notably authorization, is dropped. */
const FORWARD_REQUEST = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "cache-control"];

export const instructionsFor = (name: string, extra: string) =>
  `This server is reached through MCP Proxy as "${name}". You hold no credentials for it: the daemon adds them. ` +
  `If a call fails because authentication is missing or expired, tell the user to sign in or update the key for "${name}" in the MCP Proxy screen; do not look for other credentials.` +
  (extra.trim() ? `\n\n${extra.trim()}` : "");

interface RpcInfo {
  method: string;
  id: unknown;
  tool: string | null;
}

function describeBody(body: string): RpcInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((m: any) =>
    m && typeof m.method === "string" ? [{ method: m.method, id: m.id, tool: m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name : null }] : [],
  );
}

/**
 * Local endpoint agents reach, `/s/<server>/mcp`, plus the OAuth redirect target `/oauth/callback`.
 * Bound to loopback; agent routes need a per-agent capability token.
 */
export class ProxyHttp {
  private server: Server | null = null;

  constructor(
    private readonly deps: {
      store: ServerStore;
      sessions: SessionStore;
      creds: Credentials;
      audit: AuditLog;
      /** Finish an OAuth sign-in from the redirect's query. */
      onCallback(params: URLSearchParams): Promise<{ ok: boolean; message: string }>;
      fetch?: typeof fetch;
    },
  ) {}

  /** Resolves with the base URL. Rejects if the port is taken. */
  start(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.route(req, res).catch((err) => {
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        });
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        server.off("error", reject);
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    // Blocks DNS rebinding: a web page cannot make the browser send another Host to this port.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return json(res, 403, { error: "forbidden host" });
    const path = (req.url ?? "").split("?")[0];

    if (path === "/oauth/callback" && req.method === "GET") {
      const outcome = await this.deps.onCallback(new URL(req.url!, "http://127.0.0.1").searchParams);
      res.writeHead(outcome.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      return void res.end(`<!doctype html><meta charset="utf-8"><title>MCP Proxy</title><body style="font-family:system-ui;margin:3rem"><h2>${outcome.ok ? "Signed in" : "Sign-in failed"}</h2><p>${escapeHtml(outcome.message)}</p>${outcome.ok ? "<p>You can close this tab.</p>" : ""}`);
    }

    const match = /^\/s\/([a-z][a-z0-9-]*)\/mcp$/.exec(path);
    if (!match) return json(res, 404, { error: "not found" });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const session = this.deps.sessions.resolve(bearer);
    if (!session) return json(res, 401, { error: "unknown or expired capability; recreate the agent" });
    const name = match[1];
    const record = this.deps.store.get(name);
    // `*` never covers an explicitOnly server: it must be granted by name.
    const wildcard = session.servers.includes("*") && !(record?.explicitOnly ?? false);
    if (!wildcard && !session.servers.includes(name)) return json(res, 403, { error: `this agent was not given access to "${name}"` });
    if (!record) return json(res, 404, { error: `"${name}" is no longer registered in MCP Proxy` });
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) return json(res, 405, { error: "method not allowed" });
    await this.forward(req, res, record, session);
  }

  private async forward(req: IncomingMessage, res: ServerResponse, record: ServerRecord, session: AgentSession) {
    const started = Date.now();
    const body = req.method === "POST" ? await readBody(req) : "";
    const calls = describeBody(body);
    const audited = calls.filter((c) => c.id !== undefined && c.method !== "ping");
    const log = (status: number, error: string | null) => {
      const ok = status >= 200 && status < 400;
      const base = { server: record.name, agentId: session.agentId ?? null, status, ok: ok && !error, ms: Date.now() - started, error };
      if (audited.length) for (const c of audited) this.deps.audit.record({ ...base, method: c.method, tool: c.tool });
      else if (!ok || error) this.deps.audit.record({ ...base, method: req.method ?? "?", tool: null });
    };
    // A refused call is answered inside the MCP exchange so the agent sees why, not a bare HTTP error.
    const refuse = (message: string) => {
      log(0, message);
      const first = calls.find((c) => c.id !== undefined);
      if (req.method !== "POST" || !first) return json(res, 502, { error: message });
      const text = `MCP Proxy: ${message}`;
      json(res, 200, {
        jsonrpc: "2.0",
        id: first.id,
        ...(first.method === "tools/call" ? { result: { content: [{ type: "text", text }], isError: true } } : { error: { code: -32001, message: text } }),
      });
    };

    const blocked = calls.find((c) => c.tool !== null && !toolAllowed(record.allowTools, c.tool));
    if (blocked) return refuse(`the tool "${blocked.tool}" is not allowed on ${record.name} (allowed: ${record.allowTools!.join(", ")})`);

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = async (force: boolean) => {
      const headers: Record<string, string> = {};
      for (const h of FORWARD_REQUEST) if (typeof req.headers[h] === "string") headers[h] = req.headers[h] as string;
      Object.assign(headers, await this.deps.creds.headers(record, force));
      return (this.deps.fetch ?? fetch)(record.url, { method: req.method, headers, body: req.method === "POST" ? body : undefined, redirect: "manual", signal: abort.signal as NonNullable<RequestInit["signal"]> });
    };

    let upstream: Response;
    try {
      upstream = await send(false);
      // An access token can be rejected before its stated expiry: refresh once and replay. The
      // server answered 401 before acting, so replaying the request cannot run a tool twice.
      if (upstream.status === 401 && record.auth.type === "oauth") {
        await upstream.body?.cancel();
        upstream = await send(true);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof AuthRequired) return refuse(`${record.name} ${record.auth.type === "api-key" ? "has no API key" : "needs sign-in"}. Ask the user to fix it in the MCP Proxy screen.`);
      return refuse(`cannot reach ${record.name}: ${(err as Error).message}`);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      this.deps.creds.setError(record.name, `The server rejected the credentials (HTTP ${upstream.status})`);
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        return refuse(`${record.name} rejected the credentials. Ask the user to sign in again or update the key in the MCP Proxy screen.`);
      }
    } else if (upstream.ok) this.deps.creds.setError(record.name, null);

    const headers: Record<string, string> = {};
    for (const h of FORWARD_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    log(upstream.status, null);

    if (upstream.ok && record.allowTools && calls.some((c) => c.method === "tools/list")) {
      let text = filterTools(await upstream.text(), headers["content-type"] ?? "", record.allowTools);
      if (calls.some((c) => c.method === "initialize")) text = withInstructions(text, headers["content-type"] ?? "", instructionsFor(record.name, record.instructions));
      res.writeHead(upstream.status, headers);
      return void res.end(text);
    }
    if (upstream.ok && calls.some((c) => c.method === "initialize")) {
      const text = withInstructions(await upstream.text(), headers["content-type"] ?? "", instructionsFor(record.name, record.instructions));
      res.writeHead(upstream.status, headers);
      return void res.end(text);
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
  }
}

const toolPattern = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Whether a server's `allowTools` lets this tool through (no list: all). */
export function toolAllowed(allow: readonly string[] | null | undefined, tool: string): boolean {
  return !allow || allow.some((p) => toolPattern(p).test(tool));
}

/** Drop the tools that are not allowed from a `tools/list` answer, JSON or SSE. */
export function filterTools(text: string, contentType: string, allow: readonly string[]): string {
  const patch = (message: any) => {
    if (Array.isArray(message?.result?.tools)) message.result.tools = message.result.tools.filter((t: { name?: string }) => typeof t?.name === "string" && toolAllowed(allow, t.name));
    return message;
  };
  try {
    if (contentType.includes("text/event-stream")) {
      return text
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data:")) return line;
          try {
            return `data: ${JSON.stringify(patch(JSON.parse(line.slice(5))))}`;
          } catch {
            return line;
          }
        })
        .join("\n");
    }
    const parsed = JSON.parse(text);
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(patch) : patch(parsed));
  } catch {
    return text;
  }
}

/** Add our text to the `instructions` of an initialize response, JSON or SSE, keeping the server's own. */
export function withInstructions(text: string, contentType: string, extra: string): string {
  const patch = (message: any) => {
    if (message?.result && typeof message.result === "object" && "protocolVersion" in message.result) {
      const own = typeof message.result.instructions === "string" ? message.result.instructions.trim() : "";
      message.result.instructions = own ? `${own}\n\n${extra}` : extra;
    }
    return message;
  };
  try {
    if (contentType.includes("text/event-stream")) {
      return text
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data:")) return line;
          try {
            return `data: ${JSON.stringify(patch(JSON.parse(line.slice(5))))}`;
          } catch {
            return line;
          }
        })
        .join("\n");
    }
    const parsed = JSON.parse(text);
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(patch) : patch(parsed));
  } catch {
    return text;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
