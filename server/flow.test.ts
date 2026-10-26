import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "./audit";
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

/** An upstream that is both an MCP server (requires its current bearer) and its own OAuth server. */
async function upstream(opts: { sse?: boolean; rejectFirst?: boolean; noRegistration?: boolean } = {}) {
  let access = "at-1";
  let refresh = "rt-1";
  let challenge = "";
  let rejected = false;
  const s = await listen((req, res, seen) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return send(res, 200, { resource: `${s.url}/mcp`, authorization_servers: [s.url] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return send(res, 200, { authorization_endpoint: `${s.url}/authorize`, token_endpoint: `${s.url}/token`, ...(opts.noRegistration ? {} : { registration_endpoint: `${s.url}/register` }) });
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
  const store = new ServerStore(null, path.join(dir, "servers.json"), path.join(dir, "secrets.json"));
  const sessions = new SessionStore(path.join(dir, "sessions.json"));
  const audit = new AuditLog(path.join(dir, "audit.jsonl"));
  const creds = new Credentials(store);
  let base = "";
  const pendingFile = path.join(dir, "pending.json");
  const service = new ProxyService(store, creds, () => base, fetch, undefined, new PendingStore(pendingFile));
  const http = new ProxyHttp({ store, sessions, creds, audit, onCallback: (p) => service.finishSignIn(p) });
  base = await http.start(0);
  closers.push(() => http.stop());
  return { dir, pendingFile, store, sessions, audit, creds, service, http, base };
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
    expect(statSync(path.join(t.dir, "secrets.json")).mode & 0o777).toBe(0o600);
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

describe("pre-registered OAuth client", () => {
  async function preregistered(extra: Record<string, unknown> = {}) {
    const up = await upstream({ noRegistration: true });
    const t = await setup(up);
    const file = path.join(t.dir, "client.json");
    writeFileSync(file, JSON.stringify({ client_id: "slack-id", nested: { secret: "s3cr3t-value" } }));
    t.store.add({ name: "slack", url: `${up.url}/mcp`, auth: "oauth", oauthClient: { clientIdRef: `file:${file}#client_id`, clientSecretRef: `file:${file}#nested.secret`, scopes: ["channels:read", "users:read"], ...extra } });
    return { up, t, file };
  }

  it("skips registration, requests only the configured scopes and sends the secret in the token request", async () => {
    const { up, t } = await preregistered();
    const authUrl = new URL(await t.service.signIn("slack"));
    expect(up.seen.some((s) => s.url === "/register")).toBe(false);
    expect(authUrl.searchParams.get("client_id")).toBe("slack-id");
    expect(authUrl.searchParams.get("scope")).toBe("channels:read users:read");
    await fetch(authUrl);
    const cb = await fetch(`${t.base}/oauth/callback?code=the-code&state=${authUrl.searchParams.get("state")}`);
    expect(cb.status).toBe(200);
    const token = new URLSearchParams(up.seen.find((s) => s.url === "/token")!.body);
    expect(token.get("client_id")).toBe("slack-id");
    expect(token.get("client_secret")).toBe("s3cr3t-value");
    expect(t.service.views()[0]).toMatchObject({ status: "connected", preRegistered: true });
    // The secret is read on demand: neither the views nor the stored secrets file hold it.
    expect(JSON.stringify(t.service.views())).not.toContain("s3cr3t-value");
    expect(readFileSync(path.join(t.dir, "secrets.json"), "utf8")).not.toContain("s3cr3t-value");
  });

  it("supports client_secret_basic and refreshes with the client credentials", async () => {
    const { up, t } = await preregistered({ tokenEndpointAuth: "client_secret_basic" });
    const authUrl = new URL(await t.service.signIn("slack"));
    await fetch(authUrl);
    await fetch(`${t.base}/oauth/callback?code=the-code&state=${authUrl.searchParams.get("state")}`);
    const first = up.seen.find((s) => s.url === "/token")!;
    expect(first.headers.authorization).toBe(`Basic ${Buffer.from("slack-id:s3cr3t-value").toString("base64")}`);
    expect(first.body).not.toContain("s3cr3t-value");
    await t.creds.headers(t.store.get("slack")!, true);
    const refreshed = up.seen.filter((s) => s.url === "/token").at(-1)!;
    expect(refreshed.body).toContain("grant_type=refresh_token");
    expect(refreshed.headers.authorization).toMatch(/^Basic /);
  });

  it("names the missing reference without revealing values when it cannot be read", async () => {
    const { t, file } = await preregistered();
    writeFileSync(file, JSON.stringify({ nested: { secret: "s3cr3t-value" } }));
    await expect(t.service.signIn("slack")).rejects.toThrow(/no string field "client_id"/);
    await expect(t.service.signIn("slack")).rejects.not.toThrow(/s3cr3t-value/);
  });
});

describe("pre-registered OAuth client entered on the screen", () => {
  async function entered(refs: boolean) {
    const up = await upstream({ noRegistration: true });
    const t = await setup(up);
    const file = path.join(t.dir, "missing.json");
    t.store.add({ name: "slack", url: `${up.url}/mcp`, auth: "oauth", oauthClient: { clientIdRef: `file:${file}#client_id`, ...(refs ? { clientSecretRef: `file:${file}#secret` } : {}) } });
    return { up, t, file };
  }

  it("signs in with stored values when the file ref does not exist, and never reveals them", async () => {
    const { up, t } = await entered(true);
    await expect(t.service.signIn("slack")).rejects.toThrow(/does not exist/);
    t.service.setOAuthClient("slack", { clientId: "ui-id", clientSecret: "ui-s3cret" });
    expect(t.service.views()[0]).toMatchObject({ clientIdSet: true, clientSecretSet: true });
    expect(JSON.stringify(t.service.views())).not.toContain("ui-s3cret");
    const authUrl = new URL(await t.service.signIn("slack"));
    expect(authUrl.searchParams.get("client_id")).toBe("ui-id");
    await fetch(authUrl);
    await fetch(`${t.base}/oauth/callback?code=the-code&state=${authUrl.searchParams.get("state")}`);
    expect(new URLSearchParams(up.seen.find((s) => s.url === "/token")!.body).get("client_secret")).toBe("ui-s3cret");
    // The grant being saved must not drop the stored client.
    expect(t.store.get("slack")!.storedClient).toEqual({ clientId: "ui-id", clientSecret: "ui-s3cret" });
    expect(t.service.views()[0].status).toBe("connected");
    expect(readFileSync(path.join(t.dir, "secrets.json"), "utf8")).toContain("ui-s3cret");
    expect(statSync(path.join(t.dir, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps the other value when only one is replaced, and rejects empty or multi-line input", async () => {
    const { t } = await entered(true);
    t.service.setOAuthClient("slack", { clientId: " ui-id ", clientSecret: "one" });
    t.service.setOAuthClient("slack", { clientSecret: "two" });
    expect(t.store.get("slack")!.storedClient).toEqual({ clientId: "ui-id", clientSecret: "two" });
    expect(() => t.service.setOAuthClient("slack", { clientId: "  " })).toThrow(/Enter a client ID/);
    expect(() => t.service.setOAuthClient("slack", { clientSecret: "a\nb" })).toThrow(/line breaks/);
  });

  it("refuses servers without a pre-registered client", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    expect(() => t.service.setOAuthClient("demo", { clientId: "x" })).toThrow(/pre-registered/);
  });
});

describe("pasted callback", () => {
  async function pending() {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    const authUrl = new URL(await t.service.signIn("demo"));
    await fetch(authUrl);
    return { ...t, state: authUrl.searchParams.get("state")! };
  }

  it("accepts a bare query string, with or without the question mark", async () => {
    const t = await pending();
    await t.service.completeSignIn("demo", `?code=the-code&state=${t.state}`);
    expect(t.service.views()[0].status).toBe("connected");
    const u = await pending();
    await u.service.completeSignIn("demo", `code=the-code&state=${u.state}`);
    expect(u.service.views()[0].status).toBe("connected");
  });

  it("reports a state mismatch without ending the pending sign-in or echoing the code", async () => {
    const t = await pending();
    const err = await t.service.completeSignIn("demo", "http://127.0.0.1:1/oauth/callback?code=secret-code&state=forged").catch((e: Error) => e);
    expect((err as Error).message).toContain("state mismatch");
    expect((err as Error).message).not.toContain("secret-code");
    expect(t.service.views()[0].signingIn).toBe(true);
  });

  it("reports an expired flow and rejects text that is not a callback", async () => {
    const t = await pending();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    await expect(t.service.completeSignIn("demo", `?code=the-code&state=${t.state}`)).rejects.toThrow(/expired/);
    spy.mockRestore();
    await expect(t.service.completeSignIn("demo", "hello")).rejects.toThrow(/not a callback address/);
  });

  it("drops the pending flow on cancel", async () => {
    const t = await pending();
    t.service.cancelSignIn("demo");
    expect(t.service.views()[0].signingIn).toBe(false);
  });
});

describe("pending sign-in persistence", () => {
  /** A fresh service over the same files, as after a plugin reload or daemon restart. */
  const reload = (t: Awaited<ReturnType<typeof setup>>) => new ProxyService(t.store, t.creds, () => t.base, fetch, undefined, new PendingStore(t.pendingFile));

  it("completes a pre-registered (Slack-like) sign-in from the pasted address after a reload", async () => {
    const up = await upstream({ noRegistration: true });
    const t = await setup(up);
    t.store.add({ name: "slack", url: `${up.url}/mcp`, auth: "oauth", oauthClient: { clientIdRef: "env:UNUSED", scopes: ["channels:read"] } });
    t.service.setOAuthClient("slack", { clientId: "ui-id", clientSecret: "ui-s3cret" });
    const authUrl = new URL(await t.service.signIn("slack"));
    await fetch(authUrl);
    const state = authUrl.searchParams.get("state")!;
    // Unrelated writes (client panel Save, settings, instructions) in the meantime, then a reload.
    t.service.setOAuthClient("slack", { clientSecret: "ui-s3cret-2" });
    t.store.setDisplayNames({ slack: "Slack" });
    const next = reload(t);
    expect(next.views()[0].signingIn).toBe(true);
    // Slack echoes extra params; the state is URL-encoded as the browser shows it.
    await next.completeSignIn("slack", `http://127.0.0.1:47824/oauth/callback?code=the-code&state=${encodeURIComponent(state)}&team_id=T1&session_state=x`);
    expect(next.views()[0].status).toBe("connected");
  });

  it("keeps several pending sign-ins valid, so any recent Sign In works", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    const states: string[] = [];
    for (let i = 0; i < 3; i++) states.push(new URL(await t.service.signIn("demo")).searchParams.get("state")!);
    // The code is wrong on purpose: the states must be recognised as ours, so the failure comes from the token exchange.
    for (const s of states.slice(0, 2)) {
      const err = await reload(t).completeSignIn("demo", `?code=wrong&state=${s}`).catch((e: Error) => e);
      expect((err as Error).message).not.toContain("state mismatch");
      expect((err as Error).message).not.toContain("expired");
    }
  });

  it("expires after ten minutes, also across a reload, and cancel clears it", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    const state = new URL(await t.service.signIn("demo")).searchParams.get("state")!;
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await expect(reload(t).completeSignIn("demo", `?code=the-code&state=${state}`)).rejects.toThrow(/expired/);
    spy.mockRestore();
    await t.service.signIn("demo");
    reload(t).cancelSignIn("demo");
    expect(reload(t).views()[0].signingIn).toBe(false);
  });

  it("keeps the verifier in a 0600 file", async () => {
    const up = await upstream();
    const t = await setup(up);
    t.service.add({ name: "demo", url: `${up.url}/mcp`, auth: "oauth" });
    await t.service.signIn("demo");
    expect(statSync(t.pendingFile).mode & 0o777).toBe(0o600);
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
