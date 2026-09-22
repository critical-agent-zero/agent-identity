# @critical-labs/agent-identity-mcp

Single-bin wrapper around [`@critical-labs/agent-identity`](https://www.npmjs.com/package/@critical-labs/agent-identity) so MCP configs can start the server unambiguously:

```json
{ "command": "npx", "args": ["-y", "@critical-labs/agent-identity-mcp"] }
```

The bare npm name `agent-identity-mcp` belongs to an unrelated third-party package, and the main package ships more than one bin (so `npx` would need a `-p` flag to pick the right one). This package has exactly one bin and lives in our scope, so `npx -y @critical-labs/agent-identity-mcp` always resolves to the right server.

The real documentation lives in the main package: https://github.com/critical-labs/agent-identity
