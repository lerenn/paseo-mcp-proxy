import { createHash, randomBytes } from "node:crypto";
import { timeout } from "./files";
import type { OAuthClient } from "../shared/definition";
import { resolveRef } from "./refs";
import type { OAuthState } from "./store";

type Fetch = typeof fetch;

export interface AuthServerInfo {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
  resource: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The grant is gone for good (revoked or expired refresh token): the user has to sign in again. */
    readonly permanent = false,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function getJson(fetchImpl: Fetch, url: string): Promise<any | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" }, signal: timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** `/.well-known/<suffix>` for a URL, inserted before its path as RFC 8414 and RFC 9728 say. */
function wellKnown(base: URL, suffix: string): string {
  const p = base.pathname.replace(/\/+$/, "");
  return `${base.origin}/.well-known/${suffix}${p}`;
}

/**
 * Find the OAuth endpoints of an MCP server, following the MCP authorization spec: protected
 * resource metadata (RFC 9728), then authorization server metadata (RFC 8414 or OpenID), then the
 * legacy default paths on the server's own origin.
 */
export async function discover(serverUrl: string, fetchImpl: Fetch = fetch): Promise<AuthServerInfo> {
  const server = new URL(serverUrl);
  let metadataUrl: string | null = null;
  try {
    const probe = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      signal: timeout(TIMEOUT_MS),
    });
    const challenge = probe.headers.get("www-authenticate") ?? "";
    metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? null;
    await probe.body?.cancel();
  } catch {
    // The well-known fallback below still works.
  }
  const resourceMeta =
    (metadataUrl ? await getJson(fetchImpl, metadataUrl) : null) ??
    (await getJson(fetchImpl, wellKnown(server, "oauth-protected-resource"))) ??
    (await getJson(fetchImpl, `${server.origin}/.well-known/oauth-protected-resource`));

  const issuerRaw: string = resourceMeta?.authorization_servers?.[0] ?? server.origin;
  const issuer = new URL(issuerRaw);
  const path = issuer.pathname.replace(/\/+$/, "");
  const candidates = [
    wellKnown(issuer, "oauth-authorization-server"),
    wellKnown(issuer, "openid-configuration"),
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
  let meta: any = null;
  for (const url of candidates) {
    meta = await getJson(fetchImpl, url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  const scopes: string[] | undefined = resourceMeta?.scopes_supported;
  const resource = typeof resourceMeta?.resource === "string" ? resourceMeta.resource : serverUrl;
  if (meta) {
    return {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      registrationEndpoint: meta.registration_endpoint,
      scope: scopes?.length ? scopes.join(" ") : undefined,
      resource,
    };
  }
  if (!resourceMeta) throw new OAuthError(`${server.host} does not advertise OAuth. Use "None" or "API key" for this server.`);
  // Metadata of the resource but not of the AS: assume the legacy default paths.
  return {
    authorizationEndpoint: `${issuer.origin}/authorize`,
    tokenEndpoint: `${issuer.origin}/token`,
    registrationEndpoint: `${issuer.origin}/register`,
    scope: scopes?.length ? scopes.join(" ") : undefined,
    resource,
  };
}

/** Dynamic client registration (RFC 7591) as a public client. */
export async function register(info: AuthServerInfo, redirectUri: string, fetchImpl: Fetch = fetch): Promise<{ clientId: string; clientSecret?: string }> {
  if (!info.registrationEndpoint) throw new OAuthError("This server does not support dynamic client registration.");
  const res = await fetchImpl(info.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Paseo MCP Proxy",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(info.scope ? { scope: info.scope } : {}),
    }),
    signal: timeout(TIMEOUT_MS),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw new OAuthError(`Client registration failed (HTTP ${res.status}${body.error_description ? `: ${body.error_description}` : body.error ? `: ${body.error}` : ""})`);
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** A pre-registered client with its references read; kept in memory only. */
export interface ClientAuth {
  clientId: string;
  clientSecret?: string;
  method: "client_secret_post" | "client_secret_basic" | "none";
}

export function resolveClient(def: OAuthClient): ClientAuth {
  const clientSecret = def.clientSecretRef ? resolveRef(def.clientSecretRef) : undefined;
  return { clientId: resolveRef(def.clientIdRef), clientSecret, method: def.tokenEndpointAuth ?? (clientSecret ? "client_secret_post" : "none") };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(o: { info: AuthServerInfo; clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(o.info.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("code_challenge", o.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", o.state);
  url.searchParams.set("resource", o.info.resource);
  if (o.info.scope) url.searchParams.set("scope", o.info.scope);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function tokenRequest(state: Pick<OAuthState, "tokenEndpoint" | "clientId" | "clientSecret" | "resource">, params: Record<string, string>, fetchImpl: Fetch, client?: ClientAuth): Promise<TokenSet> {
  const clientId = client?.clientId ?? state.clientId;
  const clientSecret = client ? client.clientSecret : state.clientSecret;
  const method = client?.method ?? "client_secret_post";
  const body = new URLSearchParams({ ...params, resource: state.resource });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (method === "client_secret_basic" && clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  else {
    body.set("client_id", clientId);
    if (clientSecret && method !== "none") body.set("client_secret", clientSecret);
  }
  let res: Response;
  try {
    res = await fetchImpl(state.tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`Cannot reach the token endpoint: ${(err as Error).message}`);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // invalid_grant and friends mean the grant is gone; 5xx and network errors are worth retrying later.
    const permanent = res.status >= 400 && res.status < 500 && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(json.error);
    throw new OAuthError(`Token endpoint refused the request (HTTP ${res.status}${json.error ? `: ${json.error}` : ""})`, permanent);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

export function exchangeCode(state: OAuthState, code: string, verifier: string, fetchImpl: Fetch = fetch, client?: ClientAuth): Promise<TokenSet> {
  return tokenRequest(state, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: state.redirectUri }, fetchImpl, client);
}

export function refresh(state: OAuthState, fetchImpl: Fetch = fetch, client?: ClientAuth): Promise<TokenSet> {
  if (!state.refreshToken) throw new OAuthError("Not signed in", true);
  return tokenRequest(state, { grant_type: "refresh_token", refresh_token: state.refreshToken }, fetchImpl, client);
}
