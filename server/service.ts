import { timeout } from "./files";
import { randomBytes } from "node:crypto";
import { displayNameSchema, type ServerView } from "../shared/server";
import * as oauth from "./oauth";
import { PENDING_TTL_MS, PendingStore } from "./pending";
import { AuthRequired, type Credentials } from "./upstream";
import type { ServerRecord, ServerStore } from "./store";
import { DEFAULT_HTTP_HOSTS, validateHeader, validateName, validateUrl } from "./validate";

export interface AddInput {
  name: string;
  displayName?: string;
  url: string;
  auth: "none" | "api-key" | "oauth";
  header?: string;
  apiKey?: string;
  instructions?: string;
}

/** Backs the screen's RPCs: registry edits, OAuth sign-in and connection tests. */
export class ProxyService {
  constructor(
    private readonly store: ServerStore,
    private readonly creds: Credentials,
    private readonly endpoint: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly allowHttpHosts: () => string[] = () => DEFAULT_HTTP_HOSTS,
    /** Pending sign-ins live in a file on the daemon, not in this object, so they outlive a reload. */
    private readonly pending: PendingStore = new PendingStore(),
  ) {}

  views(): ServerView[] {
    const signingIn = this.pending.names();
    return this.store.list().map((r) => view(r, signingIn.has(r.name)));
  }

  add(input: AddInput) {
    const name = validateName(input.name);
    const url = validateUrl(input.url, this.allowHttpHosts());
    const header = input.auth === "api-key" ? validateHeader(input.header?.trim() || "Authorization") : undefined;
    const instructions = input.instructions?.trim() || undefined;
    const displayName = input.displayName?.trim() ? displayNameSchema.parse(input.displayName) : undefined;
    if (input.auth !== "api-key") return this.store.add({ name, displayName, url, auth: input.auth, instructions });
    const key = cleanKey(input.apiKey);
    this.store.add({ name, displayName, url, auth: "api-key", header, instructions }, { apiKey: key, prefix: prefixFor(header!, key) });
  }

  remove(name: string) {
    this.store.remove(name);
    this.pending.deleteServer(name.toLowerCase());
  }

  /** Allowed for git-managed servers too: the definition is in git, the key never is. */
  setKey(name: string, apiKey: string) {
    const key = cleanKey(apiKey);
    const record = this.require(name);
    if (record.auth.type !== "api-key") throw new Error(`"${name}" does not use an API key`);
    const { header } = record.auth;
    this.store.update(name, (r) => ({ ...r, lastError: null, auth: { type: "api-key", header, prefix: prefixFor(header, key), key } }));
  }

  /** Store the pre-registered client entered on the screen. Allowed for git-managed servers: the secret is never in git. */
  setOAuthClient(name: string, input: { clientId?: string; clientSecret?: string }) {
    const record = this.require(name);
    if (record.auth.type !== "oauth" || !record.oauthClient) throw new Error(`"${name}" does not use a pre-registered OAuth client`);
    const clientId = cleanValue(input.clientId, "client ID");
    const clientSecret = cleanValue(input.clientSecret, "client secret");
    if (!clientId && !clientSecret) throw new Error("Enter a client ID or a client secret");
    this.store.update(name, (r) => ({ ...r, lastError: null, storedClient: { ...r.storedClient, ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) } }));
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
    // A pre-registered client replaces dynamic registration, and its scopes replace the advertised ones.
    const preset = record.oauthClient;
    if (preset?.scopes) info.scope = preset.scopes.join(" ");
    const client = preset
      ? { clientId: oauth.resolveClient(preset, record.storedClient).clientId, clientSecret: undefined }
      : known && known.redirectUri === redirectUri && known.tokenEndpoint === info.tokenEndpoint
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
    this.pending.add(nonce, { name: record.name, verifier, expires: Date.now() + PENDING_TTL_MS });
    return oauth.authorizationUrl({ info, clientId: client.clientId, redirectUri, challenge, state: nonce });
  }

  /** The browser came back (to the daemon's callback, or via a pasted address). */
  async finishSignIn(params: URLSearchParams, expectName?: string): Promise<{ ok: boolean; message: string }> {
    const state = (params.get("state") ?? "").trim();
    const pending = this.pending.get(state);
    if (!pending && this.pending.wasExpired(state)) return { ok: false, message: "This sign-in expired. Press Sign In again to start a new one." };
    if (!pending || (expectName && pending.name.toLowerCase() !== expectName.toLowerCase())) return { ok: false, message: "This address belongs to a different sign-in (state mismatch). Paste the address from the latest Sign In." };
    this.pending.delete(state);
    const error = params.get("error");
    if (error) return { ok: false, message: `The server refused the sign-in: ${params.get("error_description") ?? error}` };
    const code = params.get("code");
    if (!code) return { ok: false, message: "The address has no authorization code." };
    const record = this.store.get(pending.name);
    if (!record || record.auth.type !== "oauth" || !record.auth.oauth) return { ok: false, message: "The server was removed during sign-in." };
    try {
      const tokens = await oauth.exchangeCode(record.auth.oauth, code, pending.verifier, this.fetchImpl, record.oauthClient ? oauth.resolveClient(record.oauthClient, record.storedClient) : undefined);
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
    this.pending.deleteServer(name.toLowerCase());
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
        const detail = upstreamDetail(text);
        const base = res.status === 401 || res.status === 403 ? `The server rejected the credentials (HTTP ${res.status})` : `The server answered HTTP ${res.status}`;
        const message = detail ? `${base}: ${detail}` : base;
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
}

/** The reason an upstream gave for an error (JSON-RPC, OAuth or Slack style), with anything token-like removed. */
export function upstreamDetail(body: string): string {
  let reason = "";
  try {
    const json: any = JSON.parse(body);
    const err = json?.error;
    const parts = [typeof err === "string" ? err : err?.message, json?.error_description, json?.message].filter((p) => typeof p === "string" && p);
    reason = parts.join(" - ");
  } catch {
    reason = body.replace(/<[^>]*>/g, " ");
  }
  return reason
    .replace(/\b(?:xox[a-z]-|xapp-|sk-|ghp_|gho_)[\w-]+/gi, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(code|token|secret|client_secret|access_token|refresh_token)=[^\s&]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
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

function cleanValue(raw: string | undefined, what: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/[\r\n]/.test(value)) throw new Error(`The ${what} cannot contain line breaks`);
  return value;
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
    displayName: r.displayName,
    definitionDisplayName: r.definitionDisplayName,
    url: r.url,
    auth: r.auth.type,
    header: r.auth.type === "api-key" ? r.auth.header : null,
    preRegistered: r.oauthClient !== null,
    clientIdSet: r.storedClient.clientId !== undefined,
    clientSecretSet: r.storedClient.clientSecret !== undefined,
    instructions: r.instructions,
    status,
    detail,
    signingIn,
    origin: r.origin,
  };
}
