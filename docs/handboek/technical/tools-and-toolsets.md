---
id: tools-and-toolsets
title: Tools and toolsets
order: 4
summary: Every built-in tool group and what it lets a gezel do.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# Tools and toolsets

Tools are a gezel's hands: without them, an AI model can only talk. Gezel's
tools are bundled into named **groups**, and each role carries the groups that
fit its trade — a reviewer gets file reading, a developer gets file writing and
code execution, a coordinator gets team management. You can add or remove groups
per gezel, and third-party toolsets from the gilde catalog extend the set
further.

The public [Gezel Gilde toolset catalog](https://gezelgilde.com/toolsets/) collects first-party toolsets, connector types, and ready-made project types in one place.

Calls through Gezel's built-in tool groups are mediated by its policy, consent,
and audit layers. Provider-native tools, approved package commands, and
third-party MCP servers have different boundaries; the
[security model](security-model.md) explains those exceptions.

## Custom MCP toolsets

In any Toolsets panel, choose **Add toolset → Custom MCP** to import a local
JSON file or paste its contents. Gezel understands both common configuration
envelopes:

- VS Code workspace format: a top-level `servers` object.
- Claude/Cursor format: a top-level `mcpServers` object.

Both local `stdio` servers and remote Streamable HTTP/SSE servers are supported.
Imported environment values and HTTP headers go into Gezel's secret store rather
than the ordinary installed-toolsets JSON. Provider-native MCP integrations that
only accept local processes (currently Copilot and Claude CLI) load the `stdio`
entries and skip hosted entries.

For third-party options, the [Gilde community directory](https://gezelgilde.com/community/) is searchable by category. Review a community server before adding it to a crew; these entries are outside Gezel's first-party toolsets.

A project can also declare its approved MCP toolsets as files in its working
folder. Gezel discovers `.gezel/mcp.json`, `.vscode/mcp.json`, and the common
root `.mcp.json` automatically. When names overlap, the Gezel-specific file
wins, then VS Code, then the root file. Changing one of these files rebuilds
that project's MCP bridges, so the new set applies on the next turn.

Project-file discovery is project consent, not a way around the install-wide
security posture: unconfined third-party MCP servers remain available only when
non-builtin toolsets are enabled by **Settings → Security & Compliance**. VS
Code `${input:…}` prompt variables are not imported because they need an
interactive value; use an environment variable or literal value instead.

## The built-in groups

::handboek-toolset-groups
