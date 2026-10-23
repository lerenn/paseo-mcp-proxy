import path from "node:path";
import { SERVER_NAME, type AuthType } from "../shared/server";
import { home, readJson, writeJson } from "./files";

/** OAuth 2.1 state for one server: the registered client, endpoints and the grant. Secret. */
export interface OAuthState {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Canonical URL of the MCP server, sent as the `resource` parameter. */
  resource: string;
  scope?: string;
  redirectUri: string;
  refreshToken?: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export type AuthConfig =
  | { type: "none" }
  | { type: "api-key"; header: string; prefix: string; key: string | null }
  | { type: "oauth"; oauth: OAuthState | null };

export interface ServerRecord {
  name: string;
  url: string;
  instructions: string;
  auth: AuthConfig;
  /** Last failure to authenticate or reach the server; cleared on success. */
  lastError?: string | null;
}

export const defaultServersPath = () => path.join(home(), "servers.json");

/**
 * The registry. Credentials live in the same file, mode 0600, and are handed only to the proxy:
 * nothing here is returned to the screen except through `view`.
 */
export class ServerStore {
  constructor(private readonly file: string = defaultServersPath()) {}

  private read(): Record<string, ServerRecord> {
    return readJson(this.file, {});
  }

  list(): ServerRecord[] {
    return Object.values(this.read()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ServerRecord | null {
    return this.read()[name.toLowerCase()] ?? null;
  }

  names(): string[] {
    return this.list().map((s) => s.name);
  }

  /** Insert or replace a record. */
  put(record: ServerRecord) {
    writeJson(this.file, { ...this.read(), [record.name]: record });
  }

  /** Change one record in place; no-op when it does not exist. */
  update(name: string, change: (record: ServerRecord) => ServerRecord) {
    const all = this.read();
    const current = all[name.toLowerCase()];
    if (!current) return;
    writeJson(this.file, { ...all, [current.name]: change(current) });
  }

  remove(name: string) {
    const { [name.toLowerCase()]: _gone, ...rest } = this.read();
    writeJson(this.file, rest);
  }
}

export function validateName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!SERVER_NAME.test(clean)) throw new Error("Names are lowercase letters, digits and dashes, starting with a letter (32 characters at most)");
  return clean;
}

/** Only http(s) URLs; plain http is allowed for loopback so local servers can be proxied too. */
export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Not a valid URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The URL must start with https:// (http:// is only accepted for localhost)");
  if (url.username || url.password) throw new Error("Do not put credentials in the URL");
  url.hash = "";
  return url.toString();
}

const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function validateHeader(header: string): string {
  const clean = header.trim();
  if (!HEADER.test(clean)) throw new Error("Not a valid header name");
  if (/^(host|content-type|content-length|accept|mcp-session-id|mcp-protocol-version|cookie)$/i.test(clean)) throw new Error(`${clean} cannot carry an API key`);
  return clean;
}

export function authType(record: ServerRecord): AuthType {
  return record.auth.type;
}
