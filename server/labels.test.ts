import { afterEach, describe, expect, it } from "vitest";
import { serversForLabels } from "../shared/plugin";
import { AuditLog } from "./audit";
import { attachServers } from "./attach";
import { filterTools, ProxyHttp, toolAllowed } from "./proxy";
import { SessionStore } from "./sessions";
import type { ServerRecord, ServerStore } from "./store";
import { listen, send, tmp } from "./testing";
import path from "node:path";

describe("labelServers", () => {
  const rules = { "paseo.prbr=1": "sql-annie-prod, launchdarkly", "paseo.any": "extra", "team=a": "a-only" };
  it("grants servers by label, a bare key matching any value", () => {
    expect(serversForLabels({ "paseo.prbr": "1" }, rules)).toEqual(["sql-annie-prod", "launchdarkly"]);
    expect(serversForLabels({ "paseo.prbr": "0" }, rules)).toEqual([]);
    expect(serversForLabels({ "paseo.any": "whatever", "team": "a" }, rules)).toEqual(["extra", "a-only"]);
    expect(serversForLabels(undefined, rules)).toEqual([]);
  });

  it("adds them to what the agent asked for, even when it opted out of the defaults", () => {
    const request = { config: { cwd: "/x" }, env: { PASEO_MCP_SERVERS: "none" } } as never;
    const out = attachServers(request, { url: "http://127.0.0.1:1", registered: ["sql-annie-prod", "linear"], extra: ["sql-annie-prod", "launchdarkly"], capability: (g) => g.join("+") }) as never as { config: { mcpServers: Record<string, unknown>; systemPrompt: string }; env: Record<string, string> };
    expect(Object.keys(out.config.mcpServers)).toEqual(["sql-annie-prod"]);
    expect(out.config.systemPrompt).toContain("launchdarkly"); // requested but not configured: said so
    expect(out.env.PASEO_MCP_PROXY_CAPABILITY).toBe("sql-annie-prod");
  });
});

describe("allowTools", () => {
  it("matches exact names and * wildcards", () => {
    expect(toolAllowed(["list_projects", "get_*"], "get_pr_blast_review")).toBe(true);
    expect(toolAllowed(["list_projects", "get_*"], "rerun_pr_blast_review")).toBe(false);
    expect(toolAllowed(["a.b"], "aXb")).toBe(false);
    expect(toolAllowed(null, "anything")).toBe(true);
  });

  it("filters a tools/list answer in JSON and SSE", () => {
    const body = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_projects" }, { name: "rerun_pr_blast_review" }] } };
    expect(JSON.parse(filterTools(JSON.stringify(body), "application/json", ["list_*"])).result.tools).toEqual([{ name: "list_projects" }]);
    const sse = filterTools(`event: message\ndata: ${JSON.stringify(body)}\n\n`, "text/event-stream", ["list_*"]);
    expect(sse).toContain('"list_projects"');
    expect(sse).not.toContain("rerun_pr_blast_review");
  });
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe("allowTools through the proxy", () => {
  it("hides and refuses tools outside the list, and still serves the allowed ones", async () => {
    const calls: string[] = [];
    const up = await listen((req, res, seen) => {
      const msg = JSON.parse(seen.body || "{}");
      if (msg.method === "tools/call") calls.push(msg.params.name);
      if (msg.method === "tools/list") return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "get_pr_blast_review" }, { name: "rerun_pr_blast_review" }] } });
      send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    });
    closers.push(up.close);
    const record = { name: "annie-prod", displayName: null, definitionDisplayName: null, url: `${up.url}/mcp`, instructions: "", allowTools: ["get_*"], oauthClient: null, auth: { type: "none" }, origin: "x" } as ServerRecord;
    const dir = tmp();
    const sessions = new SessionStore(path.join(dir, "sessions.json"));
    const http = new ProxyHttp({ store: { get: () => record } as unknown as ServerStore, sessions, creds: { headers: async () => ({}), setError: () => undefined } as never, audit: new AuditLog(path.join(dir, "audit.jsonl")), onCallback: async () => ({ ok: true, message: "" }) });
    const base = await http.start(0);
    closers.push(() => http.stop());
    const token = sessions.create(["annie-prod"]);
    const rpc = (body: unknown) => fetch(`${base}/s/annie-prod/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools).toEqual([{ name: "get_pr_blast_review" }]);
    const refused = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rerun_pr_blast_review", arguments: {} } });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toMatch(/not allowed on annie-prod/);
    const ok = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_pr_blast_review", arguments: {} } });
    expect(ok.result.content[0].text).toBe("ok");
    expect(calls).toEqual(["get_pr_blast_review"]); // the refused call never reached the upstream
  });
});

describe("explicitOnly servers", () => {
  const registered = ["linear", "aikido", "aikido-admin"];
  const wildcard = ["linear", "aikido"];
  type Out = { config: { mcpServers: Record<string, unknown> }; env: Record<string, string> };
  it("are left out of *", () => {
    const request = { config: { cwd: "/x" }, env: {} } as never;
    const out = attachServers(request, { url: "http://127.0.0.1:1", defaults: ["*"], registered, wildcard, capability: (g) => g.join("+") }) as never as Out;
    expect(Object.keys(out.config.mcpServers)).toEqual(["linear", "aikido"]);
    expect(out.env.PASEO_MCP_PROXY_CAPABILITY).toBe("*");
  });
  it("are granted by name, next to * in the capability", () => {
    const request = { config: { cwd: "/x" }, env: {} } as never;
    const out = attachServers(request, { url: "http://127.0.0.1:1", defaults: ["*"], extra: ["aikido-admin"], registered, wildcard, capability: (g) => g.join("+") }) as never as Out;
    expect(Object.keys(out.config.mcpServers)).toEqual(["linear", "aikido", "aikido-admin"]);
    expect(out.env.PASEO_MCP_PROXY_CAPABILITY).toBe("*+aikido-admin");
  });
});

describe("explicitOnly at the proxy", () => {
  it("refuses a * capability and serves one that names the server", async () => {
    const record = { name: "aikido-admin", displayName: null, definitionDisplayName: null, url: "http://127.0.0.1:9/mcp", instructions: "", allowTools: null, explicitOnly: true, oauthClient: null, auth: { type: "none" }, origin: "x" } as ServerRecord;
    const dir = tmp();
    const sessions = new SessionStore(path.join(dir, "sessions.json"));
    const http = new ProxyHttp({ store: { get: () => record } as unknown as ServerStore, sessions, creds: { headers: async () => ({}), setError: () => undefined } as never, audit: new AuditLog(path.join(dir, "audit.jsonl")), onCallback: async () => ({ ok: true, message: "" }) });
    const base = await http.start(0);
    try {
      const status = (token: string) => fetch(`${base}/s/aikido-admin/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.status);
      expect(await status(sessions.create(["*"]))).toBe(403);
      expect(await status(sessions.create(["*", "aikido-admin"]))).not.toBe(403);
    } finally {
      await http.stop();
    }
  });
});
