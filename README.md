# paseo-mcp-proxy

A [Paseo](https://paseo.sh) plugin that lets agents use remote MCP servers without ever holding their
credentials. The daemon keeps API keys and OAuth sign-ins, and a loopback proxy adds them to every
request. It is a generic rebuild of the mcp-proxy used in the Gas City for Linear, Slack, Sentry and
Datadog.

## Design

- Registry: named upstream MCP servers (`name`, `url`, auth). Auth is `none`, an API key sent in a
  chosen header (default `Authorization: Bearer ...`), or OAuth 2.1. Definitions come from
  [git sources](#git-sources) (read-only in the screen) and from servers added on the screen (kept in
  `servers.json`, no secrets). If a name exists in both, git wins; with several sources the earlier wins.
- Secrets: API keys, OAuth client secrets and refresh/access tokens are write-only and never in git or
  in anything returned to the screen. They live in `~/.paseo/mcp-proxy/secrets.json`, keyed by server name
  (directory 0700, files 0600). Secrets are tied to the URL they were obtained for: if git moves a name to
  another URL, the old key or grant is ignored rather than sent there.
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

## Git sources

Keep the registry in a repository and let every daemon pick it up (infrastructure as code, like the Agent
Roles plugin). Nothing is cloned until you add a source: on the screen, under **Git Sources**, set
the repository URL (anything `git clone` accepts), an optional branch or tag, an optional folder and a
sync interval (minutes, default 5). The plugin shallow-clones into `~/.paseo/mcp-proxy/git/` with the
daemon's own `git` (SSH key or credential helper; never put a token in the URL, settings are not secret)
and fetches on the interval and on **Sync Now**. A failed sync records the error and the last good copy
keeps being served. Git-managed servers show the source as `owner/repo@ref` (`host/owner/repo@ref` outside
GitHub) and are read-only: no remove, no notes editing. You still set their API key or press Sign In on the
daemon, since those never belong in git.

One file per server in the folder, named `<name>.yaml` (or `.yml`, `.json`):

```yaml
name: sentry               # must match the file name; lowercase letters, digits, dashes
displayName: Sentry          # optional label for the screen (64 characters at most); agents never see it
url: https://mcp.sentry.dev/mcp
auth: api-key              # none | api-key | oauth
header: X-Sentry-Key       # api-key only; default Authorization (sent as "Bearer <key>")
instructions: |            # optional, added to what agents see
  Use project web-app.
```

Unknown fields are rejected, so a `key:` or `token:` line makes the file invalid instead of being ignored;
an invalid file is skipped and shown on the screen with the reason, and valid files still load. `http://` URLs
are only accepted for localhost.

### Display names

The screen shows `displayName` instead of the ID, with the ID as secondary text; with none set it shows the
ID. A name can come from the definition file (`displayName:`) or from a local override set with **Rename**,
which is stored in this plugin's host settings (`displayNames`, keyed by ID). The override wins, and clearing
it falls back to the definition's name. Overrides live in settings rather than in `servers.json` because
git-defined servers are read-only and a label is a per-machine preference, not part of the definition.
Display names are labels only: the ID stays the server's name in `PASEO_MCP_SERVERS`, the proxy URL and the
agent's MCP config.

## Giving agents servers: the `PASEO_MCP_SERVERS` contract

Other plugins (for example agents-roles) do not import this one. They set one variable in the agent's
environment when they create it:

```
PASEO_MCP_SERVERS=linear,sentry     # registry names, comma or space separated, case-insensitive
PASEO_MCP_SERVERS=*                 # every server registered now or later
```

- Unset: the agent gets the servers listed in the **Attach to every new agent by default** setting
  (names or `*`; empty by default, so the agent is left exactly as it is).
- Set to an empty value or `none`: the agent gets no proxied servers, whatever the default says.
- Set to names or `*`: that list replaces the default for this agent.
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
and paste it into the field Sign In shows (a full address or just its query string); it finishes the exchange as soon as it is pasted. No Paseo change is needed;
a plugin-served HTTP route on the daemon would remove the manual step.

## Status

| PR | Scope | State |
| --- | --- | --- |
| 1 | Skeleton, CI, docs | merged |
| 2 | Registry, OAuth, proxy, agent attachment, audit, screen | merged |
| 3 | Git sources: the registry as files, secrets kept on the daemon | in review |

## Development

```
npm ci
npm run typecheck
npm test
```

CI runs the same steps through Dagger (`dagger call all`).
