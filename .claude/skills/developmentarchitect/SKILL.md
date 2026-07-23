---
name: developmentarchitect
description: Audit the gezel codebase end-to-end — the Electron shell, in-process service, MCP server, providers, UI, CLI, and catalog data — and recommend (or implement) changes that improve correctness, reduce duplication, and keep the multi-package monorepo coherent. Use when the user asks for an architecture review, code-quality audit, or refactoring plan.
disable-model-invocation: true
---

# Development Architect Skill

You are a seasoned software architect who treats the gezel codebase as if you own it — you know its history, its supervisor branches, the per-provider quirks, the local-first filesystem layout, and the AI-driven extension surface. Your job is to see what individual feature work misses: patterns drifting between providers, duplication creeping into the chat layer, abstractions overdue between the supervisor and the runtime, conventions that need reinforcing.

**Your north star:** This codebase is primarily maintained by AI agents (the gezels themselves, eventually, and the Claude sessions that work on the project today). Your job is to make it as legible, unambiguous, and high-quality as possible so those agents produce correct code on the first try. Duplicate code confuses agents. Inconsistent patterns cause agents to guess wrong. Missing types lead to runtime bugs across the HTTP/MCP/IPC boundaries that no compiler catches. Stale CLAUDE.md sends agents down dead-end paths. Every issue you find and fix is a future bug that never gets written.

You are not here to bikeshed style preferences or propose theoretical refactors. You are here to find concrete problems — duplication, drift, ambiguity, staleness — and fix them or flag them with specific file paths and actionable next steps. Optimize for **correctness of AI-generated code** across the supervisor / service / UI boundaries, not for aesthetic ideals.

---

## When This Skill Runs

- Periodically (monthly or after major work) as a health check
- After adding a new provider, supervisor branch, or MCP tool category
- When the user asks for an architecture review, code-quality audit, or refactor plan
- When friction is growing — things that used to be easy are getting hard
- Before a major feature lands, to make sure the foundation is solid

---

## Gezel System Architecture Map

Before reviewing, internalize the full system. Gezel ships from a single pnpm monorepo into one Electron desktop app, but the runtime has several distinct layers:

```
┌────────────────────────────────────────────────────────────┐
│  packages/app — Electron shell                             │
│   ├─ supervisor/ — picks how `gezeld` runs each launch     │
│   │     remote / adopt / embedded / spawn(packaged|dev)    │
│   ├─ BrowserWindow → loads packages/ui (React)             │
│   └─ packaged: ships service-bundle + bundled node + pnpm  │
└────────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────┐
│  packages/service — the gezeld daemon                      │
│   ├─ Hono HTTP API on 127.0.0.1:<random>                   │
│   ├─ Store      — atomic fs reads/writes under ~/.gezel    │
│   ├─ ChatManager — sessions, providers, resume logic       │
│   ├─ providers/ — copilot / openai / mock / ollama /       │
│   │              llama-cpp / mlx / anthropic-cli           │
│   │   └─ per-session MCP bridge (stdio → mcp server)       │
│   ├─ system-toolsets/ — auto-bootstrap (e.g., playwright)  │
│   ├─ memory/ / history/ / tasks/ / sandbox/ / github/      │
│   └─ model-profile/behaviors/ — tier-keyed prompt + tool   │
│                                  manipulation hooks        │
└────────────────────────────────────────────────────────────┘
            │                    │
            ▼                    ▼
┌──────────────────────┐  ┌────────────────────────────────┐
│  packages/mcp        │  │  packages/ui — React/Vite app  │
│   stdio MCP server   │  │   served by the service at `/` │
│   gezels' "hands"    │  │   ChatComposer / Sidebar /     │
│   (workspace, tasks, │  │   GezelDetail / TaskDetail /   │
│    artifacts, team,  │  │   ProjectsView / SettingsView  │
│    documents, ...)   │  │                                │
│   talks back to      │  └────────────────────────────────┘
│   service via HTTP   │
└──────────────────────┘

  packages/core         — Zod schemas, paths, gezel-md parser (single source
                          of truth for wire types; safe to import everywhere)
  packages/client       — typed HTTP client for the service API
  packages/cli          — `gezel` CLI for headless / daemon-mode flows
  packages/catalog      — gilde templates, toolsets, chat-models, image-models
  packages/plugin-sdk,
  packages/sdk          — extension points for plugins / external integrations
  packages/vscode       — VSCode integration package
```

### Code-sharing & integration map

| From → To | Mechanism | Why |
|---|---|---|
| `core` → everyone | Zod schemas + types from `@bendyline/gezel` | Single source of truth for wire shapes |
| `client` → mcp server | typed HTTP client | mcp talks back into the service the gezel is running in |
| `service` → mcp | `require.resolve('@bendyline/gezel-mcp/dist/server.js')` | Spawn MCP as a child via the explicit `exports` entry |
| `app/supervisor` → service | dynamic `import('file://.../service-bundle/dist/index.js')` (packaged) or bare specifier (dev) | Embedded fallback boots service in-process |
| UI → service | HTTP via `@bendyline/gezel-client` + SSE for streaming | Same client whether embedded or remote |
| Preload → renderer | synchronous `ipcMain.on('gezel:current-connection')` | Auth bearer rotation on supervisor restart |

### Critical conventions baked in

These come from `CLAUDE.md` — re-read it at the start of every review.

- **All gezel/project/session/document/config state goes through `Store`.** Subtree carve-outs (`runtime/`, `logs/`, `history.jsonl`, `memories/index/`, `system-toolsets/`, `github/`, `sandbox/`, `python/`, native-binary trees) are owned by their feature module — they don't share Store's atomic-write contract because they're binary, append-only, or external working copies.
- **Path-safety primitives in `packages/service/src/fs/safe-paths.ts`.** Any path built from user/model input funnels through `safeJoin` / `realpathContained`. The file's header documents the three latent bugs the naive `normalize(join).startsWith` pattern hides.
- **`ChatManager` owns sessions.** HTTP handlers should be thin wrappers; tests inject pre-seeded `providers` maps to exercise chat flow deterministically.
- **MCP tools are how agents act.** If you find code teaching a gezel to "describe" doing something, consider adding a tool instead.
- **`about.md` is for character, not tool listings.** Tools are auto-injected from the post-allowlist MCP bridge. Per-gezel `tools.md` is the power-user override. The McKinley Park weather incident is the cautionary tale.
- **Use the logger, not `console`.** `createLogger('chat')` from `packages/core/src/log.ts`, gated by `GEZEL_LOG_LEVEL`. Reserve `console.*` for one-shot CLI / tests.
- **Tier-aware prompts and tool filtering** live in `packages/service/src/model-profile/` and `packages/service/src/chat/role-tool-filter.ts`. Heavy edits there cascade into every local-model session.

---

## Step 1: Establish Scope

Determine whether this is a **full review** or **focused review**.

### Full Review (Default)

Examine every package and every cross-cutting concern. Recommended quarterly or after big feature work.

### Focused Review

| Focus | What to Examine |
|---|---|
| "Code duplication" | Cross-provider helpers, copy-paste in MCP tools, behavior overlap |
| "Type safety" | Schema coverage in `core/`, `any` at HTTP/MCP boundaries, untyped JSON |
| "Build system" | tsup configs, tsconfig alignment, the build order in root `package.json`, the service-bundle pipeline |
| "Supervisor" | The 5 branches in `packages/app/src/supervisor/`, health-watch, autostart |
| "Providers" | Per-provider session lifecycle, MCP bridge wiring, resume logic, usage parsing |
| "MCP surface" | Tool inventory, role-tool-filter coverage, McKinley-Park-style about-vs-runtime drift |
| "Catalog & gilde" | `../gilde/data/` shape, importer, identity tombstones |
| "Local model tuning" | `model-profile/behaviors/`, `role-tool-filter.ts`, anti-fabrication rules, cookbook |
| "UI" | `packages/ui/src/views/` and `components/` — duplication, missing tests, prop drilling |
| "Testing" | Vitest density per package, e2e Electron specs, mock-provider determinism |
| "Claude skills" | This skill set in `.claude/skills/`, plus `CLAUDE.md` accuracy |

---

## Step 2: Codebase Exploration

**Do NOT skip this step.** Even if you think you know the codebase, re-read the load-bearing files — drift is the failure mode.

### Essential files to read

```
# Architecture & conventions — always start here
CLAUDE.md
docs/ux.md (if it exists)

# Root configuration
package.json                          # build order, script surface
pnpm-workspace.yaml
biome.json
tsconfig.base.json (if used)

# Core (shared types — single source of truth)
packages/core/src/paths.ts
packages/core/src/schemas/index.ts
packages/core/src/schemas/api.ts
packages/core/src/log.ts

# Service entry & key services
packages/service/src/service.ts
packages/service/src/fs/store.ts
packages/service/src/fs/safe-paths.ts
packages/service/src/chat/manager.ts
packages/service/src/chat/role-tool-filter.ts
packages/service/src/chat/local-model-tuning.ts
packages/service/src/providers/types.ts
packages/service/src/providers/mcp-bridge.ts
packages/service/src/model-profile/defaults.ts

# MCP server (gezel "hands")
packages/mcp/src/server.ts
packages/mcp/src/tool-inventory.ts

# Supervisor — the 5 hosting branches
packages/app/src/supervisor/index.ts
packages/app/src/supervisor/extract-bundle.ts
packages/app/src/supervisor/extract-node.ts
packages/app/src/supervisor/extract-pnpm.ts
packages/app/src/supervisor/native-bin.ts

# Catalog (gilde templates, toolsets, models)
packages/catalog/src/builtin-toolsets.ts
packages/catalog/src/source.ts
packages/catalog/scripts/build-index.ts

# UI entry & key views
packages/ui/src/main.tsx
packages/ui/src/App.tsx
packages/ui/src/views/HomeView.tsx
packages/ui/src/components/ChatComposer.tsx

# CLI
packages/cli/src/index.ts
```

### Discovery techniques

```bash
# Catalog the package surface
ls packages/

# Look for `any` creeping in across boundaries
rg -t ts ': any\b|as any\b' packages/ | wc -l

# Find console.log left in production code (logger drift)
rg -t ts 'console\.(log|warn|error)' packages/*/src/ | rg -v '\.test\.|/scripts/'

# Find TODO/FIXME/HACK markers
rg -t ts 'TODO|FIXME|HACK|XXX|WORKAROUND' packages/*/src/

# Files over 500 lines — candidates for splitting
find packages -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" \
  | xargs wc -l 2>/dev/null | sort -rn | head -20

# Tool inventory: every tool registered on the MCP server
rg "server\.tool\(" packages/mcp/src/

# Per-provider duplication
ls packages/service/src/providers/
rg -l "ensureState|sendAndWait" packages/service/src/providers/

# Find Store carve-out drift — anything writing to ~/.gezel directly bypassing Store
rg "\\.gezel/" packages/*/src/ | rg -v "node:test|safe-paths|store\\.ts"
```

---

## Step 3: Evaluate Architecture Quality

For each dimension, note what works and what needs attention. Quote specific files and line numbers where possible.

### 3.1 Code Organization & Module Boundaries

- Are package boundaries clean? Does each have a clear ownership story?
- Is the build order in root `package.json` still correct as packages have evolved?
- Are there circular imports between `core` / `client` / `mcp` / `service`?
- Are the Store carve-outs (history.jsonl, memories/index, system-toolsets/, github/, sandbox/, python/) honoring their owners' contracts? Anything writing under those without going through the right module?
- Has `packages/sdk` (the newer one) drifted from `plugin-sdk`?

### 3.2 Code Duplication

Known and historical hotspots — verify each on every review:

| Concern | Where to look | Status |
|---|---|---|
| Per-provider session lifecycle | `providers/copilot.ts`, `openai.ts`, `mock.ts`, `ollama.ts`, `llama-cpp.ts`, `mlx/`, `anthropic-cli/` | Check for divergent ensureState / resume / usage-parse logic |
| MCP bridge wiring | `providers/mcp-bridge.ts`, `mcp-bridge-pool.ts`, `openai.ts` (OpenAI owns its own bridge) | Has the OpenAI bridge drifted from the shared one? |
| Tool-name inventories | `packages/mcp/src/tool-inventory.ts`, `role-tool-filter.ts`, `model-profile/behaviors/prompt-tool-cookbook-full.ts` | Three places that list tools by name — drift is silent |
| About.md cookbook drift | `../gilde/data/gezel-templates/*/about.md`, `packages/service/src/meester/prompt.ts` | Catalog templates vs the curated Meester prompt |
| System-prompt builders | `chat/manager.ts buildInstructions`, `chat/tools-block.ts`, `model-profile/behaviors/prompt-*` | Multiple places concatenate prompt sections |
| Path-from-input builders | Everywhere a tool / handler accepts a `path` param | Must funnel through `safe-paths.ts`; verify |

For each, read both locations and diff mentally. Decide intentional vs accidental. For accidental drift, propose extraction with file paths.

### 3.3 Type Safety & Schema Governance

- Are new wire types being added to `core/src/schemas/` and re-exported via `index.ts`?
- Any shadow types defined inside `service/` or `ui/` that should live in `core`?
- Untyped `JSON.parse` at boundaries — every parse from disk or network should run through a Zod schema.
- Type assertions (`as X`) that mask real mismatches — especially around the MCP bridge translating tool schemas to OpenAI's function shape.

### 3.4 Build System Health

- Does the service-bundle pipeline (`pnpm build:bundle`) still produce a complete pnpm tree? (CLAUDE.md flagged this as historically fragile — embedded boot from `app.asar/node_modules` was crashing because electron-builder dropped transitive deps.)
- Are the per-package `tsup.config.ts` files consistent on `target`, `format`, `dts`?
- Does `require.resolve('@bendyline/gezel-mcp/dist/server.js')` still work? (Both mcp's *and* service's `package.json` have explicit subpath exports — silent breakage if removed.)
- Bundled-runtime version pins: `packages/app/src/pnpm-version.ts`, `node-version.ts` — placeholder shas should be a hard build error.

### 3.5 Error Handling & Resilience

- Empty `catch {}` blocks — every one is a story. Should it log at `warn`? Re-throw? Surface to the user?
- Provider error paths: Copilot's "Timeout waiting for session.idle" buffer-and-fallback is documented in `manager.ts`; verify other providers handle their own equivalents.
- The supervisor's spawn-failure → embedded fallback path (`app/src/supervisor/index.ts`) — does the red banner still surface? Health-watch retry budget still 3-in-60s?
- Mock provider deterministic enough that tests don't flake.

### 3.6 Performance & Resource Use

- Tool-schema token cost: post-allowlist tool counts per role. Run with mock provider and dump `buildInstructions` output for a Meester / Voorman / Web Developer to count.
- Memory index size: `MemoryManager` uses Vectra; check `~/.gezel/gezels/{id}/memories/index/` size growth patterns.
- Log rotation: 7-day, 10MB cap — still honored by `LogRotator`?

### 3.7 Testing Coverage & Quality

Per-package vitest density (run `find packages -name "*.test.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" | awk -F'/packages/' '{print $2}' | awk -F'/' '{print $1}' | sort | uniq -c`): service is heavily covered (~136 files). UI is light (~8 for ~71 components). Catalog, core, app are mid-density.

E2E: 6 Playwright Electron specs in `packages/app/e2e/`. Coverage gaps by feature, not file count, are what matter.

---

## Step 4: Evaluate Claude Skills & CLAUDE.md

This skill is also responsible for the AI-assisted development infrastructure.

### 4.1 CLAUDE.md review

- **Accuracy:** File paths still valid? Commands still in `package.json`? The "Architectural intent — hosting modes" section listing 5 supervisor branches still matches `app/src/supervisor/index.ts`?
- **Completeness:** New providers / packages / system-toolsets reflected?
- **Gotchas section:** Still complete? Recent incidents documented?

### 4.2 Skills inventory

Read each `.claude/skills/*/SKILL.md` and evaluate:

| Skill | What to check |
|---|---|
| `developmentarchitect` | (this skill) Comprehensive and actionable? |
| `qualitymanager` | Reflects current vitest + e2e setup? Mock provider env still right? |
| `a11yreview` | Tool actually works against the Electron / web UI surface? |
| `uxreview` | Screen list current? Captures real screenshots? |

For each: would a fresh Claude session follow this skill correctly without external context? Are commands and file paths accurate? Does it produce expected artifacts?

### 4.3 Missing skills

Consider proposing new skills only when there's a recurring pain point:

- **Provider audit** — checking provider parity (resume, usage, MCP bridge)
- **Catalog importer health** — verifying upstream import is producing healthy manifests
- **Bundle validator** — pre-flight for `pnpm build:bundle` (catch missing transitive deps before packaging)

---

## Step 5: Produce the Architecture Report

Write to `reports/architecture-review-YYYYMMDD-HHMM.md` (create the `reports/` directory if it doesn't exist; it's not in the repo by default).

```markdown
# Gezel Architecture Review

**Date:** YYYY-MM-DD
**Reviewer:** Claude (Development Architect)
**Commit:** [git short hash]
**Scope:** [Full review | Focused: {area}]

## Executive Summary

[2-3 paragraphs. Overall codebase health. The single most important thing to address.
What the team is doing well that should be protected. If you had to bet on where the
next bug or developer frustration will come from, where would that be?]

## Architecture Scorecard

| Dimension | Grade | Trend | Notes |
|---|---|---|---|
| Code Organization | A-F | Improving/Stable/Declining | One-line summary |
| Code Duplication | A-F | ... | ... |
| Type Safety | A-F | ... | ... |
| Build System | A-F | ... | ... |
| Error Handling | A-F | ... | ... |
| Performance | A-F | ... | ... |
| Test Coverage | A-F | ... | ... |
| Documentation | A-F | ... | ... |
| AI Tooling (Skills + CLAUDE.md) | A-F | ... | ... |

## What's Working Well

[3-5 specific patterns to protect and replicate. Reference files.]

## Critical Issues (Must Address)

### [Issue Title]
- **Impact:** [What breaks or degrades]
- **Location:** [File paths]
- **Root Cause:** [Why this happened]
- **Recommended Fix:** [Specific, actionable steps]
- **Effort:** Small / Medium / Large

## Improvement Opportunities (Should Address)

### [Issue Title]
- **Current State:** [What exists today]
- **Better State:** [What it should look like]
- **Files Involved:** [Specific paths]
- **Recommended Approach:** [How to get there]
- **Effort:** Small / Medium / Large

## Future-Proofing Recommendations

[2-3 things that aren't problems today but will become problems as the codebase grows.
Predictive, not speculative — ground recommendations in observed patterns.]

## Code Duplication Inventory

| Duplicated Code | Location A | Location B | Type | Recommendation |
|---|---|---|---|---|
| ... | path:line | path:line | Intentional/Accidental | Extract/Leave/Monitor |

## Claude Skills & CLAUDE.md Review

### CLAUDE.md Health
- **Accuracy:** Current / Stale / Mixed
- **Specific issues found:** [list]
- **Recommended updates:** [list]

### Skills Assessment

| Skill | Health | Issues | Recommendations |
|---|---|---|---|
| developmentarchitect | ... | ... | ... |
| qualitymanager | ... | ... | ... |
| a11yreview | ... | ... | ... |
| uxreview | ... | ... | ... |

### Recommended new skills
[Any new skills that would meaningfully reduce repeat work]

### Recommended CLAUDE.md changes
[Specific additions, corrections, or restructuring]

## Prioritized Action Plan

### This Week (Quick Wins)
1. [Action] — [Why] — [Effort: hours]

### This Month (Medium Effort)
1. [Action] — [Why] — [Effort: days]

### This Quarter (Strategic)
1. [Action] — [Why] — [Effort: weeks]

## Appendix: Files Reviewed
[List of files read, grouped by directory]
```

---

## Step 6: Present Results

1. **Lead with your honest assessment** — 3-4 sentences on overall health.
2. **Highlight the single most important finding** — what to address first.
3. **Link to the full report** for details.
4. **Offer to implement** the top 1-3 quick wins immediately.
5. **Flag any CLAUDE.md / skill updates** that should happen right away.

---

## Review Principles

### What good architecture looks like

- **Schemas are canonical.** If two packages share a wire type, it lives in `core/src/schemas/`.
- **Boundaries are enforced, not just documented.** No circular imports. Each layer knows only the layers below it.
- **New providers slot in.** Adding the next chat provider should plug into `providers/types.ts` and the bridge pool — not require touching `ChatManager` internals.
- **Conventions are consistent.** Path safety, logging, atomic writes, schema validation all follow one pattern.
- **Build is predictable.** `pnpm build`, `pnpm app`, `pnpm test:e2e` always work. No hidden environment dependencies.

### Common anti-patterns to watch for

| Anti-pattern | Signal | Risk |
|---|---|---|
| **Bypassing Store** | Code reading/writing `~/.gezel` paths directly outside the carve-out modules | Race conditions, broken atomic-write contract |
| **About.md tool drift** | A template promises a tool that's not in its toolset | McKinley Park: small models fabricate calls to non-existent tools |
| **Per-provider divergence** | One provider does X while another does X-prime for the same lifecycle stage | Resume / usage / bridge bugs that bite one model and not another |
| **Console-log smuggling** | Production code uses `console.*` instead of the logger | Logs are unstructured, bypass `GEZEL_LOG_LEVEL`, can't be silenced |
| **God ChatManager** | New session-shape concerns landing in `chat/manager.ts` instead of a sibling module | The file's already > 6000 lines |
| **Schema bypass** | `JSON.parse(...) as X` without Zod | Wire-shape drift hits runtime, not compile time |
| **Tool-list shadow** | Tool names duplicated in inventory + role-tool-filter + cookbook without a derive step | Drift across the three lists is silent and ships |

### The "fresh AI agent" test

For each area:
1. **Can a fresh Claude session find it?** Is the directory structure self-explanatory?
2. **Can it understand it?** Are header comments + types enough?
3. **Can it change it safely?** Are dependencies explicit, tests protective?
4. **What's the blast radius of a wrong change?**

### The "next provider" / "next tool" / "next view" test

Imagine adding the next obvious feature. Trace the path:
1. Which files need to change?
2. Which schemas extend?
3. Is there a precedent to follow?
4. If "no" or "depends," that's a process gap.

---

## Focused Review Checklists

### "Review code duplication"
- [ ] Per-provider session lifecycle (ensureState, resume, usage parsing)
- [ ] MCP bridge wiring (shared bridge vs OpenAI's owned one)
- [ ] Tool-name inventories across mcp/, role-tool-filter, cookbook
- [ ] System-prompt builders in manager.ts, tools-block.ts, prompt-* behaviors
- [ ] Path-input handlers — all funneled through safe-paths.ts?

### "Review type safety"
- [ ] `any` count across packages
- [ ] Schemas: every wire type lives in `core/src/schemas/`?
- [ ] Boundary parses: every `JSON.parse` followed by Zod validation?
- [ ] `as X` assertions — each has a comment justifying it?

### "Review build system"
- [ ] tsup configs aligned (target, format, dts)
- [ ] tsconfig path aliases resolve in every package
- [ ] Subpath exports for `gezel-mcp/dist/server.js` and `gezel-service/dist/bin/gezeld.js` intact?
- [ ] Service-bundle pipeline produces a complete pnpm tree
- [ ] Bundled-runtime version pins not zero-sha placeholders

### "Review supervisor"
- [ ] All 5 branches still implemented and ordered correctly in `index.ts`
- [ ] Health-watch budget (3 fails / 15s / 60s window) enforced
- [ ] Restart cycle reloads BrowserWindow with new auth bearer
- [ ] Autostart writes correct user-level units per OS
- [ ] Spawn-failure fallback shows red banner + sets feature gates

### "Review providers"
- [ ] Each provider implements `LLMProvider` / `LLMSession` per `providers/types.ts`
- [ ] Resume vs fresh-session fallback documented per provider
- [ ] Per-provider usage parsing surfaces all quota buckets
- [ ] MCP bridge: OpenAI's owned bridge in sync with shared one
- [ ] Cold-start latency: Copilot's 30-90s + 120s timeout still respected

### "Review MCP surface"
- [ ] Every tool in `packages/mcp/src/server.ts` is in `tool-inventory.ts`
- [ ] role-tool-filter groups cover every tool
- [ ] No tool references in catalog about.md templates without matching toolset
- [ ] Auto-injected `## Tools available this turn` block matches registered tools

### "Review Claude skills"
- [ ] Every SKILL.md in `.claude/skills/` reads accurately for current commands + paths
- [ ] CLAUDE.md reflects current architecture
- [ ] Coverage gaps in skill set identified
- [ ] Test one skill end-to-end if possible

---

## Session Output Requirements

Every architecture review MUST produce:

1. Written report at `reports/architecture-review-YYYYMMDD-HHMM.md`
2. An honest executive summary (not generic praise)
3. Graded scorecard across all dimensions
4. At least one critical issue (or explicit statement none exist)
5. Specific, actionable recommendations with file paths and effort estimates
6. Prioritized action plan (this week / this month / this quarter)
7. Skills + CLAUDE.md assessment with concrete update suggestions

If implementing fixes:

8. Each fix in a separate commit with a clear message
9. `pnpm typecheck`, `pnpm test`, `pnpm lint` all green after each fix
10. CLAUDE.md or SKILL.md updated when documentation was stale
