/**
 * The convention other plugins (for example agents-roles) rely on, without importing this one:
 * set `PASEO_MCP_SERVERS` in an agent's environment at creation to a comma-separated list of
 * registry names, or `*` for every registered server. An explicit empty value or `none` opts the
 * agent out of the plugin's "attach by default" setting.
 */
export const SERVERS_ENV = "PASEO_MCP_SERVERS";
export const URL_ENV = "PASEO_MCP_PROXY_URL";
export const CAPABILITY_ENV = "PASEO_MCP_PROXY_CAPABILITY";

export const ALL = "*";

/** Lower-cased, de-duplicated names from a comma or space separated list; `*` stands for all. */
export function parseServerList(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Names an agent gets: its own `PASEO_MCP_SERVERS` when that is set (empty or `none` means none),
 * otherwise the plugin's default list.
 */
export function requestedServers(env: Record<string, string | undefined> | undefined, defaults: string[] = []): string[] {
  const raw = env?.[SERVERS_ENV];
  if (raw === undefined) return defaults;
  const names = parseServerList(raw);
  return names.length === 1 && names[0] === "none" ? [] : names;
}

/**
 * Servers granted by an agent's labels: `rules` maps `key=value` (or a bare `key`, any value) to a server list.
 * Labels come from the daemon's create context; without them (an older daemon) nothing is granted.
 */
export function serversForLabels(labels: Record<string, string> | undefined, rules: Record<string, string>): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const [rule, servers] of Object.entries(rules)) {
    const i = rule.indexOf("=");
    const key = i < 0 ? rule : rule.slice(0, i);
    const value = i < 0 ? undefined : rule.slice(i + 1);
    if (key in labels && (value === undefined || labels[key] === value)) out.push(...parseServerList(servers));
  }
  return [...new Set(out)];
}
