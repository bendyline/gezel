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

It speaks stdio, so any MCP client can run it. With Gezel running on the same
computer:

```json
{
  "mcpServers": {
    "gezel": {
      "command": "npx",
      "args": ["-y", "@bendyline/gezel-mcp"],
      "env": {
        "GEZEL_AGENT_ID": "<a gezel id from `gezel agent list`>",
        "GEZEL_PROJECT_ID": "default"
      }
    }
  }
}
```

There is no address, password, or certificate to configure. The server is a
thin front end that calls back into the running Gezel service, and finds it on
its own: Gezel picks its port, its sign-in token, and its TLS certificate at
each launch and writes them to `~/.gezel/runtime/` (`port`, `auth-token`,
`cert.pem`), readable only by you. The server reads them when it starts and
follows Gezel across a restart, so a long-lived MCP client keeps working after
Gezel updates. If Gezel is not running when the client starts the server, it
exits with a message saying to open the Gezel app or run `gezel start`; start
it, then reconnect the server from your MCP client.

| Variable | |
|---|---|
| `GEZEL_AGENT_ID` | The gezel the tools work as: whose memories they search and save, whose tasks they see. |
| `GEZEL_PROJECT_ID` | The project tools use when a call names none. Default `default`. |
| `GEZEL_HOME` | A Gezel home other than `~/.gezel`. |

Run this way, the server acts with your own access, as the `gezel` command
does; `GEZEL_PROJECT_ID` picks a default, not a boundary.

When Gezel starts the server itself, for a gezel's chat, it passes the
connection directly: `GEZEL_BASE_URL`, `GEZEL_TOKEN` (a token it mints for that
one session, confined to its project unless the gezel coordinates across
projects), and `GEZEL_CERT_PATH` (the
`runtime/cert.pem` that token's service is using). Setting `GEZEL_BASE_URL`
yourself turns the lookup off, and keeping all three current across restarts
is then up to you.

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
