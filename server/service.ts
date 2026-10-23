import { timeout } from "./files";
import { randomBytes } from "node:crypto";
import type { ServerView } from "../shared/server";
import * as oauth from "./oauth";
import { AuthRequired, type Credentials } from "./upstream";
import type { ServerRecord, ServerStore } from "./store";
import { validateHeader, validateName, validateUrl } from "./validate";

const PENDING_TTL_MS = 10 * 60_000;

interface Pending {
  name: string;
  verifier: string;
  expires: number;
}

export interface AddInput {
  name: string;
  url: string;
  auth: "none" | "api-key" | "oauth";
  header?: string;
  apiKey?: string;
  instructions?: string;
}

/** Backs the screen's RPCs: registry edits, OAuth sign-in and connection tests. */
export class ProxyService {
  private readonly pending = new Map<string, Pending>();
  /** States of flows that timed out, kept for a while so the error can say "expired" rather than "unknown". */
  private readonly expired = new Map<string, number>();

  constructor(
    private readonly store: ServerStore,
    private readonly creds: Credentials,
    private readonly endpoint: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  views(): ServerView[] {
    this.sweep();
    const signingIn = new Set([...this.pending.values()].map((p) => p.name));
    return this.store.list().map((r) => view(r, signingIn.has(r.name)));
  }

  add(input: AddInput) {
    const name = validateName(input.name);
    const url = validateUrl(input.url);
    const header = input.auth === "api-key" ? validateHeader(input.header?.trim() || "Authorization") : undefined;
    const instructions = input.instructions?.trim() || undefined;
    if (input.auth !== "api-key") return this.store.add({ name, url, auth: input.auth, instructions });
    const key = cleanKey(input.apiKey);
    this.store.add({ name, url, auth: "api-key", header, instructions }, { apiKey: key, prefix: prefixFor(header!, key) });
  }

  remove(name: string) {
    this.store.remove(name);
    for (const [state, p] of this.pending) if (p.name === name) this.pending.delete(state);
  }

  /** Allowed for git-managed servers too: the definition is in git, the key never is. */
  setKey(name: string, apiKey: string) {
    const key = cleanKey(apiKey);
    const record = this.require(name);
    if (record.auth.type !== "api-key") throw new Error(`"${name}" does not use an API key`);
    const { header } = record.auth;
    this.store.update(name, (r) => ({ ...r, lastError: null, auth: { type: "api-key", header, prefix: prefixFor(header, key), key } }));
  }

  setInstructions(name: string, instructions: string) {
    this.store.setInstructions(name, instructions.trim());
  }

  signOut(name: string) {
    const record = this.require(name);
    if (record.auth.type !== "oauth") return;
    this.store.update(name, (r) =>
      r.auth.type === "oauth" && r.auth.oauth ? { ...r, lastError: null, auth: { type: "oauth", oauth: { ...r.auth.oauth, refreshToken: undefined, accessToken: undefined, expiresAt: undefined } } } : r,
    );
  }

  /** Discover, register (once per redirect address) and return the browser URL. */
  async signIn(name: string): Promise<string> {
    const record = this.require(name);
    if (record.auth.type !== "oauth") throw new Error(`"${name}" does not use OAuth`);
    const base = this.endpoint();
    if (!base) throw new Error("The proxy endpoint is not running, so the browser cannot return here");
    const redirectUri = `${base}/oauth/callback`;
    const info = await oauth.discover(record.url, this.fetchImpl);
    const known = record.auth.oauth;
    const client =
      known && known.redirectUri === redirectUri && known.tokenEndpoint === info.tokenEndpoint
        ? { clientId: known.clientId, clientSecret: known.clientSecret }
        : await oauth.register(info, redirectUri, this.fetchImpl);
    const state: Pick<NonNullable<typeof known>, "clientId" | "clientSecret" | "authorizationEndpoint" | "tokenEndpoint" | "resource" | "scope" | "redirectUri"> = {
      ...client,
      authorizationEndpoint: info.authorizationEndpoint,
      tokenEndpoint: info.tokenEndpoint,
      resource: info.resource,
      scope: info.scope,
      redirectUri,
    };
    // Keep the old grant until the new one succeeds, so a cancelled sign-in does not disconnect the server.
    this.store.update(name, (r) => ({ ...r, auth: { type: "oauth", oauth: { ...state, refreshToken: known?.refreshToken, accessToken: known?.accessToken, expiresAt: known?.expiresAt } } }));
    const { verifier, challenge } = oauth.pkce();
    const nonce = randomBytes(24).toString("base64url");
    this.pending.set(nonce, { name, verifier, expires: Date.now() + PENDING_TTL_MS });
    return oauth.authorizationUrl({ info, clientId: client.clientId, redirectUri, challenge, state: nonce });
  }

  /** The browser came back (to the daemon's callback, or via a pasted address). */
  async finishSignIn(params: URLSearchParams, expectName?: string): Promise<{ ok: boolean; message: string }> {
    this.sweep();
    const state = params.get("state") ?? "";
    const pending = this.pending.get(state);
    if (!pending && this.expired.has(state)) return { ok: false, message: "This sign-in expired. Press Sign In again to start a new one." };
    if (!pending || (expectName && pending.name !== expectName)) return { ok: false, message: "This address belongs to a different sign-in (state mismatch). Paste the address from the latest Sign In." };
    this.pending.delete(state);
    const error = params.get("error");
    if (error) return { ok: false, message: `The server refused the sign-in: ${params.get("error_description") ?? error}` };
    const code = params.get("code");
    if (!code) return { ok: false, message: "The address has no authorization code." };
    const record = this.store.get(pending.name);
    if (!record || record.auth.type !== "oauth" || !record.auth.oauth) return { ok: false, message: "The server was removed during sign-in." };
    try {
      const tokens = await oauth.exchangeCode(record.auth.oauth, code, pending.verifier, this.fetchImpl);
      this.store.update(pending.name, (r) =>
        r.auth.type === "oauth" && r.auth.oauth
          ? { ...r, lastError: null, auth: { type: "oauth", oauth: { ...r.auth.oauth, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? r.auth.oauth.refreshToken, expiresAt: tokens.expiresAt } } }
          : r,
      );
      return { ok: true, message: `${pending.name} is connected.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Accepts the full callback address or just its query string (`code=…&state=…`, with or without `?`). */
  async completeSignIn(name: string, pasted: string) {
    const params = parseCallback(pasted);
    if (!params) throw new Error("That is not a callback address. Paste the whole address from the browser's address bar.");
    const outcome = await this.finishSignIn(params, validateName(name));
    if (!outcome.ok) throw new Error(outcome.message);
  }

  /** Drop the pending flow of a server (the user cancelled). */
  cancelSignIn(name: string) {
    for (const [state, p] of this.pending) if (p.name === name) this.pending.delete(state);
  }

  /** Open an MCP session upstream with the stored credentials. */
  async test(name: string): Promise<{ ok: boolean; message: string }> {
    const record = this.require(name);
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(await this.creds.headers(record)),
      };
      const res = await this.fetchImpl(record.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "paseo-mcp-proxy", version: "0.1.0" } } }),
        signal: timeout(20_000),
      });
      const text = await res.text();
      const sessionId = res.headers.get("mcp-session-id");
      if (sessionId) void this.fetchImpl(record.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId } }).catch(() => {});
      if (!res.ok) {
        const message = res.status === 401 || res.status === 403 ? `The server rejected the credentials (HTTP ${res.status})` : `The server answered HTTP ${res.status}`;
        this.creds.setError(name, message);
        return { ok: false, message };
      }
      this.creds.setError(name, null);
      const info = /"serverInfo":\{[^}]*"name":"([^"]+)"/.exec(text)?.[1];
      return { ok: true, message: info ? `Connected to ${info}` : "Connected" };
    } catch (err) {
      const message = err instanceof AuthRequired ? (record.auth.type === "api-key" ? "No API key is set" : "Needs sign-in") : (err as Error).message;
      this.creds.setError(name, message);
      return { ok: false, message };
    }
  }

  private require(name: string): ServerRecord {
    const record = this.store.get(name);
    if (!record) throw new Error(`No server named "${name}"`);
    return record;
  }

  private sweep() {
    const now = Date.now();
    for (const [state, p] of this.pending) {
      if (p.expires >= now) continue;
      this.pending.delete(state);
      this.expired.set(state, now);
    }
    for (const [state, at] of this.expired) if (now - at > 60 * 60_000) this.expired.delete(state);
  }
}

/** Callback parameters from a pasted full address or bare query string; null if it is neither. */
export function parseCallback(raw: string): URLSearchParams | null {
  const text = raw.trim();
  let query: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      query = new URL(text).search;
    } catch {
      return null;
    }
  } else {
    query = text.replace(/^[^?=&]*\?/, "");
  }
  const params = new URLSearchParams(query.replace(/^\?/, "").replace(/#.*$/, ""));
  return params.has("state") && (params.has("code") || params.has("error")) ? params : null;
}

/** "Authorization" keys usually want the Bearer scheme; any other header carries the bare value. */
function prefixFor(header: string, key: string): string {
  return header.toLowerCase() === "authorization" && !/^\w+\s/.test(key) ? "Bearer " : "";
}

function cleanKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key) throw new Error("The API key is empty");
  if (/[\r\n]/.test(key)) throw new Error("Keys cannot contain line breaks");
  return key;
}

export function view(r: ServerRecord, signingIn: boolean): ServerView {
  let status: ServerView["status"] = "connected";
  let detail: string | null = null;
  if (r.auth.type === "api-key" && !r.auth.key) {
    status = "needs-sign-in";
    detail = "No API key is set";
  } else if (r.auth.type === "oauth" && !r.auth.oauth?.refreshToken && !r.auth.oauth?.accessToken) {
    status = "needs-sign-in";
    detail = signingIn ? "Waiting for the browser…" : r.lastError ?? "Not signed in yet";
  } else if (r.lastError) {
    status = "error";
    detail = r.lastError;
  }
  return {
    name: r.name,
    url: r.url,
    auth: r.auth.type,
    header: r.auth.type === "api-key" ? r.auth.header : null,
    instructions: r.instructions,
    status,
    detail,
    signingIn,
    origin: r.origin,
  };
}
