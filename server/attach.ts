import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { ALL, CAPABILITY_ENV, URL_ENV, requestedServers } from "../shared/plugin";

type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;

export interface AttachOptions {
  /** Base URL of the local proxy endpoint, no trailing slash. */
  url: string;
  /** Servers every new agent gets unless its own PASEO_MCP_SERVERS says otherwise. */
  defaults?: string[];
  /** Names currently in the registry. */
  registered: string[];
  /** Mints the agent's capability for the servers it is granted. */
  capability(granted: string[]): string;
}

/**
 * Give a new agent the proxied servers it asked for with PASEO_MCP_SERVERS, or the default list when
 * it did not set the variable. Returns undefined when there are none, so other agents stay exactly as they are. Names that are not registered are
 * not an error: they are listed in a note so the agent can tell the user.
 */
export function attachServers(request: CreateRequest, o: AttachOptions): CreateRequest | undefined {
  const asked = requestedServers(request.env, o.defaults);
  if (!asked.length) return undefined;
  const granted = asked.includes(ALL) ? [...o.registered] : asked.filter((n) => o.registered.includes(n));
  const missing = asked.filter((n) => n !== ALL && !o.registered.includes(n));

  const capability = o.capability(asked.includes(ALL) ? [ALL] : granted);
  const mcpServers: McpServers = { ...(request.config.mcpServers ?? {}) };
  for (const name of granted) {
    // The proxied entry replaces any same-named server: the role asked for it by name.
    mcpServers[name] = { type: "http", url: `${o.url}/s/${name}/mcp`, headers: { authorization: `Bearer ${capability}` } };
  }

  const notes = [
    granted.length ? `MCP servers available through MCP Proxy, with no credentials needed on your side: ${granted.join(", ")}.` : "",
    missing.length ? `MCP servers requested but not configured in MCP Proxy (tell the user to add them there): ${missing.join(", ")}.` : "",
  ].filter(Boolean);

  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: [request.config.systemPrompt, ...notes].filter(Boolean).join("\n\n"),
      mcpServers,
    },
    env: { ...request.env, [URL_ENV]: o.url, [CAPABILITY_ENV]: capability },
  };
}
