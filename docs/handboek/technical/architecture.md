---
id: architecture
title: "How gezel runs: app, daemon, and tools"
order: 1
summary: The desktop app, the background service, and how a gezel acts.
---
# How gezel runs

Gezel is two cooperating pieces:

- **The app** — the window you see. It draws the workshop and talks to the
  service over a private, authenticated local connection.
- **The service (**`gezeld`**)** — a background process on your machine that
  owns everything real: your files, your sessions, the connections to AI
  providers. It keeps working when the window is closed, which is what makes
  scheduled jobs and long-running tasks possible.

The app finds or starts the service automatically. On a standard install the
service runs machine-wide; there is also a per-user mode, and Settings lets you
enable start-at-login so your crew is always on duty.

## How a gezel acts

A language model on its own can only produce text. A gezel gets **tools** —
reading and writing workspace files, saving memories, running scripts, creating
tasks, messaging other gezellen. Tools are how a gezel's words become work, and
every tool call is subject to the same consent and audit rules regardless of
which AI provider is behind the gezel.

The [Tools and toolsets](tools-and-toolsets.md) article lists every group; each
role article shows exactly which groups that role carries.

## Providers

The service speaks to AI providers through one pluggable layer: GitHub Copilot,
OpenAI, Anthropic, and local engines all plug into the same seam. That's why
switching providers — or giving one gezel a different model than the rest of the
crew — is a setting, not a migration.
