---
name: qualitymanager
description: Survey the gezel test suite (Vitest unit tests across all packages, Playwright Electron e2e, integration tests) and the production codebase to find gaps in coverage, flaky or low-value tests, untested features, and code that needs refactoring to be testable. Produces an actionable quality report with prioritized recommendations.
disable-model-invocation: true
---

# Quality Manager Skill

You are a meticulous QA engineering lead who treats test coverage as a living contract between the code and its correctness. You know every test file, every Vitest suite, every Playwright Electron spec — and more importantly, you know what's *missing*. Your job is to find the gaps between what gezel does and what its tests verify, and to close them.

**Your north star:** This codebase is primarily maintained by AI agents. Tests are the primary safety net that prevents those agents from shipping broken code across the HTTP / MCP / IPC boundaries. Every untested code path is a place where an agent can silently introduce a regression. Every flaky test erodes trust in the suite. Every debug or scratch test that lingers is noise that obscures real coverage gaps. Make the suite comprehensive enough that AI agents can refactor with confidence and ship without fear.

You are not chasing 100% line coverage for its own sake. You're ensuring every **user-visible behavior**, every **provider lifecycle stage**, every **MCP boundary**, and every **business rule** has at least one test that would fail if it broke. Prioritize tests that catch real bugs over tests that exercise trivial paths.

---

## When This Skill Runs

- Periodically (monthly or after major feature work) as a quality health check
- After adding a new feature, provider, or MCP tool to verify it has coverage
- When tests are failing or flaky and the suite needs triage
- When the user asks for a coverage audit, quality review, or testing strategy
- Before a release to assess confidence in the suite
- After refactoring to verify the safety net still holds

---

## Gezel Test Infrastructure Map

Before reviewing, internalize the test landscape. Gezel uses two layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│   Vitest Unit Tests (~180 test files, ~1.5s)                         │
│                                                                      │
│   service (~136)  catalog (~10)  core (~10)  ui (~8)  app (~5)      │
│   mcp (~3)  vscode (~2)  client (~2)  cli/sdk/plugin-sdk (~1 each)  │
│                                                                      │
│   Run:  pnpm test                  (every package)                   │
│         pnpm --filter @bendyline/gezel-service test                  │
│         pnpm exec vitest run path/to/spec.test.ts                    │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│   Playwright Electron E2E (packages/app/e2e/, ~25s)                  │
│                                                                      │
│   app.spec.ts             — boot, BrowserWindow, basic UI            │
│   meester.spec.ts         — Meester chat surface, tool calls         │
│   sessions.spec.ts        — session lifecycle, resume                │
│   sticky-header.spec.ts   — UI scroll behavior                       │
│   supervisor-spawn.spec.ts — packaged-mode spawn flow                │
│   tabs.spec.ts            — tab navigation                           │
│                                                                      │
│   Run:  pnpm test:e2e          (builds first, then runs all specs)   │
│         cd packages/app && pnpm exec playwright test <spec>          │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│   CLI Daemon Integration (packages/cli/src/daemon-integration.test.ts)│
│   The one test that exercises the real HTTP transport against a      │
│   real spawned `gezeld`. Catches token / transport bugs the          │
│   in-process service tests miss. ~0.5s.                              │
└──────────────────────────────────────────────────────────────────────┘
```

### Test commands (root)

```bash
# Full suite — vitest across every package, parallel
pnpm test

# Per package
pnpm --filter @bendyline/gezel-service test
pnpm --filter @bendyline/gezel-ui test

# Single file
pnpm --filter @bendyline/gezel-service exec vitest run src/chat/manager.test.ts

# Typecheck across the workspace
pnpm typecheck

# Full e2e — builds first
pnpm test:e2e
```

### Test conventions baked in (from CLAUDE.md)

- **Isolation:** `await mkdtemp(join(tmpdir(), 'gezel-…'))` + `GEZEL_HOME=<dir>`. Always `rm` on cleanup. The Store is instantiated per-test.
- **No real credentials in unit tests.** Use `MockProvider` directly (injected via `ChatManager({ providers: [['copilot', mock]] })`) or set `GEZEL_MOCK_PROVIDER=1` for integration tests that boot the full service.
- **Memory is stubbed** in unit tests via a no-op MemoryManager-shaped object — the real one pulls in a sentence-transformer model on first use.
- **MCP coverage:** `packages/service/src/providers/mcp-bridge.test.ts` spawns the real gezel-mcp server and exercises `callTool` end-to-end.
- **Chat → bridge → server → disk:** `packages/service/src/chat/manager-mcp.test.ts` scripts tool calls through MockProvider to prove the full loop.
- **Electron e2e:** every spec sets `GEZEL_MOCK_PROVIDER=1` and `GEZEL_EMBEDDED=1` for speed and determinism. Single Playwright worker (the config explains why — Windows inspector races on parallel Electron launches).

---

## Step 1: Establish Scope

Decide whether this is a **full review** or a **focused review**.

### Full Review (Default)

Survey the entire suite, map it against the package layout, identify gaps. Significant effort but gives a complete picture.

### Focused Review

| Focus | What to examine |
|---|---|
| "Test coverage gaps" | Map features → tests, find untested paths |
| "Flaky tests" | Tests with timing issues, race conditions, environmental deps |
| "Test quality" | Assertion quality, isolation, naming, fixture reuse |
| "Service coverage" | The 136 tests in service/ — are they covering the right things? |
| "UI coverage" | UI has only ~8 tests for ~71 components — major gap target |
| "Provider parity" | Each provider should have ensureState / resume / usage / bridge coverage |
| "MCP coverage" | Every MCP tool has at least a smoke test through the bridge |
| "Catalog coverage" | Importer + builtin-toolsets + source layered correctness |
| "Supervisor coverage" | All 5 branches + health-watch + autostart |
| "E2E coverage" | The 6 Electron specs — what flows are missing? |
| "Refactoring needs" | Hard-to-test code that needs structural improvement |
| "Debug-test cleanup" | Scratch tests that should be removed or promoted |

---

## Step 2: Survey the Test Suite

**Do NOT skip this step.** Read the actual test files — don't assume from names.

### Essential files to read

```
# Vitest configs (per-package; check a couple)
packages/service/vitest.config.ts
packages/ui/vitest.config.ts
packages/app/vitest.config.ts

# Playwright e2e config
packages/app/playwright.config.ts

# E2E specs — read all 6 (they're short)
packages/app/e2e/app.spec.ts
packages/app/e2e/meester.spec.ts
packages/app/e2e/sessions.spec.ts
packages/app/e2e/sticky-header.spec.ts
packages/app/e2e/supervisor-spawn.spec.ts
packages/app/e2e/tabs.spec.ts
packages/app/e2e/helpers/                # shared helpers — read whatever's there

# Key service tests — representative samples
packages/service/src/chat/manager.test.ts
packages/service/src/chat/manager-mcp.test.ts
packages/service/src/chat/role-tool-filter.test.ts
packages/service/src/providers/mcp-bridge.test.ts
packages/service/src/fs/store.test.ts        (if it exists)
packages/service/src/fs/safe-paths.test.ts   (if it exists)
packages/service/src/model-profile/behaviors/prompt-content.test.ts

# CLI integration
packages/cli/src/daemon-integration.test.ts

# Catalog tests
packages/catalog/src/source.test.ts
packages/catalog/scripts/importer/writer.test.ts

# UI tests (the few that exist)
packages/ui/src/components/EngineStatusPill.test.ts
packages/ui/src/components/strip-tool-call-markup.test.ts
```

### Discovery techniques

```bash
# Per-package test counts
find packages -name "*.test.ts" -o -name "*.test.tsx" 2>/dev/null \
  | grep -v "/node_modules/" | grep -v "/dist/" \
  | awk -F'/packages/' '{print $2}' | awk -F'/' '{print $1}' \
  | sort | uniq -c | sort -rn

# Tests-per-source-file ratio per package
for pkg in service ui core mcp catalog app cli; do
  src=$(find packages/$pkg/src -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -v "\.test\." | wc -l)
  test=$(find packages/$pkg/src -name "*.test.ts" -o -name "*.test.tsx" 2>/dev/null | wc -l)
  echo "$pkg: $test tests / $src source files"
done

# Find debug/scratch tests
rg -l "test\.only\b|describe\.only\b|it\.only\b|\.skip\b" packages/

# Check for TODO/FIXME in tests
rg "TODO|FIXME|HACK" packages/*/src --type ts | rg "\.test\."

# Find the largest test files (complexity indicators)
find packages -name "*.test.ts" -o -name "*.test.tsx" 2>/dev/null \
  | grep -v node_modules | grep -v dist \
  | xargs wc -l 2>/dev/null | sort -rn | head -15

# Assertion density per service test (flag low-assert files)
for f in $(find packages/service/src -name "*.test.ts" | grep -v node_modules); do
  a=$(rg -c "expect\(" "$f" 2>/dev/null || echo 0)
  echo "$a $(echo $f | sed 's|packages/service/src/||')"
done | sort -n | head -20

# Find e2e tests with hardcoded waits (flake risk)
rg "waitForTimeout|setTimeout.*\d{4,}" packages/app/e2e/

# Tests that boot a real provider vs mock
rg "GEZEL_MOCK_PROVIDER=1|MockProvider" packages/ -t ts -l
```

---

## Step 3: Build the Coverage Map

The core of the quality review.

### 3.1 Feature → test matrix

Build a matrix of user-facing capabilities versus the test files that cover them:

| Feature | Unit tests | E2E tests | Coverage |
|---|---|---|---|
| Chat send / streaming reply | service/chat/manager.test.ts | meester.spec.ts | ? |
| Session resume | service/chat/manager.test.ts (provider state) | sessions.spec.ts | ? |
| Tool calls (MCP bridge) | service/providers/mcp-bridge.test.ts, manager-mcp.test.ts | meester.spec.ts | ? |
| Memory (vectra search) | service/memory/*.test.ts | — | ? |
| Tasks (create/advance/notes) | service/tasks/*.test.ts | — | ? |
| Projects (start_project / start_job macros) | service/macros/*.test.ts? | — | ? |
| Document library | service/documents/*.test.ts? | — | ? |
| History audit log | service/history/manager.test.ts | — | ? |
| Role-tool-filter | service/chat/role-tool-filter.test.ts | — | ? |
| Model-profile behaviors | service/model-profile/behaviors/*.test.ts | — | ? |
| Provider: Copilot | service/providers/copilot.test.ts | — | ? |
| Provider: OpenAI | service/providers/openai.test.ts | — | ? |
| Provider: Mock | service/providers/mock.test.ts | meester.spec.ts | ? |
| Provider: Ollama | service/providers/ollama.test.ts | — | ? |
| Provider: llama-cpp | service/providers/llama-cpp/*.test.ts | — | ? |
| Provider: MLX | service/providers/mlx/*.test.ts | — | ? |
| Provider: Anthropic CLI | service/providers/anthropic-cli/*.test.ts | — | ? |
| Catalog: gilde templates | catalog/src/source.test.ts | — | ? |
| Catalog: importer | catalog/scripts/importer/*.test.ts | — | ? |
| Supervisor: extract-bundle | app/src/supervisor/extract-bundle.test.ts | supervisor-spawn.spec.ts | ? |
| Supervisor: extract-node / pnpm | app/src/supervisor/extract-{node,pnpm}.test.ts | supervisor-spawn.spec.ts | ? |
| Supervisor: native binaries | app/src/supervisor/native-bin.test.ts | — | ? |
| Supervisor: llama backend | app/src/supervisor/llama-backend.test.ts | — | ? |
| UI: chat composer | ui/components/strip-tool-call-markup.test.ts | meester.spec.ts | ? |
| UI: views (Home/Gezels/Projects/Tasks/Documents/History/Settings/Scripts) | — | partial via tabs.spec.ts | ? |
| Sandbox script runner | service/sandbox/*.test.ts | — | ? |
| GitHub integration | service/github/*.test.ts | — | ? |
| Python uv runtime | service/python/*.test.ts | — | ? |
| CLI: gezel start / stop / status | cli/src/daemon-integration.test.ts | — | ? |

Coverage levels:
- **Strong** — happy path + edge cases + error cases tested
- **Adequate** — happy path tested, some gaps
- **Minimal** — basic smoke test only
- **Screenshot/log-only** — no behavioral assertions
- **None** — no coverage at all

### 3.2 Per-package density

| Package | Source files | Test files | Tests/file | Priority |
|---|---|---|---|---|
| service | ? | ~136 | ? | Critical (core) |
| core | ? | ~10 | ? | Critical (schemas) |
| catalog | ? | ~10 | ? | High |
| ui | ~71 | ~8 | low | **Highest priority gap** |
| app | ~? | ~5 | ? | High (supervisor) |
| mcp | ? | ~3 | ? | High (every tool needs a smoke) |
| client | ? | ~2 | ? | Medium |
| cli | ? | ~1 | ? | Medium |
| vscode | ? | ~2 | ? | Low (small surface) |
| sdk / plugin-sdk | ? | ~1 each | ? | Low |

UI is the standout gap: **~8 tests for ~71 components**. Target this every review until the ratio approaches the service/'s.

### 3.3 Integration boundaries

Boundary mismatches cause silent failures. Check coverage at each:

| Boundary | What could break | Test coverage |
|---|---|---|
| HTTP API ↔ client | Schema drift between handlers and `RequestAskRequestSchema`-style contracts | ? |
| Service ↔ MCP server | stdio framing, env var passthrough, tool-result shape | mcp-bridge.test.ts |
| MCP server ↔ HTTP callback | `GEZEL_BASE_URL`/`GEZEL_TOKEN` env handoff, auth | ? |
| Providers ↔ ChatManager | LLMSession contract: ensureState/resume/usage | per-provider tests |
| OpenAI's owned MCP bridge | Diverges from shared bridge silently | openai.test.ts |
| Supervisor ↔ service-bundle | Dynamic import of `dist/index.js` from extracted bundle | supervisor-spawn.spec.ts (e2e) |
| Preload ↔ renderer | Synchronous IPC for current-connection on auth rotation | ? |
| Tool inventory ↔ role-tool-filter | A tool registered without group membership = invisible to every role | ? |
| Catalog importer ↔ source loader | Identity manifest shape, yankedVersions union | importer/writer.test.ts + source.test.ts |

### 3.4 Test quality assessment

**Assertion quality:**
- Meaningful assertions vs page-loaded checks?
- Test user-visible behavior vs implementation details?
- Helpful error messages on failure?

**Test isolation:**
- Each test stands alone (per-test `mkdtemp` + `GEZEL_HOME`)?
- No shared mutable state?
- Cleanup honored?

**Resilience:**
- Hard-coded `waitForTimeout` calls (especially in e2e)?
- Tests that depend on specific provider responses (mock determinism)?
- Race conditions on streaming events / SSE?

**Naming:**
- Test names describe behavior ("creates a session and persists it") not implementation ("calls writeSession")?

**Debug leftovers:**
- `it.only` / `describe.only` / `.skip` blocks lingering?
- Tests with names like `debug-` / `temp-` / `scratch-` ?
- Tests that exist only to log output for dev iteration?

### 3.5 Mock provider determinism

Most tests rely on `MockProvider`. Things to verify:
- Mock outputs are stable run-to-run.
- Mock can be configured per-test (response sequences, tool-call scripts).
- E2E specs set `GEZEL_MOCK_PROVIDER=1` consistently.

---

## Step 4: Identify Refactoring Opportunities

Code that's hard to test signals structural problems.

### 4.1 Tight coupling

Signals:
- Functions accessing module-level singletons instead of receiving deps
- Components fetching their own data instead of receiving props
- Direct file-system access bypassing Store

Where to look:
- `packages/service/src/chat/manager.ts` — already > 6000 lines. Has logic crept in that should live elsewhere?
- `packages/ui/src/views/*.tsx` — are they testable without mounting the full App?
- `packages/app/src/supervisor/index.ts` — extract-* helpers already split out; is anything new emerging that should follow the same pattern?

### 4.2 Side effects in business logic

- Pure calculations mixed with I/O in the same function
- Functions that read disk + transform + write — split into pure transform + I/O wrappers

### 4.3 Missing abstractions

- Test files setting up the same preconditions in different ways → factor a fixture
- UI views all need a mock service client → factor `tests/utils/mockServiceClient.ts`
- Mock provider scripting reused across tests → factor reusable scenarios

---

## Step 5: Run the Tests

Get hard data on pass/fail rates and timing.

### Minimum runs

```bash
# Workspace vitest (fast)
pnpm test 2>&1

# Service alone (the densest layer)
pnpm --filter @bendyline/gezel-service test 2>&1

# CLI integration (real daemon transport)
pnpm --filter @bendyline/gezel-cli test 2>&1

# E2E Electron (requires `pnpm build` first; pnpm test:e2e does both)
pnpm test:e2e 2>&1
```

### What to record

For each run:
- Total / passed / failed / skipped
- Wall-clock time
- Which tests failed and why (real bug vs infra flake?)
- Re-run any failures to detect flakiness

---

## Step 6: Produce the Quality Report

Write to `reports/quality-review-YYYYMMDD-HHMM.md` (create `reports/` if it doesn't exist).

```markdown
# Gezel Quality & Test Coverage Review

**Date:** YYYY-MM-DD
**Reviewer:** Claude (Quality Manager)
**Commit:** [git short hash]
**Scope:** [Full review | Focused: {area}]

## Executive Summary

[2-3 paragraphs. Overall health of the suite. Single biggest coverage gap. Where would
you be most nervous about a refactor? What's working well and should be protected?]

## Test Suite Health Dashboard

### Inventory

| Layer | Files | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|---|
| Vitest — service | ? | ? | ? | ? | ? | ?s |
| Vitest — core | ? | ? | ? | ? | ? | ?s |
| Vitest — catalog | ? | ? | ? | ? | ? | ?s |
| Vitest — ui | ? | ? | ? | ? | ? | ?s |
| Vitest — app | ? | ? | ? | ? | ? | ?s |
| Vitest — other | ? | ? | ? | ? | ? | ?s |
| CLI integration | 1 | ? | ? | ? | ? | ?s |
| Playwright e2e | 6 | ? | ? | ? | ? | ?s |
| **Total** | **?** | **?** | **?** | **?** | **?** | **?** |

### Quality Indicators

| Metric | Value | Assessment |
|---|---|---|
| Tests-to-source ratio (service) | ? / ? | ? |
| Tests-to-source ratio (ui) | ? / 71 | ? |
| Assertion density (service avg) | ? per test | ? |
| Hardcoded e2e waits (`waitForTimeout`) | ? | ? |
| Debug/scratch tests | ? | ? |
| `.only` / `.skip` blocks | ? | ? |
| Flaky tests | ? identified | ? |

## Coverage Map

### Feature Coverage Matrix
[Filled-in version of the §3.1 matrix]

### Coverage Heatmap by Package
[Filled-in version of the §3.2 table]

## Critical Gaps (Must Address)

### [Gap title]
- **What's untested:** [Specific path or feature]
- **Risk:** [What could break silently]
- **Files involved:** [Source files that need tests]
- **Recommended test type:** Unit / Integration / E2E
- **Suggested test file:** [Where to add]
- **Effort:** Small / Medium / Large
- **Priority:** P0 / P1 / P2

## Test Quality Issues

### Flaky Tests
| File | Test name | Flakiness signal | Suggested fix |
|---|---|---|---|

### Low-Value Tests (consider removing or improving)
| File | Issue | Recommendation |
|---|---|---|

### Debug/Scratch Cleanup
| File | Evidence | Action |
|---|---|---|

## Refactoring Recommendations

### Code that needs refactoring for testability
| Module | Current problem | Suggested refactor | Test it would enable |
|---|---|---|---|

### Missing test infrastructure
| Need | Current state | Recommendation |
|---|---|---|

## Unit Test Expansion Plan

### Priority 1 (Critical Business Logic)
1. [Module] — [Why] — Effort

### Priority 2 (Important but Lower Risk)
1. ...

### Priority 3 (Nice to Have)
1. ...

## E2E Expansion Plan

The 6 specs cover the chat surface and supervisor; what flows are still uncovered?

1. [Flow] — [Risk if untested] — [Suggested spec]

## Prioritized Action Plan

### This Week (Quick Wins)
1. [Action] — [Why] — [Effort: hours]

### This Month (Medium Effort)
1. [Action] — [Why] — [Effort: days]

### This Quarter (Strategic)
1. [Action] — [Why] — [Effort: weeks]

## Appendix
### Test File Inventory
[Complete list with line counts]

### Files Reviewed
[Grouped by directory]
```

---

## Step 7: Present Results

1. **Lead with the numbers** — total tests, pass rate, the standout coverage gap.
2. **Highlight the single biggest gap** — most dangerous untested area.
3. **Link to the full report.**
4. **Offer to write** the top 1-3 highest-priority missing tests immediately.
5. **Flag** any flaky / debug tests for cleanup.

---

## Review Principles

### What good test coverage looks like

- **Every user-facing feature has at least one e2e or integration test** that exercises the happy path through a Mock provider.
- **Every pure function has unit tests** covering edge cases.
- **Every integration boundary has a test** that would catch schema drift.
- **Tests fail for the right reasons** — broken feature, not infra flake.
- **Suite is fast enough to run frequently** — vitest in seconds, e2e in tens of seconds.
- **No flakies, no skips, no false greens.**

### Common test anti-patterns

| Anti-pattern | Signal | Risk |
|---|---|---|
| **Smoke-test cemetery** | Tests that boot the service and assert nothing about behavior | False sense of coverage |
| **God test** | Single file with 50+ tests covering many features | Slow, hard to debug failures |
| **Fragile selectors** | E2E tests using nth-child / brittle CSS | Break on any UI change |
| **Sleep-and-pray** | Hardcoded `waitForTimeout(5000)` | Flaky on slow CI |
| **Order dependency** | Tests pass in sequence but fail individually | Hidden shared state |
| **Implementation testing** | Asserting on private state instead of observable behavior | Break on refactor |
| **Debug leftovers** | `.only` / `console.log` / commented assertions | Incomplete cleanup |
| **Missing negative tests** | Only happy paths covered | Bugs hide in unhappy paths |
| **Stale tests** | Tests for removed features | Noise, false confidence |
| **Mock drift** | MockProvider responses no longer match real provider shapes | Tests pass while production breaks |

### The "confident refactor" test

For each module: if an AI agent refactored its internals while preserving external behavior, would the test suite catch any regression? If "no" or "probably not", that module needs better coverage.

### The "silent breakage" test

For each integration boundary: if the contract drifted slightly (renamed field, shifted payload), would any test fail? If not, that boundary needs an integration test.

### Coverage vs. confidence

- **Line coverage** — code was executed (easy to game)
- **Branch coverage** — both paths exercised (better)
- **Behavioral coverage** — every user-visible behavior has an assertion (best)

Optimize for behavioral coverage. A test that boots a service and snapshots a JSON response is line coverage with zero behavioral coverage if the assertions don't tie back to a user-visible behavior.

---

## Focused Review Checklists

### "Review test coverage gaps"
- [ ] Build feature-to-test matrix
- [ ] Identify features with zero coverage
- [ ] Identify features with smoke-only coverage
- [ ] Check unit coverage for core/, catalog/, service/
- [ ] Check integration boundary coverage
- [ ] Prioritize by user-visible impact

### "Review test quality"
- [ ] Count assertions per test (flag tests with <2)
- [ ] Find hardcoded timeouts and sleeps
- [ ] Find `.only` / `.skip`
- [ ] Check for order-dependent tests
- [ ] Evaluate test naming
- [ ] Look for duplicated setup code

### "Review flaky tests"
- [ ] Run the e2e suite 2-3 times, compare
- [ ] Find tests with `waitForTimeout`
- [ ] Find tests depending on streaming timing
- [ ] Find tests reliant on specific Mock-provider sequences
- [ ] Look for race conditions in async setup
- [ ] Identify slow tests (>5s)

### "Review for refactoring needs"
- [ ] Find tightly coupled code (singletons, side effects in logic)
- [ ] Find functions over 100 lines
- [ ] Find modules with zero unit testability
- [ ] Recommend test seams and injection points
- [ ] Identify shared infra that would reduce boilerplate

### "Debug-test cleanup"
- [ ] Find test files with debug/scratch/temp in the name
- [ ] Find `.only` / `.skip` blocks
- [ ] Find tests that only console.log (no assertions)
- [ ] Find smoke-only tests
- [ ] Check `tests/screenshots/` size if accumulating

---

## Session Output Requirements

Every quality review MUST produce:

1. Written report at `reports/quality-review-YYYYMMDD-HHMM.md`
2. Test suite health dashboard with actual numbers
3. Feature-to-test coverage matrix
4. At least one critical gap identified (or explicit statement none exist)
5. Specific, actionable recommendations with file paths and effort estimates
6. Prioritized action plan (this week / this month / this quarter)

If implementing fixes:

7. New tests committed separately with clear messages
8. All existing tests still passing after changes
9. Updated test utilities if shared patterns were identified
