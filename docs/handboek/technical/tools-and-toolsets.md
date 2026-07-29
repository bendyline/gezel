---
id: tools-and-toolsets
title: Tools and toolsets
order: 4
summary: Every built-in tool group and what it lets a gezel do.
---

# Tools and toolsets

Tools are a gezel's hands: without them, an AI model can only talk. Gezel's tools are bundled into named **groups**, and each role carries the groups that fit its trade — a reviewer gets file reading, a developer gets file writing and code execution, a coordinator gets team management. You can add or remove groups per gezel, and third-party toolsets from the gilde catalog extend the set further.

Every tool call is mediated: consent rules and the audit log apply no matter which group a tool came from.

## Custom MCP toolsets

In any Toolsets panel, choose **Add toolset → Custom MCP** to import a local
JSON file or paste its contents. Gezel understands both common configuration
envelopes:

- VS Code workspace format: a top-level `servers` object.
- Claude/Cursor format: a top-level `mcpServers` object.

Both local `stdio` servers and remote Streamable HTTP/SSE servers are
supported. Imported environment values and HTTP headers go into Gezel's
secret store rather than the ordinary installed-toolsets JSON.
Provider-native MCP integrations that only accept local processes (currently
Copilot and Claude CLI) load the `stdio` entries and skip hosted entries.

A project can also declare its approved MCP toolsets as files in its working
folder. Gezel discovers `.gezel/mcp.json`, `.vscode/mcp.json`, and the common
root `.mcp.json` automatically. When names overlap, the Gezel-specific file
wins, then VS Code, then the root file. Changing one of these files rebuilds
that project's MCP bridges, so the new set applies on the next turn.

Project-file discovery is project consent, not a way around the install-wide
security posture: unconfined third-party MCP servers remain available only
when non-builtin toolsets are enabled by **Settings → Security & Compliance**.
VS Code `${input:…}` prompt variables are not imported because they need an
interactive value; use an environment variable or literal value instead.

## The built-in groups

::handboek-toolset-groups
