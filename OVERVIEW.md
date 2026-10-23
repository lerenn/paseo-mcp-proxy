MCP Proxy lets agents use remote MCP servers such as Linear, Sentry or Datadog without ever holding their credentials. You register each server once, with an API key or an OAuth sign-in, and the daemon keeps the secrets. Agents connect to a local address on the daemon machine with no credential of their own, and the daemon adds the right one to every request.

For OAuth servers, press Sign In in the screen. The browser opens, you approve once, and the daemon stores the refresh token in a file only its user can read. Access tokens are renewed automatically. Each server shows whether it is connected, needs a sign-in or has an error.

An agent gets servers when it is created with `PASEO_MCP_SERVERS=linear,sentry` in its environment (or `*` for every registered server), so a role or script can ask for servers by name. Agents created without it get the servers of the "Attach to every new agent by default" setting, which is empty unless you set it (`PASEO_MCP_SERVERS=none` opts an agent out). Each agent can only reach the servers it was given.

The list of servers can live in a git repository, one small file per server with no secrets in it. Those servers are read-only in the screen and show where they come from; their keys and sign-ins are still set on the daemon.

Every call is written to an audit list with the server, tool, agent and outcome. Arguments and results are never recorded.

## Setup

Open the MCP Proxy screen and choose Add Server. Give it a short name and the server's URL, then pick how it authenticates. API keys are write-only: the screen never shows them again. For OAuth, press Sign In on the new row: the browser opens and the row asks for the callback address. If your browser runs on a different machine from the daemon, the sign-in page fails to load at the end; copy its address and paste it into the field (it finishes on its own). If the browser does reach the daemon, the row completes by itself.

## Limits

The local address is only reachable from the daemon machine, and each agent needs its own token to use it. This keeps credentials away from agents and other local programs, but it is not a sandbox: an agent with shell access that has credentials from elsewhere can still use them.
