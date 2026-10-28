import path from "node:path";
import type { Definition, OAuthClient } from "../shared/definition";
import type { AuthType } from "../shared/server";
import { home, readJson, writeJson } from "./files";
import type { GitRegistry } from "./registry";

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

/** Pre-registered OAuth client values entered on the screen. They win over the definition's references. Secret. */
export interface StoredClient {
  clientId?: string;
  clientSecret?: string;
}

/** A server as the proxy uses it: its definition plus the secrets kept for its name. */
export interface ServerRecord {
  name: string;
  /** Effective label: local override, else the definition's; null when neither is set. */
  displayName: string | null;
  /** The definition's own label, without the local override. */
  definitionDisplayName: string | null;
  url: string;
  instructions: string;
  /** The tools agents may use (see the definition's `allowTools`); null allows all. */
  allowTools: string[] | null;
  /** Never granted by `*` (see the definition's `explicitOnly`). */
  explicitOnly: boolean;
  /** Pre-registered OAuth client references (never values), for oauth servers. */
  oauthClient: OAuthClient | null;
  /** Client values entered on the screen for this server (empty when none). Never sent to the screen. */
  storedClient: StoredClient;
  auth: AuthConfig;
  /** Last failure to authenticate or reach the server; cleared on success. */
  lastError?: string | null;
  /** Short git source label for servers defined in git (read-only); null for servers added on the screen. */
  origin: string | null;
}

/** What is kept on the daemon for a name. The URL it was obtained for guards against a redirected server. */
interface Secrets {
  url: string;
  apiKey?: string;
  prefix?: string;
  oauth?: OAuthState;
  client?: StoredClient;
  lastError?: string | null;
}

export const defaultDefinitionsPath = () => path.join(home(), "servers.json");
export const defaultSecretsPath = () => path.join(home(), "secrets.json");

/**
 * The registry. Definitions come from git sources (read-only, they win) and from servers added on
 * the screen (`servers.json`, no secrets). Secrets live apart in `secrets.json` (mode 0600), keyed by
 * server name, and are never part of a definition. Secrets saved for another URL are ignored, so
 * pointing a name somewhere else never sends the old credentials there.
 */
export class ServerStore {
  /** Local display names by server name (from the plugin settings); they win over the definitions'. */
  private overrides: Record<string, string> = {};

  constructor(
    private readonly git: Pick<GitRegistry, "get" | "all"> | null = null,
    private readonly definitionsFile: string = defaultDefinitionsPath(),
    private readonly secretsFile: string = defaultSecretsPath(),
  ) {}

  setDisplayNames(names: Record<string, string>) {
    this.overrides = Object.fromEntries(Object.entries(names).map(([k, v]) => [k.toLowerCase(), v.trim()]).filter(([, v]) => v));
  }

  private local(): Record<string, Definition> {
    return readJson(this.definitionsFile, {});
  }

  private secrets(): Record<string, Secrets> {
    return readJson(this.secretsFile, {});
  }

  private assemble(def: Definition, origin: string | null, secrets: Secrets | undefined): ServerRecord {
    const mine = secrets && secrets.url === def.url ? secrets : undefined;
    let auth: AuthConfig;
    if (def.auth === "api-key") auth = { type: "api-key", header: def.header ?? "Authorization", prefix: mine?.prefix ?? "", key: mine?.apiKey ?? null };
    else if (def.auth === "oauth") auth = { type: "oauth", oauth: mine?.oauth ?? null };
    else auth = { type: "none" };
    return { name: def.name, displayName: this.overrides[def.name] ?? def.displayName ?? null, definitionDisplayName: def.displayName ?? null, url: def.url, instructions: def.instructions ?? "", allowTools: def.allowTools ?? null, explicitOnly: def.explicitOnly === true, oauthClient: def.auth === "oauth" ? def.oauthClient ?? null : null, storedClient: def.auth === "oauth" ? mine?.client ?? {} : {}, auth, lastError: mine?.lastError ?? null, origin };
  }

  list(): ServerRecord[] {
    const secrets = this.secrets();
    const byName = new Map<string, ServerRecord>();
    for (const def of Object.values(this.local())) byName.set(def.name, this.assemble(def, null, secrets[def.name]));
    for (const def of this.git?.all() ?? []) byName.set(def.name, this.assemble(def, def.origin, secrets[def.name]));
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ServerRecord | null {
    const key = name.toLowerCase();
    const gitDef = this.git?.get(key);
    if (gitDef) return this.assemble(gitDef, gitDef.origin, this.secrets()[key]);
    const def = this.local()[key];
    return def ? this.assemble(def, null, this.secrets()[key]) : null;
  }

  names(): string[] {
    return this.list().map((s) => s.name);
  }

  /** Names `*` grants: every server but the `explicitOnly` ones. */
  wildcardNames(): string[] {
    return this.list().filter((s) => !s.explicitOnly).map((s) => s.name);
  }

  /** Add a server on the screen. Refuses a name that exists, in git or locally. */
  add(def: Definition, secrets: { apiKey?: string; prefix?: string } = {}) {
    if (this.get(def.name)) throw new Error(`"${def.name}" already exists`);
    writeJson(this.definitionsFile, { ...this.local(), [def.name]: def });
    this.writeSecrets(def.name, { url: def.url, ...secrets });
  }

  /** Change a local server's notes. Git-managed servers are read-only. */
  setInstructions(name: string, instructions: string) {
    const record = this.require(name);
    if (record.origin) throw new Error(`"${name}" is managed in git (${record.origin}) and is read-only here`);
    writeJson(this.definitionsFile, { ...this.local(), [record.name]: { ...this.local()[record.name], instructions } });
  }

  /**
   * Change the secrets and error state of a server (the part of a record that is not its
   * definition). Definition fields in the returned record are ignored.
   */
  update(name: string, change: (record: ServerRecord) => ServerRecord) {
    const current = this.get(name);
    if (!current) return;
    const next = change(current);
    const secrets: Secrets = { url: current.url, lastError: next.lastError ?? null };
    if (next.auth.type === "api-key") {
      if (next.auth.key) secrets.apiKey = next.auth.key;
      if (next.auth.prefix) secrets.prefix = next.auth.prefix;
    } else if (next.auth.type === "oauth") {
      if (next.auth.oauth) secrets.oauth = next.auth.oauth;
      if (next.storedClient.clientId || next.storedClient.clientSecret) secrets.client = next.storedClient;
    }
    const previous = this.secrets()[current.name];
    // An unchanged error state must not rewrite the file on every request.
    if (previous && JSON.stringify(previous) === JSON.stringify(secrets)) return;
    this.writeSecrets(current.name, secrets);
  }

  /** Remove a local server and its secrets. Git-managed servers are removed in git. */
  remove(name: string) {
    const record = this.get(name);
    if (record?.origin) throw new Error(`"${name}" is managed in git (${record.origin}); remove it there`);
    const { [name.toLowerCase()]: _gone, ...rest } = this.local();
    writeJson(this.definitionsFile, rest);
    this.dropSecrets(name);
  }

  private writeSecrets(name: string, secrets: Secrets) {
    writeJson(this.secretsFile, { ...this.secrets(), [name.toLowerCase()]: secrets });
  }

  private dropSecrets(name: string) {
    const { [name.toLowerCase()]: _gone, ...rest } = this.secrets();
    writeJson(this.secretsFile, rest);
  }

  private require(name: string): ServerRecord {
    const record = this.get(name);
    if (!record) throw new Error(`No server named "${name}"`);
    return record;
  }
}

export function authType(record: ServerRecord): AuthType {
  return record.auth.type;
}
