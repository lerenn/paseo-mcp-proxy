/**
 * The convention other plugins (for example agents-roles) rely on, without importing this one:
 * set `PASEO_MCP_SERVERS` in an agent's environment at creation to a comma-separated list of
 * registry names, or `*` for every registered server.
 */
export const SERVERS_ENV = "PASEO_MCP_SERVERS";
export const URL_ENV = "PASEO_MCP_PROXY_URL";
export const CAPABILITY_ENV = "PASEO_MCP_PROXY_CAPABILITY";

export const ALL = "*";

/** Names asked for in the environment, lower-cased and de-duplicated; `*` stands for all. */
export function requestedServers(env: Record<string, string | undefined> | undefined): string[] {
  const raw = env?.[SERVERS_ENV];
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean))];
}
