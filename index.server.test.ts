import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tmp } from "./server/testing";

type Handler = (input: any, ctx?: any) => any;
const before = new Map<string, Handler>();
const on = new Map<string, Handler>();
const rpcs = new Map<string, Handler>();
let cleanup: () => Promise<void> | void;
let home: string;

beforeAll(async () => {
  home = tmp();
  vi.stubEnv("HOME", home);
  vi.stubEnv("MCP_PROXY_PORT", "0");
  const { default: contribute } = await import("./index.server");
  cleanup = contribute({
    before: (name: string, h: Handler) => (before.set(name, h), () => before.delete(name)),
    on: (name: string, h: Handler) => (on.set(name, h), () => on.delete(name)),
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values: { sources: [] } }), subscribe: () => () => {} }),
    handle: (contract: { name: string }, h: Handler) => void rpcs.set(contract.name, h),
  } as never) as () => Promise<void>;
});
afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const create = (env?: Record<string, string>, extra: object = {}) => before.get("agent.create")!({ request: { config: { provider: "claude", cwd: "/work", ...extra }, env } });

describe("plugin wiring", () => {
  it("leaves agents that did not ask for servers untouched", async () => {
    expect(await create({ FOO: "bar" })).toBeUndefined();
    expect(await create()).toBeUndefined();
  });

  it("attaches the requested servers with a capability and notes the missing ones", async () => {
    await rpcs.get("mcp-proxy.add")!({ name: "linear", url: "https://mcp.linear.app/mcp", auth: "oauth" });
    await rpcs.get("mcp-proxy.add")!({ name: "sentry", url: "https://mcp.sentry.dev/mcp", auth: "none" });
    const out = await create({ PASEO_MCP_SERVERS: "Linear, sentry,ghost", KEEP: "1" }, { systemPrompt: "Be brief.", mcpServers: { linear: { type: "http", url: "https://direct.example/mcp" } } });
    expect(Object.keys(out.config.mcpServers).sort()).toEqual(["linear", "sentry"]);
    const linear = out.config.mcpServers.linear;
    expect(linear.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/linear\/mcp$/);
    expect(linear.headers.authorization).toMatch(/^Bearer .{20,}$/);
    expect(out.config.systemPrompt).toContain("Be brief.");
    expect(out.config.systemPrompt).toContain("linear, sentry");
    expect(out.config.systemPrompt).toMatch(/not configured in MCP Proxy.*ghost/);
    expect(out.env.KEEP).toBe("1");
    expect(out.env.PASEO_MCP_PROXY_CAPABILITY).toBe(linear.headers.authorization.slice(7));
  });

  it("grants every registered server for *, then binds the capability to the agent", async () => {
    const out = await create({ PASEO_MCP_SERVERS: "*" });
    expect(Object.keys(out.config.mcpServers).sort()).toEqual(["linear", "sentry"]);
    await before.get("agent.session_open")!({ request: { agentId: "agent-1", env: { PASEO_MCP_PROXY_CAPABILITY: out.env.PASEO_MCP_PROXY_CAPABILITY } } });
    const raw = JSON.parse(readFileSync(path.join(home, ".paseo", "mcp-proxy", "sessions.json"), "utf8"));
    expect(Object.values(raw as Record<string, { agentId?: string }>).some((s) => s.agentId === "agent-1")).toBe(true);
    expect(statSync(path.join(home, ".paseo", "mcp-proxy", "sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("lists servers without credentials and reports the endpoint", async () => {
    await rpcs.get("mcp-proxy.add")!({ name: "keyed", url: "https://x.example/mcp", auth: "api-key", header: "X-Key", apiKey: "sk-hidden" });
    const out = await rpcs.get("mcp-proxy.list")!({});
    expect(out.endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(out.servers.map((s: { name: string }) => s.name)).toEqual(["keyed", "linear", "sentry"]);
    expect(JSON.stringify(out)).not.toContain("sk-hidden");
  });
});
