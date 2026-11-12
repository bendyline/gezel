# @bendyline/gezel-mcp

The [Model Context Protocol](https://modelcontextprotocol.io) server that gives
[Gezel](https://github.com/bendyline/gezel) its hands.

Every tool Gezel can call lives here: memory search and save, workspace file
operations, project artifacts, the shared document library, script and
Playwright execution, task management, crew and project management, image
rendering, and history search.

Gezel runs this server for every chat. It also gives other AI apps
(Claude Code, Codex, Cursor, Claude Desktop, VS Code) a small set of Gezel's
tools; see [For other AI apps](#for-other-ai-apps).

```bash
npm install @bendyline/gezel-mcp
```

## For other AI apps

`gezel-mcp --harness <client>` (`claude-code`, `claude-desktop`, `codex`,
`cursor` or `vscode`) gives an app that already has its own file, shell and
web tools what only Gezel has: search over the folder it works in (including
the text of its Office documents), the person's shared library, memories and
knowledge catalogs, Office documents read as markdown, image description and
generation, memory, documents made and checked with the DocBlocks that Gezel
ships, and the night shift's issues for the app to judge (with the prompts
`triage_issues` and `fix_issues`). Paths are absolute throughout. The exact
set is `HARNESS_TOOL_NAMES` and `HARNESS_DOCUMENT_TOOL_NAMES` in
[harness-profile.ts](https://github.com/bendyline/gezel/blob/main/packages/core/src/tools/harness-profile.ts).

Set it up from Gezel (Settings → Integrations, or `gezel mcp install <app>`),
which writes the app's entry for you. By hand, run the server under Node 24 or
later from the folder you work in:

```json
{
  "mcpServers": {
    "gezel": {
      "command": "npx",
      "args": ["-y", "@bendyline/gezel-mcp", "--harness", "claude-code"]
    }
  }
}
```

The server binds the Gezel project for the folder the app reports (MCP roots),
or `--folder <path>`, or its working directory; `--project <id>` names one
outright. It reads the owner credential from `~/.gezel/runtime/` once and
trades it for a token confined to that project and to the choices the person
made in Gezel, so the app's model never acts with the person's full access. If
Gezel is not running, every tool says so instead of the server exiting.

## The full surface, with your own access

Without `--harness` the server offers every tool Gezel has, acting with your
own access, as the `gezel` command does. It speaks stdio, so any MCP client can
run it. With Gezel running on the same computer:

```json
{
  "mcpServers": {
    "gezel": {
      "command": "npx",
      "args": ["-y", "@bendyline/gezel-mcp"],
      "env": {
        "GEZEL_AGENT_ID": "<an id from `gezel agent list`>",
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
| `GEZEL_AGENT_ID` | The crew member the tools work as: whose memories they search and save, whose tasks they see. |
| `GEZEL_PROJECT_ID` | The project tools use when a call names none. Default `default`. |
| `GEZEL_HOME` | A Gezel home other than `~/.gezel`. |

Run this way, the server acts with your own access, as the `gezel` command
does; `GEZEL_PROJECT_ID` picks a default, not a boundary.

`gezel agent list` (from `@bendyline/gezel-cli`) lists your crew and their
ids. The `agent` in that command and in `GEZEL_AGENT_ID` is a historical name:
both refer to your crew members.

When Gezel starts the server itself, for a chat, it passes the
connection directly: `GEZEL_BASE_URL`, `GEZEL_TOKEN` (a token it mints for that
one session, confined to its project unless the session coordinates across
projects), and `GEZEL_CERT_PATH` (the
`runtime/cert.pem` that token's service is using). Setting `GEZEL_BASE_URL`
yourself turns the lookup off, and keeping all three current across restarts
is then up to you.

## Tool categories

Memory · workspace files · project artifacts · shared documents · script and
Playwright execution · package installation · crew and project management ·
tasks · user questions · history search · image rendering.

Run the server and call `tools/list` for the authoritative, current inventory.

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-mcp` | Server construction helpers |
| `@bendyline/gezel-mcp/lint-contracts` | The exact input and output schemas the built-in tools publish, for checking tool contracts |
| `@bendyline/gezel-mcp/dist/server.js` | The stdio server itself, also installed as the `gezel-mcp` command. The Gezel service launches this file for every chat, so it stays a supported path |

## Stability

Public API under semver. Tool names and argument schemas are part of that
contract: removing a tool or narrowing an argument is a breaking change.

MIT © Bendyline
