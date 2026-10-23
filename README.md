# paseo-mcp-proxy

A [Paseo](https://paseo.sh) plugin that lets agents use remote MCP servers without ever holding their
credentials. The daemon keeps API keys and OAuth sign-ins, and a loopback proxy adds them to every
request. It is a generic rebuild of the mcp-proxy used in the Gas City for Linear, Slack, Sentry and
Datadog.

## Design

- Registry: named upstream MCP servers (`name`, `url`, auth). Auth is `none`, an API key sent in a
  chosen header (default `Authorization: Bearer ...`), or OAuth 2.1.
- Secrets: API keys are write-only. Neither they nor OAuth tokens are ever returned to the screen.
  All state is under `~/.paseo/mcp-proxy/` (directory 0700, files 0600) on the daemon machine.
- OAuth 2.1, per the MCP authorization spec: protected resource metadata (RFC 9728), authorization
  server metadata (RFC 8414 / OpenID, with the legacy `/authorize`, `/token`, `/register` fallback),
  dynamic client registration (RFC 7591, public client), PKCE `S256`, and the `resource` parameter
  (RFC 8707). The refresh token is stored, access tokens are renewed 60 s before expiry, one refresh
  at a time per server, and a rotated refresh token is saved before use. A 401 from upstream triggers
  one forced refresh and one replay (the server answered before acting, so no tool runs twice).
  `invalid_grant` forgets the grant and the server shows "Needs Sign-In"; other refresh failures back off
  for 30 s and show "Error".
- Proxy: `http://127.0.0.1:47824/s/<name>/mcp` (change with `MCP_PROXY_PORT` on the daemon; resumed
  agents keep the URL they were created with, so keep it stable). Streamable HTTP and SSE: `POST`,
  `GET` and `DELETE` are forwarded, SSE is streamed, `Mcp-Session-Id` passes through. The agent's own
  `Authorization` header is dropped and the server's credential is added. The `Host` header must be
  loopback (DNS-rebinding guard).
- Agent access: a per-agent capability token, minted at `agent.create`, injected as the bearer in the
  agent's MCP config and bound to the agent id at `agent.session_open`. It carries no upstream access
  and only reaches the servers that agent was granted. Other local processes do not have one.
- When a server needs sign-in or its key is missing, the call is answered inside the MCP exchange
  (a tool error, or a JSON-RPC error) telling the agent to ask the user, and nothing is sent upstream.
- Instructions: the `initialize` result's `instructions` gets a short note ("you hold no credentials;
  ask the user to sign in") plus optional per-server notes set in the screen, after any instructions the
  server itself sends.
- Audit: `~/.paseo/mcp-proxy/audit.jsonl` (0600, one rotation at 5 MB): time, server, JSON-RPC method,
  tool name (`tools/call` only), agent id, upstream status, duration, short error. No arguments, no
  results, no credentials. The screen shows the latest entries.

## Giving agents servers: the `PASEO_MCP_SERVERS` contract

Other plugins (for example agent-roles) do not import this one. They set one variable in the agent's
environment when they create it:

```
PASEO_MCP_SERVERS=linear,sentry     # registry names, comma or space separated, case-insensitive
PASEO_MCP_SERVERS=*                 # every server registered now or later
```

- Unset or empty: the agent is left exactly as it is.
- Each name that is registered becomes an HTTP MCP server of that name in the agent's config
  (replacing a same-named entry), with the capability as its bearer. The system prompt gets a line
  listing them.
- A name that is not registered does not fail agent creation. The system prompt lists it as missing so
  the agent can tell the user to add it. If the endpoint cannot listen at all, creation fails with a message
  rather than starting an agent without the servers its role needs.
- The plugin also sets `PASEO_MCP_PROXY_URL` and `PASEO_MCP_PROXY_CAPABILITY` in the agent's environment
  (the second is how the capability is bound to the agent). Tools are not pre-approved, so the agent's
  own permission mode still applies.

## OAuth sign-in from a remote daemon

The authorization request uses `redirect_uri=http://127.0.0.1:47824/oauth/callback`, served by the
daemon. That works when the browser that opens runs on the daemon machine. When the daemon is remote
(the browser's `127.0.0.1` is another machine), the page fails to load after approval; copy its address
and paste it into Paste Address in the screen, which finishes the exchange. No Paseo change is needed;
a plugin-served HTTP route on the daemon would remove the manual step.

## Status

| PR | Scope | State |
| --- | --- | --- |
| 1 | Skeleton, CI, docs | merged |
| 2 | Registry, OAuth, proxy, agent attachment, audit, screen | in review |

## Development

```
npm ci
npm run typecheck
npm test
```

CI runs the same steps through Dagger (`dagger call all`).
