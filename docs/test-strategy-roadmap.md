# Test strategy roadmap

Status: proposed, 2026-11-23. Nothing here is implemented. This document changes no test, workflow, or default.

The goal is a faster pull-request verdict at lower runner cost, with more of the coverage we have written actually executing. A review of every test area on 2026-11-23 found the tests themselves sharp: trivial, over-mocked, and duplicated tests are 0.1–3% of each area, and deleting them saves seconds. CI time is structural. It comes from one serial lane, from running the same suites four times per pull request, and from fixtures that pay for things the tests never use. Separately, a large amount of coverage exists on paper and never runs, and almost all automated evidence is Linux.

Numbers are measured on Quality run 45280051518 and on the 119 Quality runs from 2026-11-06 to 2026-11-23 unless marked as an estimate. Line numbers will drift; test names and function names are the stable references.

## Baseline

| Measure | Value |
|---|---|
| Time to a verdict on a green run (longest gating job) | median 54 min, p90 67 |
| Runner-minutes per green run | median 276 |
| Green runs | 54 of 119 |
| `pnpm test:ci` step | 56 min |
| Service suite | 39 min: the `unit` project is 9 min on 3 workers, the `integration` project is 29 min in one worker |
| UI suite | 503 s; summed worker time is 271 s of tests, 518 s of setup, 407 s of jsdom |
| Executions of the UI and service suites per pull request | 4 (unit job, two stability passes, coverage) |
| Share of Quality runner-minutes | stability passes 30%, coverage 24%, unit job 17% |
| Line coverage | core 89%, service 81%, ui 76%, cli 66%, app 56%, mcp 56%, client 46%, vscode 24% |
| Platform-gated tests that no workflow executes | 48 (34 macOS, 14 Windows) |

"Serial lane" below means the service suite's `integration` vitest project in [packages/service/vitest.config.ts](../packages/service/vitest.config.ts): 260 files, one at a time, each in its own fork. The projects run one after another, not concurrently: on the measured run the unit project ended at 542 s and the first integration file finished at 921 s.

## Rules for this work

- Do not bulk-delete small tests. The 506 service files under 50 ms total 8.8 s.
- Keep a fresh temp home, Store, and ChatManager per test (20–50 ms). Do not share a service or a home across tests to save time; it makes tests order-dependent.
- Speed a slow test by replacing its wait or its fixture, never its assertion.
- Budgets stay loose. A size or time limit that trips on normal drift gets raised.
- Release gates (`pnpm validate`, the npm and Electron release workflows) keep running every suite in every phase. Only the pull-request workflow changes shape.
- [scripts/release-electron-contract.test.mjs](../scripts/release-electron-contract.test.mjs) pins the current job shape: `pnpm test:ci` in `quality.yml`, `pass: [2, 3]`, exactly three embedder setups, `continue-on-error` on coverage, and the E2E jobs. Any change to the jobs edits that test in the same change.
- [packages/service/src/test-pool.test.ts](../packages/service/src/test-pool.test.ts) guards the service vitest config. Changes to projects or worker flags keep it passing.
- A test file that moves and is on the Windows list in [quality.yml](../.github/workflows/quality.yml) moves on that list too.

## Decisions for the owner

These are choices, not engineering. Phases 3 and 5 depend on them.

1. **Stability passes 2 and 3 on pull requests.** Decided 2026-11-23: they stay on pull requests. In 17 days they caught five failures pass 1 missed, each a different test seen once. Because each pass is a 40–57 minute job today, phase 3 splits every pass the same way as pass 1.
2. **Coverage on pull requests.** Decided 2026-11-23: every job that runs on pull requests today stays there, coverage included. Phase 3 shards it like the other suites.
3. **Session-token reach of unclassified project routes** (phase 1.2). Decided 2026-11-23: refuse all 11 routes that no gezel tool calls.
4. **A macOS runner in the nightly.** It is the only way to cover Seatbelt, `sips`, launchd autostart, and MLX.
5. **Eval-harness unit tests on product pull requests.** Decided 2026-11-23: they stay on every pull request, under the same rule as decision 2.

## Phase 1 Settle the authority questions

Status: done 2026-11-23, except the update-schema key listing in 1.3.

- 1.1 found a real escape. A craftbook id of `../..`, sent URL-encoded as every client does, wrote outside the templates root, and `DELETE /api/craftbooks/:id` recursively removed the folder holding the home. A document `version` reached the same paths. The store now refuses an id or version that is not one folder name (`isCraftbookPathSegment` in `fs/craftbook-store.ts`), pinned by `fs/craftbook-containment.test.ts`.
- 1.2 and 1.3: `http/route-authority.test.ts` drives all 854 registered routes through the real `buildApp` chain and compares who reaches each with `http/route-authority.json`. The 11 project routes no gezel tool called are now refused to session tokens.
- 1.4: `http/recipe-lock-routes.test.ts`, `http/connector-destination-route.test.ts`, `http/owner-only-routes.test.ts`.
- 1.5: `chat/session-token-revocation.test.ts`.

Small, and first, because two of these may be real defects rather than missing tests.

| # | Change | Where |
|---|---|---|
| 1.1 | Add a containment test for craftbook script source: an `id` of `..`, or one carrying an encoded slash, must not read, write, or delete outside the templates root. If it fails, validate the id or route the path through `safeJoin`. | [craftbook-source.ts](../packages/service/src/scripts/craftbook-source.ts), the `/:id/scripts/source` handlers in [routes/craftbooks.ts](../packages/service/src/http/routes/craftbooks.ts) |
| 1.2 | Decide and pin each project route the guard does not name. Inside `/api/projects/:id/*` an unnamed route is allowed to a session token by default. Confirmed unnamed: `POST /:id/reveal-reference`, `POST /:id/people/:entityId/rename`, `DELETE /:id/people/:entityId`. Reported, not yet traced: `/:id/continue`, `/index/enrich`, `/index/refresh`, `/reports/generate`. | [scope-guard.ts](../packages/service/src/http/scope-guard.ts), [routes/people.ts](../packages/service/src/http/routes/people.ts) |
| 1.3 | Add one table-driven test that walks every registered `/api/*` and `/events/*` route and requires a 401 without a token and a checked-in verdict per caller: worker session, coordinator session, harness token, container listener. Do the same for the keys of the two update-request schemas, of which the guard names 9 of about 30 and 4 of 16. | beside [scope-guard.test.ts](../packages/service/src/http/scope-guard.test.ts) |
| 1.4 | Add route-level tests for rules pinned only below the route: the recipe lock on a started task (five call sites; `recipe_locked` appears in no test), the connector credential destination rule for a `cli` or `product` token, and the `owner_only` replies in the lookout and app-update routes. | [routes/project-tasks.ts](../packages/service/src/http/routes/project-tasks.ts), [session-recipe-guard.ts](../packages/service/src/tasks/session-recipe-guard.ts) |
| 1.5 | Assert session-token revocation on teardown. `revokeSessionToken` has four call sites in `chat/manager.ts` and no test asserts any of them. | `packages/service/src/chat/` |

1.1 has been read, not executed: the handler and the path helpers do no check, and the guard allows `/api/craftbooks/*` to session tokens. Whether a decoded `..` reaches the handler is what the test settles. 1.3 replaces 14 scattered "requires auth" tests and the partial container and OpenAI-gate samples. It does not replace the body-conditional cases in `scope-guard.test.ts`. Use the harness in [mutation-authority.test.ts](../packages/service/src/http/mutation-authority.test.ts) (real routes, guards, and store; 20 tests in 0.8 s). Whether Hono's route list flattens sub-apps as needed is unverified.

Done when every registered route has a verdict row, the containment test passes, and a new route cannot merge without a row.

## Phase 2 Quick wins

Status: done 2026-11-23, with these differences from the table:

- 2.2: folding `search-handboek.test.ts` into `knowledge.test.ts` was tried and reverted; mounting the Handboek there changed four other tests' results.
- 2.5: only the deletions; the smoke repeats and `ux-tour.spec.ts` stay on pull requests (decision 2).
- 2.10: `tasks/write-artifact-deliverable.test.ts` was not a pure duplicate (its session is bound to a task); both tests moved into `mcp-bridge.test.ts`. `xet-download.test.ts` is at 3.4 s, not under 2 s: two tests depend on a 500 ms progress tick that is a constant in inference. The camera simulator now reuses one JPEG per distinct view, so its pictures no longer carry per-frame noise; the analysis frames the detector reads are unchanged.
- 2.11: three observation-table route tests were removed, not nine; the rest pin the route's own status codes. The history and scope-guard route trims are not done.
- 2.13: done for CLAUDE.md, both vitest configs and `quality.yml`.
- Measured locally: the check-in test 31 s on CI to 2.5 s; the seven embedding tests 13–15 s each to 1.7–3.7 s; `handboek-export.test.ts` lost a 42 s export; the UI suite 103 s to 87 s, with summed setup plus jsdom time down from 1,842 s to 842 s.

Independent, low risk, no design. Savings are per execution of the suite named; the UI and service suites run four times per pull request today.

| # | Change | Saving | Risk |
|---|---|---|---|
| 2.1 | Fix the scripting in "marks the turn that answers a check-in, parked or not" in [manager.test.ts](../packages/service/src/chat/manager.test.ts). A leftover hanging script makes the test and its teardown each wait a full 15 s drain. | 30 s, serial lane | none |
| 2.2 | Turn embeddings off in the seven chat tests that cold-load a model and assert nothing about embeddings, as `mcp-bridge.test.ts` already does with `GEZEL_DISABLE_EMBEDDINGS=1`. Three of them assert ranking output and must be re-run before the change is kept. Move the single `search-handboek` route test into `knowledge.test.ts` so it shares a boot. | about 98 s, serial lane | low; medium for the three |
| 2.3 | In [handboek-export.test.ts](../packages/cli/src/handboek-export.test.ts), assert the masthead directly and drop the second full export, which exists to check two substrings. | 42 s summed, CLI | none |
| 2.4 | Dropped: the E2E smoke-repeat steps stay on pull requests under decision 2. | — | — |
| 2.5 | Delete `e2e/handboek.spec.ts` (the web twin asserts more), test 3 of `e2e/home.spec.ts` (its colors are asserted by `shell.spec.ts`), and test 05 of `ux-first-run.spec.ts` (no assertions). `ux-tour.spec.ts` stays under decision 2. | about 15 s, Electron job | low |
| 2.6 | Raise the Home JavaScript budget in [performance.spec.ts](../packages/app/e2e-web/performance.spec.ts) from 6.2 MiB to about 8.4 MiB (1.5 times the 5.59 MiB baseline). It is the most frequent failure in the window: 6 runs. | fewer red runs | none |
| 2.7 | Take files that start nothing out of the serial lane by narrowing the globs: 55 route files that boot no service, 19 chat files that spawn nothing (six of them never construct a ChatManager), and 14 pure files under `src/scripts/*`, `src/git/*`, and the explicit entries. Files that do boot take the `*.integration.test.ts` name the config already prefers. | about 90 s, serial lane | low; purity was checked by pattern, so read each before moving |
| 2.8 | Let the unit project use every worker. `UNIT_WORKERS` reserves one for an integration project that is not running at the time. | up to 2 min, estimate | medium; confirm on CI before keeping |
| 2.9 | In [setup.ts](../packages/ui/src/test-utils/setup.ts), import `queryClient` from [data/query-client.ts](../packages/ui/src/data/query-client.ts) and reset it directly. Importing `resetReads` pulls core's whole main entry (4.16 MB) into every UI test file. | about 55 s, UI | very low |
| 2.10 | Replace real waits and repeated fixture work in the slow unit files (list below). | about 70 s summed, service | low |
| 2.11 | Delete true duplicates and dead code (list below). | seconds | none |
| 2.12 | Wire in tests nothing runs (list below). | adds about 3 s | none |
| 2.13 | Correct stale statements: CLAUDE.md says `daemon-integration.test.ts` runs in about 0.5 s (it takes 117 s); the service vitest config says projects run concurrently; the UI vitest config describes a global api mock that no longer exists; `quality.yml` says the clean-consumer install is release-only. | none | none |

**2.10, waits and fixture cost.**

- [download-with-retry.test.ts](../packages/service/src/utils/download-with-retry.test.ts) and `xet-download.test.ts` sleep through real backoff schedules. Pass a schedule through; `backoffDelayMs` in [net-retry.ts](../packages/core/src/net-retry.ts) already takes one. About 23 s.
- [page-check/runner.test.ts](../packages/service/src/page-check/runner.test.ts) waits out a 6 s timeout on a fake child. Use `timeoutMs: 50`. About 6 s.
- [library-e2e.test.ts](../packages/service/src/library-e2e.test.ts) has an unconditional 8 s sleep to outlast a hard-coded startup timer. Expose reconcile and the debounce through `startService`. About 10 s.
- The camera simulator encodes a JPEG per simulated frame. Cache the encoded frame per scene step. About 12 s.
- `handboek/engine.test.ts` renders every article six times. One pass per mode. About 7 s.
- `tasks/write-artifact-deliverable.test.ts` boots a service and an MCP child for two tool calls. Fold it into `mcp-bridge.test.ts`, which already asserts its second case. About 6 s.
- `first-run/on-device-bootstrap.test.ts` builds a catalog per test. Share one. About 3 s.

**2.11, duplicates and dead code.**

- `service/src/rewrite/think-splitter.test.ts` is identical to core's copy, as is the `buildTransformPrompt` block in `rewrite/generator.test.ts`.
- `ui/src/components/mention-parse.test.ts` re-runs core's mention tests under jsdom through a pure alias.
- In `manager.test.ts`: "rejects with timeout when the target never replies" (misnamed; it asserts a reply, which another test covers) and "still extracts on every turn for cloud providers" (covered in `manager-memory-debounce.test.ts`).
- Route tests that repeat a unit test of the same inputs: 9 of 11 in `routes/observation-tables.test.ts`, 6 in `routes/history.test.ts`, 5 of 7 in `scope-guard.integration.test.ts`.
- `DeviceSummary.tsx`, `ProjectQuestionsDialog.tsx`, and `NeedsInputPanel.tsx` have no importer; three test files still mock them.
- Core and service each have a `capAgentImageSize` with a different return shape. Only the service one is called. Merge them or remove core's.

**2.12, tests nothing runs.**

- `guard-pnpm-install.test.mjs`, `import-scorecard-campaigns.test.mjs`, and `windows-dependency-locks.test.mjs` are referenced by no script or workflow. The scorecard one guards what reaches the published scorecard.
- Five native-payload script tests (ROCm, Vulkan, kpack trimming) run only on a native tag. Run them on pull requests.
- [capture.real.test.ts](../packages/service/src/page-capture/capture.real.test.ts) is skipped in CI because it looks for Chrome under the test home while CI installs to the shared Playwright cache. This leaves `capture-worker.ts` at 0%.
- `npm-consumer-audit.test.mjs` runs only at release.

## Phase 3 Change the job shape

Status: done 2026-11-23, not yet run on CI.

- `unit` builds, typechecks, lints, and runs every package except the UI and the service (`pnpm test:lane packages`).
- `suites` runs passes 1–3, each split into four lanes on runners of their own: `service-unit`, `service-integration-chat`, `service-integration`, `ui` ([scripts/run-test-lane.mjs](../scripts/run-test-lane.mjs)). [scripts/run-test-lane.test.mjs](../scripts/run-test-lane.test.mjs) checks that the lanes together run exactly what `test:ci` runs; `release-electron-contract.test.mjs` pins the new shape.
- The service's serial lane is two vitest projects, `integration-chat` and `integration`, which still run one after the other locally. They are balanced at about 13 minutes each by the 2026-11-23 timings; each lane uploads per-file timings (`test-timings-*`) for rebalancing.
- The service lanes and the coverage job lift Ubuntu 24.04's AppArmor limit on unprivileged user namespaces, so page capture's sandboxed Chromium can start for `capture.real.test.ts`. That test has never run on CI; if the sandbox still cannot start there, it will fail rather than skip.
- 3.3 (build once) is not done: it saves runner-minutes, not wall clock. 3.4 and 3.5 are dropped under decisions 1, 2 and 5.
- Expected: the slowest gating job is about 22–24 minutes (build plus the longest lane, or the `unit` job). Runner-minutes per pull request rise, because each pass now pays four builds.

This is what moves the verdict time. No test changes.

| # | Change | Effect |
|---|---|---|
| 3.1 | Keep per-file timings as a CI artifact (vitest's JSON reporter) so each later change can be measured without parsing logs. | measurement |
| 3.2 | Split the unit job into parallel jobs: static checks (build, typecheck, lint); the service `unit` and `fs-events` projects; the service `integration` project in three shards; the UI suite; every other package. | verdict from about 54 min to about 20 |
| 3.3 | Build once. Nine jobs each run `pnpm build` for 6.5–7.5 min. One job uploads `dist` and the others download it. | about 50 runner-minutes per run; verdict unchanged |
| 3.4 | Move stability passes 2 and 3 and the coverage job to push to main and nightly (decisions 1 and 2). | about 150 runner-minutes per pull request |
| 3.5 | Path-gate the eval-harness unit tests to changes under `evals/`, core's `checks`, `eval`, and `scorecard`, the service gate code, the catalog package, and the Gilde pin (decision 5). Keep the 11 contract files on every pull request and the full suite on main, nightly, and both release gates. | up to 132 s |

Notes on 3.2. By measured per-file time the serial lane divides into three shards of 9.7 min each. Vitest's `--shard` splits by file count, and `manager.test.ts` alone is 343 s, so either define the lanes as explicit projects by directory (the three largest chat files, the rest of chat, http, everything else) or shard from the timing artifact in 3.1. Each shard keeps one worker and per-file isolation, which is what the lane exists for. Without 3.3, splitting costs about 8 runner-minutes of build per added job.

Done when a green pull request reaches its verdict in 20 minutes or less.

## Phase 4 Fix the fixtures

Status, 2026-11-23:

- 4.3 and 4.4: done (143 DOM-free UI files run in a `node` project; four suites use fake timers).
- 4.5: done. `daemon-integration.test.ts` is split into it and `daemon-commands.test.ts` over a shared harness ([cli/src/test-support/shared-daemon.ts](../packages/cli/src/test-support/shared-daemon.ts)); locally the two run in 37 s side by side.
- 4.6: done. gezel-mcp loads TypeScript on first use ([mcp/src/typescript-lazy.ts](../packages/mcp/src/typescript-lazy.ts)), so every MCP child and every real session starts without it.
- 4.1: not done. The real MCP server applies many registration filters (platform, withheld and legacy tools, step editing, allow and authorized lists, naming mode, then the bridge pool's allowlist), and a predicted roster that drifts from them changes prompts silently. With the serial lane split across runners, 4.1 now saves runner-minutes (about 8 per pass) rather than verdict time. Decide whether that is worth an in-process `tools/list` cache or a parity-tested prediction.
- 4.2: not done.

This is what moves runner cost, and it shortens every remaining execution.

| # | Change | Saving | Risk |
|---|---|---|---|
| 4.1 | Give `MockProvider` a mode that spawns no MCP child and advertises a predicted tool roster. Today `createSession` and `resumeSession` in [mock.ts](../packages/service/src/providers/mock.ts) always start a real `gezel-mcp` process. 47 chat test files point that child at port 0, so it can never call back, and none of them scripts a tool call. | about 480–500 s, serial lane | low to medium |
| 4.2 | Give route tests a shared harness. 69 files hand-roll a temp home plus `startService`, each paying about 3 s for a cold boot. Boot once per file in the 8 files that boot per test; move contract-only files onto a route-level app; run the 60 booting files that drive no chat turn in their own parallel project. | about 85 s for the first step, up to about 250 s | low, then medium (contention) |
| 4.3 | Add a `node` project with no setup file to the UI config for the 138 `.test.ts` files that never touch the DOM. | about 80 s, UI | low; a misfiled test fails loudly on `window` |
| 4.4 | Move real-time waits in UI tests to fake timers, starting with `nav-timing.test.ts`, `MemoriesTree.test.tsx`, and `TitlebarSearch.test.tsx`. | about 8 s, UI | low to medium per file |
| 4.5 | Split [daemon-integration.test.ts](../packages/cli/src/daemon-integration.test.ts) into lifecycle and commands; drop the two settings tests `settings-command.test.ts` already covers; unit-test the three argument validators. | CLI from 120 s to about 65 s, with 2.3 | low |
| 4.6 | Lazy-import `typescript` in gezel-mcp. A product change that also speeds every real session start. | about 20 s after 4.1 | low |

Notes on 4.1. The prediction logic already exists in production as `getRegisteredToolNames` in [codex-cli/session.ts](../packages/service/src/providers/codex-cli/session.ts), so the mode holds no state across tests. The cost is fidelity: the prompt is built from the predicted roster. Keep the real child for the tests that read or trim the tools block, keep it in the six files that genuinely exercise chat to bridge to server to disk, and add one parity test that the predicted roster equals the real tool list. A mode that returns no tools is not an option; it trips the bridge-failure branch and changes prompts and events. Convert `manager.test.ts` first (about 250 s), then `manager-handoff-entry.test.ts` (about 55 s).

Notes on 4.3. Keep `isolate: true` at first. Running these files unisolated passed once locally and was not tested for order dependence.

Done when the service suite runs in 25 minutes or less on one runner and the UI suite in about 6.5 minutes. Two integration shards then suffice.

## Phase 5 Run the coverage that already exists

Status, 2026-11-23:

- 5.1: done. Eight files now gate their deny-net cases on `denyNetBoundaryAvailable()` instead of macOS, and the fail-closed cases skip where a boundary exists instead of returning early and passing vacuously. On this Windows machine with the MXC launcher configured, all seven script, gate, hook and derive files pass with the deny-net cases running (113 passed, 5 skipped). The Windows sandbox step now runs them; they run on arm64, where the container works, and skip on the x64 image. Whether the Linux runner offers a boundary (systemd user units or the helper) is not known until CI runs; if it does, these suites start running on Linux too.
- 5.2: done as a list. Eleven service files and one each from app, core and client are added to the Windows jobs; all pass on this Windows machine. The list is still hand-kept.
- 5.3–5.7: not done. 5.3 and 5.4 need decision 4 (macOS and Windows runners for nightly runs); 5.5–5.7 are workflow changes that need a CI run to verify.

| # | Change |
|---|---|
| 5.1 | Un-gate the deny-net script tests. About 30 tests run only on macOS, and they are the only end-to-end tests of secret isolation, `http.authed`, gate scripts, hooks, and `derive`. [sandbox/runner.ts](../packages/service/src/sandbox/runner.ts) now also selects Linux systemd and Windows MXC, so gate on whether a boundary is available, and add `src/scripts/*.test.ts` to the Windows sandbox step. Whether the suites pass there is untested. |
| 5.2 | Stop keeping the Windows list by hand. It runs 10 of the 104 service test files that reference a platform. Until it is rule-driven, add `workspace/command`, `packages/win-shell`, `terminal/persistent-shell`, `providers/native/supervisor`, `providers/anthropic-cli/binary`, `engines/resolver`, and `machine-engine/knowledge-assets-registry`. |
| 5.3 | Add a nightly macOS vitest job over the darwin-gated files plus the macOS sandbox and autostart tests (decision 4). Estimated 8–10 min. |
| 5.4 | Port the 17 Electron specs that use nothing Electron-specific (174 s of 280 s) to the browser suite, behind a fixture option for an unseeded home. Run the 9 Electron-specific specs on Windows x64 and macOS arm64 nightly. Today every Electron E2E run at every trigger is Linux under xvfb. |
| 5.5 | Mobile. Schedule the iOS simulator job on main while it is off the pull-request path (since about 2026-11-21, pending an ONNX Runtime download). Wire `mobile:test:pages` into `mobile.yml`; it is the only WebKit run in the repo. The 42 Android instrumentation tests are compiled and never run in CI by design; record where they do run. |
| 5.6 | Schedule what no workflow runs: the visual-regression suite for desktop, tablet, and phone (last run 2026-09-07), the perf suite, the VS Code E2E suite, `test:extended:craftbooks`, and the 10 web tests gated on `GILDE_DIR`. Find out why `live-smoke` and `connector-accounts` are skipped on every scheduled run on record. |
| 5.7 | Move release-only checks ahead of the release: a container dry run before publish, service health after the Linux package install, and an install of the rpm. |

## Phase 6 Add the missing coverage

Status, 2026-11-23:

- 1: done. [client-route-conformance.test.ts](../packages/service/src/http/client-route-conformance.test.ts) matches every `this.request` and direct `fetchImpl` call in the client (over 700) against `buildApp`'s routes with the same method. All match today, apart from `/api/machine-serving` (proxied to the machine engine) and one call that fills a literal segment from a union type; both are listed in the test with their reason.
- 3: `resolveRestoreSelection` is now pinned (five tests in `cli/src/storage-format.test.ts`). The `gezel cleanup` confirmation rule and the UI's "Complete anyway" bypass are not done.
- The rest of the list is not done.

Ordered by what a break would cost.

1. **Client against routes.** Nothing checks the HTTP client against the service's routes: [client-contract.test.ts](../packages/client/src/client-contract.test.ts) compares the client with literals in its own package. Run those cases, and ideally every method, against the real route table and fail on 404 or 405.
2. **MCP tools gates depend on.** [inventory.test.ts](../packages/mcp/src/inventory.test.ts) checks registration, not behavior. Add invoke tests for `run_package_script`, `run_npx`, and `run_nodejs_script` (the receipt-bearing runners), one delegate and consult pair, `ask_specialist`, and the Photos tools.
3. **Data-loss paths.** `resolveRestoreSelection` in [storage-format.ts](../packages/cli/src/storage-format.ts) decides overwrite or skip and has no test. The `gezel cleanup` confirmation rule is inline in `bin/gezel.ts`; extract and test it. In the UI, [TaskStepPanel.tsx](../packages/ui/src/components/TaskStepPanel.tsx) and its "Complete anyway" bypass are at 0%, as is [run-export.ts](../packages/ui/src/components/DocumentExport/run-export.ts).
4. **Supervisor.** Version-mismatch respawn, restart-budget exhaustion, and the utility host falling back to in-process have no test in [index.test.ts](../packages/app/src/supervisor/index.test.ts). The utility host is the development default.
5. **ChatManager.** Context-overflow recovery on send, a live session moving to the remote fallback and back, the local-preview browser refusals, the parked-handoff watchdog, and the per-boot recovery limits.
6. **Desktop and phone parity.** Extend [portable-parity.test.ts](../packages/service/src/http/portable-parity.test.ts) beyond script routes to tasks, questions, reminders, requests, and growth. Add a growth fixture both engines must score alike, a reason-per-row table for [craftbookHostGap](../packages/core/src/runtime/craftbook-host-gap.ts) (5 of about 19 reasons are asserted), and two more vectors for the [chat-launch key](../packages/service/src/tasks/chat-launch-key.test.ts).
7. **Integrity and network checks.** Hash mismatch and off-registry redirect in [system-toolsets/bootstrap.ts](../packages/service/src/system-toolsets/bootstrap.ts); the website sign-in flow; remote pairing's fingerprint checks; per-hop redirect checks in page capture; the lookout daily ceiling across a restart.
8. **Stdlib gate scripts.** [checkReviewReport.ts](../packages/script-stdlib/scripts/checkReviewReport.ts) and the four plan gates have inline logic and no test. `stdlib-lint.test.ts` should check that a gate delegates to the shared checks, not that an import exists.
9. **Thin mutating routes.** Lookouts, terminals, folders, the config write, accounts, eval, and the system sign-in routes are 12–55% covered. Their managers are well tested; the wiring is not.
10. **Smaller hosts.** The Excel and PowerPoint adapters in the Office pane, [earned-notifications.ts](../packages/app/src/earned-notifications.ts) (0%), the rail fold below 1,200 px, and the VS Code extension's activation and language-model provider.

## Phase 7 Put tests beside their code

Status, 2026-11-23: 7.5 done; the VS Code floor is lowered to 40% to match its true rate of 6 in 13 files. The rest is not done.

No time is recovered here. The gain is that tests run against source and each package's own suite means something.

| # | Change |
|---|---|
| 7.1 | Move the service test files whose subject lives in `packages/inference` (about 150 files, 1,960 tests) to that package, importing source. They run against its built `dist` today, which is the stale-`dist` hazard CLAUDE.md warns about. Start with the 84 files under 50 ms. Several are on the Windows list. |
| 7.2 | Move the 14 service files whose subject lives in core, and the 15 that test core through re-export shims, growth first. `core/src/growth/` has no test file of its own, and the phone's own check does not run the service copies. |
| 7.3 | Move the 15 pure tests under `manager.test.ts`'s file-level setup, and the seed-wording tests in `manager-handoff-entry.test.ts`, beside the functions they test. |
| 7.4 | Replace the 11 forwarding tests in `scripts/dispatcher.test.ts`, which assert calls on a cast fake, with one table-driven test over a real Store. |
| 7.5 | Make the test-surface gate ignore `import type`. [check-test-surface.mjs](../scripts/check-test-surface.mjs) credits a file from a type-only import or a matching file name; two VS Code files are credited that way while coverage shows them at 0%. |
| 7.6 | Optional: collapse about 110 schema tests that parse a literal and assert the same literal back, in `schemas.test.ts`, `session.test.ts`, `script.test.ts`, and `keurmeester.test.ts`. |
| 7.7 | Lowest priority: where a value is the behavior, stop asserting the whole sentence around it (`tasks/owner-step`, `tasks/figure-review`, scorecard captions). |

## Expected result

Estimates, with every pull-request job kept on pull requests (decisions 1, 2 and 5). Not yet measured on CI.

| Measure | Before | After phases 1–6 as done |
|---|---|---|
| Time to a verdict (slowest gating job) | median 54 min | about 22–24 min |
| Runner-minutes per pull request | median 276 | higher: each of the three passes now pays four builds |
| Longest single test lane | 56 min (`test:ci` on one runner) | about 13 min (`service-integration-chat` or `service-integration`) |
| UI suite | 503 s | about 420 s by the local measurement |
| Platform-gated tests no workflow runs | 48 | 14 fewer Windows; the macOS deny-net suites now run on Windows arm64 |

4.1 and 3.3 are the remaining runner-minute savings.

## What to leave alone

- The 506 service files under 50 ms, and core's large scenario files (`llama-cpp-session.test.ts`, `local-tool-call-salvage.test.ts`): hand-written, distinct cases, many pinning an incident.
- The guard tests: `scope-guard.test.ts`, `mutation-authority.test.ts`, `harness-route-guard.test.ts`, `coordinator-only-tools-guard.test.ts`.
- The style-contract tests in the UI and the two byte-exact prompt goldens.
- The TUI suite and its repeat in the stability passes.
- The overlap between unit tests and Playwright. In each case found, the more expensive layer adds daemon state, reload persistence, or real keyboard handling.
- Files whose time is the work under test: `app-serve`, `perf/responsiveness`, `connectors/engine-model`, `tasks/night-shift-e2e`, `routes/chat-events`, `routes/projects.run-playwright`.

## How the numbers were measured

- Job and step durations: `gh run view <run> --json jobs`.
- Per-file test times and lane order: the vitest file lines and timestamps in the unit job's log.
- Failure history: job conclusions and failed-step logs for the 119 runs.
- Coverage: the `runtime-coverage-*` artifacts of the same run. They count in-process vitest only, so the MCP server (run as a child process) and sandboxed scripts read lower than they are.
- Savings are estimates unless a row says measured. The counts of client methods no test names (567 of 856) and MCP tools no test invokes (121 of 202) come from name matching, not execution.
- Reviewers ran three chat test files and subsets of the UI suite locally. Nothing else was executed, and the claims in phase 1 were read, not run.
