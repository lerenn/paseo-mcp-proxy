import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit";
import { createPluginApi, ENDPOINT_API_VERSION, PLUGIN_API_KEY, PluginCapability, registerPluginApi, writeEndpointFile } from "./plugin-api";
import { ProxyHttp } from "./proxy";
import { PendingStore } from "./pending";
import { ProxyService } from "./service";
import { SessionStore } from "./sessions";
import { ServerStore } from "./store";
import { listen, send, tmp } from "./testing";
import { Credentials } from "./upstream";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** An MCP server that wants `Bearer k-1`, answers in JSON or SSE, and echoes the tool's arguments. */
async function upstream(opts: { sse?: boolean } = {}) {
  const s = await listen((req, res, seen) => {
    if (req.headers.authorization !== "Bearer k-1") return send(res, 401, { error: "no" });
    if (req.method === "DELETE") return send(res, 200, {});
    const msg = JSON.parse(seen.body || "{}");
    if (msg.method === "initialize") return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }, { "mcp-session-id": "sess-1" });
    if (msg.method === "notifications/initialized") return void (res.writeHead(202), res.end());
    if (msg.method === "tools/call" && msg.params.name === "boom") return send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad arguments" } });
    const result = { content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }] };
    if (opts.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
      return void res.end();
    }
    send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
  });
  closers.push(s.close);
  return s;
}

async function setup(upstreamUrl: string, extra: { allowTools?: string[] } = {}) {
  const dir = tmp();
  const store = new ServerStore(null, path.join(dir, "servers.json"), path.join(dir, "secrets.json"));
  const sessions = new SessionStore(path.join(dir, "sessions.json"));
  const audit = new AuditLog(path.join(dir, "audit.jsonl"));
  const creds = new Credentials(store);
  let base: string | null = null;
  const service = new ProxyService(store, creds, () => base, fetch, undefined, new PendingStore(path.join(dir, "pending.json")));
  service.add({ name: "gh", url: `${upstreamUrl}/mcp`, auth: "api-key", apiKey: "k-1" });
  // allowTools only comes from git definitions: give the screen-added server one.
  const allowTools = extra.allowTools;
  if (allowTools) {
    const get = store.get.bind(store);
    store.get = (name: string) => {
      const record = get(name);
      return record && { ...record, allowTools };
    };
  }
  const plugins = new PluginCapability();
  const http = new ProxyHttp({ store, sessions, creds, audit, plugins, onCallback: (p) => service.finishSignIn(p) });
  base = await http.start(0);
  closers.push(() => http.stop());
  return { api: createPluginApi(() => base, plugins), audit, plugins, base };
}

describe("plugin API", () => {
  it("calls a tool with the stored credential and audits it as the plugin", async () => {
    const up = await upstream();
    const { api, audit } = await setup(up.url);
    const out = await api.callTool("gh", "pr_facts", { url: "u" }, { caller: "pr-facts" });
    expect(out).toEqual({ content: [{ type: "text", text: '{"url":"u"}' }] });
    expect(up.seen.find((s) => s.body.includes("tools/call"))!.headers["mcp-session-id"]).toBe("sess-1");
    expect(up.seen.every((s) => !JSON.stringify(s.headers).includes("x-paseo-plugin"))).toBe(true);
    expect(audit.recent(10).some((e) => e.tool === "pr_facts" && e.agentId === "plugin:pr-facts")).toBe(true);
  });

  it("reads an SSE answer, skipping other messages", async () => {
    const up = await upstream({ sse: true });
    const { api } = await setup(up.url);
    expect((await api.callTool("GH", "pr_facts", { n: 1 })).content![0].text).toBe('{"n":1}');
  });

  it("rejects on a JSON-RPC error, an unknown server and a stopped endpoint", async () => {
    const up = await upstream();
    const { api, plugins } = await setup(up.url);
    await expect(api.callTool("gh", "boom")).rejects.toThrow(/bad arguments/);
    await expect(api.callTool("ghost", "x")).rejects.toThrow(/HTTP 404/);
    await expect(createPluginApi(() => null, plugins).callTool("gh", "x")).rejects.toThrow(/not running/);
  });

  it("keeps allowTools: a refused tool comes back as an error result", async () => {
    const up = await upstream();
    const { api } = await setup(up.url, { allowTools: ["get_*"] });
    const out = await api.callTool("gh", "pr_facts");
    expect(out.isError).toBe(true);
    expect(out.content![0].text).toMatch(/not allowed/);
  });

  it("is not a capability for anyone without the in-process token", async () => {
    const up = await upstream();
    const { base } = await setup(up.url);
    const res = await fetch(`${base}/s/gh/mcp`, { method: "POST", headers: { authorization: "Bearer guess", "x-paseo-plugin": "x", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("registers on the global slot and unregisters only itself", () => {
    const target: Record<symbol, unknown> = {};
    const a = createPluginApi(() => null, new PluginCapability());
    const b = createPluginApi(() => null, new PluginCapability());
    const dropA = registerPluginApi(a, target);
    registerPluginApi(b, target);
    dropA();
    expect(target[PLUGIN_API_KEY]).toBe(b);
  });
});

describe("plugin endpoint file", () => {
  it("writes {url, token, apiVersion} 0600 in a 0700 directory, and the token works on the endpoint", async () => {
    const up = await upstream();
    const { plugins, base } = await setup(up.url);
    const file = path.join(tmp(), "mcp-proxy", "endpoint.json");
    writeEndpointFile(base, plugins, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const endpoint = JSON.parse(readFileSync(file, "utf8"));
    expect(endpoint).toEqual({ url: base, token: plugins.token, apiVersion: ENDPOINT_API_VERSION });
    // A plugin in another process calls a tool with what the file says.
    const out = await createPluginApi(() => endpoint.url, Object.assign(new PluginCapability(), { token: endpoint.token })).callTool("gh", "pr_facts", { url: "u" }, { caller: "pr-facts" });
    expect(out.content![0].text).toBe('{"url":"u"}');
  });

  it("refuses a non-loopback URL", () => {
    const file = path.join(tmp(), "endpoint.json");
    expect(() => writeEndpointFile("http://10.0.0.5:47824", new PluginCapability(), file)).toThrow(/non-loopback/);
    expect(() => writeEndpointFile("https://127.0.0.1:47824", new PluginCapability(), file)).toThrow(/non-loopback/);
    expect(existsSync(file)).toBe(false);
  });

  it("the cleanup removes the file only while it is still this capability's", () => {
    const file = path.join(tmp(), "endpoint.json");
    const a = new PluginCapability();
    const b = new PluginCapability();
    const dropA = writeEndpointFile("http://127.0.0.1:1", a, file);
    const dropB = writeEndpointFile("http://127.0.0.1:2", b, file);
    dropA();
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(b.token);
    dropB();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "not json");
    dropB();
    expect(existsSync(file)).toBe(true);
  });
});
