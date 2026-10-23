import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit";
import { ProxyHttp } from "./proxy";
import { ProxyService } from "./service";
import { SessionStore } from "./sessions";
import { ServerStore } from "./store";
import { listen, send, tmp } from "./testing";
import { Credentials } from "./upstream";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** An upstream that is both an MCP server (requires its current bearer) and its own OAuth server. */
async function upstream(opts: { sse?: boolean; rejectFirst?: boolean } = {}) {
  let access = "at-1";
  let refresh = "rt-1";
  let challenge = "";
  let rejected = false;
  const s = await listen((req, res, seen) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, { resource: `${s.url}/mcp`, authorization_servers: [s.url] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return send(res, 200, { authorization_endpoint: `${s.url}/authorize`, token_endpoint: `${s.url}/token`, registration_endpoint: `${s.url}/register` });
    if (u.pathname === "/register") return send(res, 201, { client_id: "client-1" });
    if (u.pathname === "/token") {
      const p = new URLSearchParams(seen.body);
      if (p.get("grant_type") === "authorization_code") {
        const ok = createHash("sha256").update(p.get("code_verifier")!).digest("base64url") === challenge && p.get("code") === "the-code";
        return ok ? send(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600 }) : send(res, 400, { error: "invalid_grant" });
      }
      if (p.get("refresh_token") !== refresh) return send(res, 400, { error: "invalid_grant" });
      access = "at-2";
      refresh = "rt-2";
      return send(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
    }
    if (u.pathname === "/authorize") {
      challenge = u.searchParams.get("code_challenge")!;
      return send(res, 200, {});
    }
    if (u.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${access}` || (opts.rejectFirst && !rejected && (rejected = true))) return send(res, 401, { error: "no" }, { "www-authenticate": 'Bearer resource_metadata="x"' });
      const msg = JSON.parse(seen.body || "{}");
      if (msg.method === "initialize") return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" }, instructions: "Upstream says hi." } }, { "mcp-session-id": "sess-9" });
      if (opts.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "streamed" }] } })}\n\n`);
        return void setTimeout(() => res.end(), 20);
      }
      return send(res, 200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }] } });
    }
    send(res, 404, {});
  });
  closers.push(s.close);
  return { ...s, expire: () => { access = "at-expired-upstream"; } };
}

async function setup(up: Awaited<ReturnType<typeof upstream>>) {
  const dir = tmp();
  const store = new ServerStore(path.join(dir, "servers.json"));
  const sessions = new SessionStore(path.join(dir, "sessions.json"));
  const audit = new AuditLog(path.join(dir, "audit.jsonl"));
  const creds = new Credentials(store);
  let base = "";
  const service = new ProxyService(store, creds, () => base);
  const http = new ProxyHttp({ store, sessions, creds, audit, onCallback: (p) => service.finishSignIn(p) });
  base = await http.start(0);
  closers.push(() => http.stop());
  return { dir, store, sessions, audit, creds, service, http, base };
}

const rpc = (base: string, name: string, token: string, body: unknown) =>
  fetch(`${base}/s/${name}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });

async function signedIn(up: Awaited<ReturnType<typeof upstream>>) {
  const t = await setup(up);
  t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth", instructions: "Use project Alpha." });
  const authUrl = new URL(await t.service.signIn("demo"));
  await fetch(authUrl); // lets the fake AS see the PKCE challenge
  const cb = await fetch(`${t.base}/oauth/callback?code=the-code&state=${authUrl.searchParams.get("state")}`);
  return { ...t, authUrl, cb };
}

describe("OAuth sign-in", () => {
  it("discovers, registers, uses PKCE and the resource indicator, and stores the grant 0600", async () => {
    const up = await upstream();
    const t = await signedIn(up);
    expect(t.authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(t.authUrl.searchParams.get("client_id")).toBe("client-1");
    expect(t.authUrl.searchParams.get("resource")).toBe(`${up.url}/mcp`);
    expect(t.cb.status).toBe(200);
    expect(t.service.views()[0]).toMatchObject({ name: "demo", auth: "oauth", status: "connected", signingIn: false });
    expect(statSync(path.join(t.dir, "servers.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(t.service.views())).not.toMatch(/at-1|rt-1/);
  });

  it("rejects a callback with an unknown state and keeps the server signed out", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    await t.service.signIn("demo");
    const cb = await fetch(`${t.base}/oauth/callback?code=the-code&state=forged`);
    expect(cb.status).toBe(400);
    expect(t.service.views()[0].status).toBe("needs-sign-in");
  });

  it("completes from a pasted address", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    const authUrl = new URL(await t.service.signIn("demo"));
    await fetch(authUrl);
    await t.service.completeSignIn("demo", `http://127.0.0.1:1/oauth/callback?code=the-code&state=${authUrl.searchParams.get("state")}`);
    expect(t.service.views()[0].status).toBe("connected");
  });
});

describe("proxy", () => {
  it("injects the upstream token, drops the agent's capability, and rewrites instructions", async () => {
    const up = await upstream();
    const t = await signedIn(up);
    const cap = t.sessions.create(["demo"]);
    const res = await rpc(t.base, "demo", cap, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const body: any = await res.json();
    expect(body.result.instructions).toContain("Upstream says hi.");
    expect(body.result.instructions).toContain("You hold no credentials");
    expect(body.result.instructions).toContain("Use project Alpha.");
    expect(res.headers.get("mcp-session-id")).toBe("sess-9");
    const hit = up.seen.filter((s) => s.url === "/mcp").pop()!;
    expect(hit.headers.authorization).toBe("Bearer at-1");
  });

  it("refreshes an expired token and replays once when upstream answers 401", async () => {
    const up = await upstream({ rejectFirst: true });
    const t = await signedIn(up);
    const cap = t.sessions.create(["demo"]);
    const res = await rpc(t.base, "demo", cap, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { secret: "x" } } });
    expect((await res.json() as any).result.content[0].text).toBe("done");
    expect(up.seen.filter((s) => s.url === "/token").length).toBeGreaterThan(1); // code exchange + refresh
    const stored = t.store.get("demo")!.auth as any;
    expect(stored.oauth.refreshToken).toBe("rt-2");
  });

  it("streams SSE responses through", async () => {
    const up = await upstream({ sse: true });
    const t = await signedIn(up);
    const cap = t.sessions.create(["demo"]);
    const res = await rpc(t.base, "demo", cap, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("streamed");
  });

  it("refuses unknown capabilities and servers the agent was not granted", async () => {
    const up = await upstream();
    const t = await signedIn(up);
    t.service.add({ name: "other", url: `${up.url}/mcp`, auth: "none" });
    expect((await rpc(t.base, "demo", "nope", {})).status).toBe(401);
    const cap = t.sessions.create(["other"]);
    expect((await rpc(t.base, "demo", cap, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const star = t.sessions.create(["*"]);
    expect((await rpc(t.base, "demo", star, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("rejects non-loopback Host headers", async () => {
    const up = await upstream();
    const t = await setup(up);
    const port = new URL(t.base).port;
    const res = await new Promise<number>((resolve) => {
      import("node:http").then(({ request }) => {
        const r = request({ host: "127.0.0.1", port, path: "/s/demo/mcp", method: "POST", headers: { host: "evil.example" } }, (m) => resolve(m.statusCode!));
        r.end();
      });
    });
    expect(res).toBe(403);
  });

  it("answers inside the MCP exchange when the server needs sign-in, and sends nothing upstream", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    const cap = t.sessions.create(["demo"]);
    const res = await rpc(t.base, "demo", cap, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo" } });
    const body: any = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("needs sign-in");
    expect(up.seen.filter((s) => s.url === "/mcp")).toHaveLength(0);
  });

  it("injects API keys and audits tool, agent and status without payloads or secrets", async () => {
    const up = await upstream();
    const t = await setup(up);
    const seenKeys: string[] = [];
    const key = await listen((req, res, seen) => {
      seenKeys.push(String(req.headers["x-api-key"]));
      send(res, 200, { jsonrpc: "2.0", id: JSON.parse(seen.body).id, result: { content: [] } });
    });
    closers.push(key.close);
    t.service.add({ name: "keyed", url: `${key.url}/mcp`, auth: "api-key", header: "X-Api-Key", apiKey: "sk-super-secret" });
    const cap = t.sessions.create(["keyed"]);
    t.sessions.bind(cap, "agent-1234567890");
    await rpc(t.base, "keyed", cap, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_issue", arguments: { title: "private payload" } } });
    expect(seenKeys).toEqual(["sk-super-secret"]);
    const [entry] = t.audit.recent(1);
    expect(entry).toMatchObject({ server: "keyed", method: "tools/call", tool: "create_issue", agentId: "agent-1234567890", status: 200, ok: true });
    const raw = JSON.stringify(entry) + JSON.stringify(t.service.views());
    expect(raw).not.toMatch(/sk-super-secret|private payload/);
  });
});
