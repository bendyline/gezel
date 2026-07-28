# @bendyline/gezel-mcp

The [Model Context Protocol](https://modelcontextprotocol.io) server that gives
[gezel](https://github.com/bendyline/gezel) agents their hands.

Every tool a gezel can call lives here: memory search and save, workspace file
operations, project artifacts, the shared document library, script and
Playwright execution, task management, team and project management, image
rendering, and history search.

```bash
npm install @bendyline/gezel-mcp
```

It speaks stdio, so any MCP client can run it:

```json
{
  "mcpServers": {
    "gezel": {
      "command": "npx",
      "args": ["-y", "@bendyline/gezel-mcp"],
      "env": {
        "GEZEL_BASE_URL": "https://127.0.0.1:8080",
        "GEZEL_TOKEN": "…",
        "GEZEL_AGENT_ID": "…",
        "GEZEL_PROJECT_ID": "default"
      }
    }
  }
}
```

The server is a thin front end: it calls back into a running `gezeld` over
HTTP using the environment variables above. It runs as a child process with a
fresh Node environment, so those variables are its only connection to the
service — nothing else is inherited implicitly.

## Tool categories

Memory · workspace files · project artifacts · shared documents · script and
Playwright execution · package installation · team and project management ·
tasks · user questions · history search · image rendering.

Run the server and call `tools/list` for the authoritative, current inventory.

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-mcp` | Server construction helpers |
| `@bendyline/gezel-mcp/lint-contracts` | Tool-contract linting used by the eval harness |
| `@bendyline/gezel-mcp/dist/server.js` | The stdio entry point. Resolved by string from `packages/service/src/chat/manager.ts` — removing this export makes chat sessions silently run with no tools |

## Stability

Public API under semver. Tool names and argument schemas are part of that
contract: removing a tool or narrowing an argument is a breaking change.

MIT © Bendyline
