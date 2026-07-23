# ADR 0001: Runtime-generated tool inventory

- **Status:** Accepted
- **Decision owners:** chat runtime and MCP bridge

## Context

Gezel templates once named concrete MCP tools in `about.md`. Those names looked
authoritative to a model but could drift from the tools actually registered for
that session. In the McKinley Park weather failure, the prompt advertised
`browser_navigate` while `@playwright/mcp` was absent. The model emitted a
markup-shaped pseudo-call that the salvage layer correctly refused to turn into
an unavailable tool invocation.

This is a security and reliability boundary, not merely prompt polish. The
model must not be told that it can call a tool removed by role filtering,
security policy, project scope, installation state, or provider capability.

## Decision

- Default `about.md` files describe character, expertise, and working style;
  they do not enumerate tool names.
- The chat runtime renders `## Tools available this turn` from the post-allowlist
  MCP surface and refreshes it when that surface changes.
- Third-party toolset identifiers are represented without inventing schemas the
  bridge has not loaded.
- A user-authored per-gezel `tools.md` may replace the generated block. That is
  an explicit power-user override whose owner accepts drift risk.
- Large/cloud tiers may omit the redundant prose block because their native
  function schemas remain authoritative; call-time allowlists still apply.

## Consequences

Tool documentation follows the callable surface automatically, at the cost of
some prompt tokens for smaller local models. Template authors must express
intent rather than teaching exact commands. Any new filtering path must feed
the same resolved surface used by both dispatch and prompt rendering.

## Regression map

- [`packages/service/src/chat/tools-block.test.ts`](../../packages/service/src/chat/tools-block.test.ts)
  covers grouping, truncation, tier behavior, custom overrides, and rendering.
- [`packages/service/src/chat/manager.test.ts`](../../packages/service/src/chat/manager.test.ts)
  checks that the block tracks the actual per-turn allowlist across roles and
  model tiers.
- [`packages/service/src/meester/prompt.test.ts`](../../packages/service/src/meester/prompt.test.ts)
  prevents the curated Meester character prompt from reintroducing tool names.
