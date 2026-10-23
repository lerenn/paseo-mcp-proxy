# paseo-mcp-proxy

A [Paseo](https://paseo.sh) plugin that lets agents use remote MCP servers without ever holding their
credentials: the daemon keeps API keys and OAuth sign-ins and a loopback proxy adds them to requests.

Work in progress; see the pull requests.

## Development

```
npm ci
npm run typecheck
npm test
```
