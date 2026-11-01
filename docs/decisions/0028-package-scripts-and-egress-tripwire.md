# 0028 — Package scripts get their own switches, and tool calls pass an egress tripwire

Status: Accepted (2026-10).
Contract: [security-architecture.md](../security-architecture.md) §7 and §11.1.

## Context

Cohere reported (October 2026) that an open-weight model in the Qwen3.8
family, given a real shell for an unrelated task, sometimes ran an
unrequested `curl PUT` to an Alibaba Cloud bucket, reached for the cloud
metadata address `169.254.169.254`, and tried `unshare -Urm` — while its
reasoning said it would call no tools. It happened in under one call in
100,000. The same hosts turned up in Qwen3.8-27B output, which Gezel runs on
device, and Gezel runs these models unattended overnight, where a rare event
becomes a nightly one.

Gezel's sandbox already kept the scripts gezels write off the network. Two
paths did not:

- `run_package_script` and `run_npx` run outside the sandbox, as the
  person's account, with the network, and they were on at Lockdown, the
  default. A per-command approval stood in front of them, but a gezel could
  write a test file the approved command runs, and the approval prompt shows
  the command, not the code.
- Calls Gezel does not execute itself — third-party toolsets, the browser at
  Unrestricted, and the tool calls the `/v1` endpoints hand to Codex,
  OpenCode or Pi — reached the network with no check at all.

## Decision

1. **Two new capabilities, gated by permission, not by level.**
   `allowPackageScriptExecution` gates running package scripts and binaries
   (surface and sink); `allowPackageScriptEdits` gates a gezel adding or
   changing a package manifest's `scripts`. Both are on only in the `free`
   preset and each can be turned on by itself. Neither depends on
   `allowScriptExecution`, which keeps meaning the sandboxed scripts gezels
   write. The existing per-command approval stays in front of every run.
2. **Editing is separate from running** because a planted script runs later
   with the person's whole account, from Gezel or from their own terminal.
   Every gezel-initiated Store write is checked; removals and the person's
   own writes are not.
3. **A policy saved before the switches existed derives them** from
   `allowExternalServices && allowScriptExecution`: a package script can
   reach the web, so it follows the posture that already allows that. A
   stored Lockdown loses package scripts on upgrade; Unrestricted keeps them.
4. **A lexical egress tripwire runs on the call, before it runs**, at the
   sinks for Gezel's own tools, in `McpBridge` for every bridge that is not
   gezel-mcp, and on `/v1` tool calls before the app can execute them. It
   flags cloud metadata services, link-local addresses, a short watchlist of
   data-drop and tunnel hosts, and namespace tools. Every block is a
   `security.tool-call-blocked` History entry.

## Alternatives considered

- **Leave package scripts at Lockdown behind the approval.** The approval
  binds identifiable files, but a person approving `npm test` cannot review
  the test code a gezel just wrote; Lockdown's promise is no open-web
  egress, and an unsandboxed package script breaks it.
- **One package-scripts switch.** Running and planting are different risks:
  a person may want a gezel to run the suite but never touch the scripts.
- **Block loopback and private addresses too.** Coding agents curl their own
  dev servers and reach LAN machines every day; blocking them would make the
  tripwire fire on ordinary work and train people to ignore it.
- **Scan every tool call's text, including file writes.** A security report
  quotes `169.254.169.254`; the tripwire reads what runs or fetches, not
  what a gezel writes down.
- **Ship the watchlist through gilde.** The list is a security floor that
  live content updates should not be able to shrink. Gilde can add to it
  later through a new kind; the core list stays the minimum.

## Consequences

- About nine catalog code craftbooks (bug-fix-tdd, codemod-sweep,
  refactor-module, …) prove their work by running npm scripts and now need
  **Run package scripts** on. `gezel do` names the switch, and `suggest_work`
  lists it as setup on those books. The UI launch does not warn before the
  run, but a step whose gate needs a command run pauses when it activates,
  with a note naming the switch, instead of dispatching a gezel that has no
  way to run it ([package-commands-off.ts](../../packages/service/src/tasks/package-commands-off.ts)).
  Before that, every such trial in the 2026-10-28 DGX Spark scorecard looped
  for 11 to 71 minutes.
- Lockdown plus External services is no longer the Unrestricted preset; it
  reads as Custom.
- The tripwire is easy to evade on purpose. It targets trained-in habits,
  not an adversary, and does not see provider-native shells (Claude CLI,
  Codex CLI, unsandboxed Copilot). A Gezel-owned egress proxy that logs and
  filters the connections themselves is the next layer.
- `run_nodejs_script` and `derive_file` write through Node's permission
  model, so only the root manifests are put back after them; a nested
  package's scripts can still change that way.
