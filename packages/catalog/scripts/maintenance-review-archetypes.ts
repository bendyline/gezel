import type { ArchetypeSpec } from '../src/archetype.js';

/**
 * Whole-project reviews intended for recurring, unattended Night Shift runs.
 *
 * These are kept together because they form one operational suite: each pass
 * is read-only, starts from the repo/per-file index, verifies indexed leads in
 * source, and leaves an evidence-backed report for the morning review. The
 * companion books that already existed in the gallery (security, a11y, API,
 * dependencies, and test coverage) join this suite through the shared
 * `maintenance-review` / `night-shift` tags in `11-review-qa.json`.
 */
export const MAINTENANCE_REVIEW_ARCHETYPES: ArchetypeSpec[] = [
  {
    id: 'codebase-refactoring-review',
    name: 'Codebase Refactoring Review',
    role: 'maintenance-review',
    description:
      'Review an entire codebase for the least cogent, highest-leverage refactoring opportunities without changing source. Uses the repository map and per-file AI health index to rank weak areas, then verifies each lead in the real code and leaves a file-and-line-cited morning report with sequenced refactor plans, risk, effort, and tests that must protect behavior. Use for a weekly code-health sweep, refactoring review, technical-debt triage, finding code smells, or deciding which files should be refactored first.',
    tags: [
      'maintenance-review',
      'night-shift',
      'refactoring',
      'code-quality',
      'technical-debt',
      'codebase',
    ],
    triggers: [
      'codebase refactoring review',
      'what should we refactor',
      'find the least cogent code',
      'weekly code health review',
      'technical debt sweep',
      'nightly refactoring review',
    ],
    toolsets: [
      {
        toolsetId: 'builtin.code-intel',
        autoAllow: true,
        reason: 'rank indexed file-health leads and inspect only the relevant symbols',
      },
      {
        toolsetId: 'builtin.git',
        autoAllow: true,
        reason: 'read-only history and churn evidence for prioritizing refactors',
      },
    ],
    phases: [
      {
        id: 'rank',
        name: 'Rank weak areas',
        role: 'reviewer',
        summary:
          'use the repo map and per-file health index to build a coverage-aware candidate list',
        prompt:
          'Start with `map_repo` and record the indexed review coverage (reviewed/eligible), average health, major-issue count, and worst files. Call `list_file_issues` across the repo, then use `search_code` for cross-cutting duplication, oversized orchestration, unclear ownership, error handling, and tightly coupled state. If git history is available, use read-only `run_git` queries to add churn/fix-frequency evidence; missing history is not a failure. Rank candidate files or cohesive areas using explicit factors: low indexed health, confirmed major issues, too many responsibilities, coupling/fan-out, duplication, change frequency, test difficulty, and blast radius. Do not call an indexed lead a finding yet and do not modify source. Write the coverage statement, ranking method, and top candidates to `notes/refactoring/candidates.md`.',
        produces: { path: 'notes/refactoring/candidates.md', kind: 'markdown-notes' },
      },
      {
        id: 'verify',
        name: 'Verify refactoring candidates',
        role: 'reviewer',
        summary: 'inspect candidate symbols, responsibilities, callers, and tests in real source',
        prompt:
          'Verify every shortlisted candidate in source. Call `file_review` for the indexed rationale, `outline_file` before reading a large file, `read_symbol` for the implicated units, and `find_references` to understand callers and blast radius. Locate tests with `search_code`/`grep_files`. For each confirmed candidate record real file:line evidence, the current responsibilities, the specific cohesion/coupling/duplication/testability problem, why it matters, a bounded refactor seam, dependencies and migration order, behavior-preserving tests required first, effort, risk, and expected payoff. Reject false-positive index leads explicitly. Prefer a smaller ranked list of verified opportunities over a long smell inventory. Write the evidence matrix to `notes/refactoring/verified.md`; do not change code.',
        produces: { path: 'notes/refactoring/verified.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Write the refactoring report',
        role: 'reviewer',
        summary: 'prioritized code-health report with safe, sequenced refactor plans',
        prompt:
          'Write `refactoring-review.md` for an admin to read in the morning. Use these exact sections: `## Executive summary`, `## Index coverage`, `## Ranked opportunities`, `## Cross-cutting themes`, `## Defer or leave alone`, and `## Recommended sequence`. Each ranked opportunity must cite real file:line evidence; state why the area is insufficiently cogent; name the proposed seam and steps; list behavior-preserving tests; and include impact, effort, risk, and dependencies. Separate systemic themes from individual files. State index gaps and unreviewed areas so a quiet report is not mistaken for a clean codebase. Do not include style-only churn or recommend rewrites without a migration boundary. On a loop-back, repair only the named report gaps.',
        produces: { path: 'refactoring-review.md', kind: 'markdown-report', minBytes: 1800 },
      },
    ],
    evaluate: {
      prompt:
        'Grade `refactoring-review.md`: (1) index coverage and limitations are explicit; (2) every ranked item was verified in source and cites a real file:line; (3) ranking uses impact, evidence, effort, risk, and blast radius rather than file size alone; (4) each recommendation names a bounded seam, sequence, and behavior-preserving tests; (5) systemic themes are distinguished from local smells; (6) false positives and areas to leave alone are recorded; (7) no source was changed and no vague rewrite advice remains. PASS every item or loop back with exact gaps.',
      loopBackTo: 'report',
      deliverable: { path: 'refactoring-review.md', kind: 'markdown-report', minBytes: 1800 },
    },
  },
  {
    id: 'codebase-ux-review',
    name: 'Codebase UX Review',
    role: 'maintenance-review',
    description:
      'Review the user experience implemented across a codebase and, when runnable, exercise the key flows in a real browser. Starts from the indexed UI surface rather than one screenshot, traces primary journeys and state transitions, then leaves a prioritized morning report covering information architecture, comprehension, feedback, recovery, consistency, responsive behavior, and user impact with source or runtime evidence. Use for a weekly UX sweep, product usability review, interaction review, or finding the highest-impact friction in an application.',
    tags: [
      'maintenance-review',
      'night-shift',
      'ux',
      'usability',
      'interaction-design',
      'codebase',
    ],
    triggers: [
      'codebase ux review',
      'weekly ux review',
      'review the product experience',
      'find usability problems',
      'nightly ux sweep',
      'review the user journeys',
    ],
    toolsets: [
      {
        toolsetId: 'builtin.code-intel',
        autoAllow: true,
        reason: 'map routes, components, state, and indexed per-file UX leads',
      },
      {
        toolsetId: 'builtin.browser-automation',
        autoAllow: true,
        reason: 'exercise runnable journeys and capture real interaction evidence',
      },
    ],
    phases: [
      {
        id: 'map',
        name: 'Map the experience',
        role: 'reviewer',
        summary: 'inventory surfaces, actors, journeys, states, and review coverage from the index',
        prompt:
          'Call `map_repo`, `list_file_issues`, and targeted `search_code` queries to inventory the implemented experience: routes/views, navigation, dialogs, forms, onboarding, settings, empty/loading/error/success states, destructive actions, and responsive breakpoints. Read product/UX guidance already in the workspace before applying generic taste. Identify primary actors and 3-7 highest-value journeys with their start, goal, and risky transitions. Record which surfaces are runnable and which can only be reviewed statically. Write the surface map, journey matrix, local design principles, index coverage, and test plan to `notes/ux/surface-map.md`. No findings yet.',
        produces: { path: 'notes/ux/surface-map.md', kind: 'markdown-notes' },
      },
      {
        id: 'exercise',
        name: 'Exercise and inspect journeys',
        role: 'reviewer',
        summary: 'walk key flows and verify indexed leads in source or a browser',
        prompt:
          'Walk every prioritized journey. When the app is runnable, use `run_playwright_script` to test it at representative desktop and mobile sizes while checking navigation, focus, validation, loading, empty, error, success, cancellation, and recovery states. When it is not runnable, trace the relevant route/component/state symbols with `outline_file`, `read_symbol`, and `find_references`; label static inferences honestly. Verify indexed leads rather than repeating them. For each confirmed issue capture journey, step, evidence (screenshot/selector or file:line), expected vs actual experience, affected users, severity, frequency, and a concrete design/change recommendation. Also record strengths and tested-clean states. Write the evidence log to `notes/ux/evidence.md`.',
        produces: { path: 'notes/ux/evidence.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Write the UX report',
        role: 'reviewer',
        summary: 'prioritized, journey-centered usability report for morning triage',
        prompt:
          'Write `ux-review.md` with: `## Verdict`, `## Coverage`, `## Journey scorecard`, `## Findings`, `## Strengths`, `## Not verified`, and `## Morning action list`. Order findings by user harm × frequency, not visual polish. Every finding must cite a journey step and runtime or file:line evidence, explain the user consequence, and give a concrete recommendation with effort. Cover information architecture, comprehension, feedback/state visibility, error prevention/recovery, consistency, and responsive behavior. Keep accessibility defects cross-referenced rather than duplicating the a11y audit. State when a judgment is a static inference. On a loop-back, fix only named gaps.',
        produces: { path: 'ux-review.md', kind: 'markdown-report', minBytes: 1800 },
      },
    ],
    evaluate: {
      prompt:
        'Grade `ux-review.md`: (1) the important surfaces and journeys are covered; (2) findings cite a journey step plus runtime or real file:line evidence; (3) static inference is distinguished from exercised behavior; (4) loading, empty, error, success, cancellation, and recovery states were considered; (5) severity follows user harm and frequency; (6) recommendations are concrete and effort-aware; (7) strengths, unverified areas, and an actionable morning list are present. PASS all or loop back with exact gaps.',
      loopBackTo: 'report',
      deliverable: { path: 'ux-review.md', kind: 'markdown-report', minBytes: 1800 },
    },
  },
  {
    id: 'artifact-integrity-review',
    name: 'Artifact Integrity & Ship Review',
    role: 'maintenance-review',
    description:
      'Perform an isolated ship-readiness review of the actual built artifacts of a project—sites, npm packages, archives, CLIs, binaries, installers, checksums, signatures, and release bundles—rather than trusting source or CI status. Inventories expected versus present assets, stages immutable copies, inspects archive contents and metadata, runs safe sandboxed smoke checks where possible, and leaves per-artifact GO/NO-GO verdicts plus a release-wide decision. Can review locally staged assets or public-release evidence supplied to the project. Use before shipping a release or as a recurring artifact-integrity night-shift audit.',
    tags: [
      'maintenance-review',
      'night-shift',
      'artifacts',
      'release',
      'integrity',
      'ship-readiness',
    ],
    triggers: [
      'artifact integrity review',
      'review the built artifacts',
      'test the release assets',
      'are these installers ready to ship',
      'audit a public github release',
      'nightly artifact review',
    ],
    toolsets: [
      {
        toolsetId: 'builtin.archives',
        autoAllow: true,
        reason: 'inspect zip, tar, tgz, and package contents without trusting filenames',
      },
      {
        toolsetId: 'builtin.code-execution',
        autoAllow: true,
        reason: 'perform bounded, sandboxed metadata and smoke checks on staged artifacts',
      },
      {
        toolsetId: 'builtin.web',
        autoAllow: true,
        reason: 'read public release metadata and verify supplied public asset URLs when allowed',
      },
    ],
    phases: [
      {
        id: 'inventory',
        name: 'Inventory and stage the release',
        role: 'reviewer',
        summary: 'lock the expected matrix and immutable evidence set before inspecting it',
        prompt:
          'Define the exact release under review (version, commit/tag, target platforms, artifact types). Derive the expected asset matrix from release manifests, package metadata, CI/release configuration, checksums, and supplied release notes. Inventory every locally staged artifact with path, byte size, type/magic when available, and a cryptographic hash. If public release metadata or URLs were supplied and Web Access is allowed, verify the public listing and headers; never claim a remote binary was downloaded or inspected unless it is actually present in the workspace. Preserve the originals and work only on isolated extracted/staged copies. Record missing, duplicate, unexpected, truncated, or zero-byte assets immediately. Write the expected-vs-present matrix, provenance, hashes, acquisition limitations, and isolation plan to `notes/artifacts/inventory.md`.',
        produces: { path: 'notes/artifacts/inventory.md', kind: 'markdown-notes' },
      },
      {
        id: 'inspect',
        name: 'Inspect each artifact',
        role: 'developer',
        summary:
          'verify identity, contents, installability, safety, and cross-artifact consistency',
        prompt:
          'Inspect every artifact independently. Use `list_archive` before extraction, then extract into isolated paths. Verify filename/type/magic, version and commit identity, checksums/signatures when provided, expected entrypoints, executable bits, package manifests, dependency/lock and license/SBOM notices, source-map/debug-symbol policy, update/uninstall metadata, and absence of secrets, private keys, `.env`, build caches, absolute developer paths, or unexpected source. Check sites for missing referenced assets. For npm/CLI/packages, perform only safe sandboxed pack/install/help/version/smoke checks; never run an untrusted native installer on the host. For platform artifacts that cannot run here, inspect statically and mark the platform smoke test NOT VERIFIED. Compare all artifacts for one version/commit and consistent bundled files. Record commands, exit codes, and evidence per artifact in `notes/artifacts/checks.md`.',
        produces: { path: 'notes/artifacts/checks.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Write the artifact ship report',
        role: 'reviewer',
        summary: 'per-artifact verdicts and a release-wide ship decision',
        prompt:
          'Write `artifact-integrity-review.md` with: `## Release verdict`, `## Evidence provenance`, `## Artifact matrix`, `## Blocking findings`, `## Advisory findings`, `## Cross-artifact consistency`, `## Not verified`, and `## Reproduction commands`. Give every artifact its own GO / NO-GO / NOT-VERIFIED verdict. Every claim must point to a staged path, hash, manifest field, archive member, command/exit code, or supplied public-release record. Any missing expected artifact, secret/private key, checksum/signature mismatch, version/commit mismatch, broken entrypoint, failed smoke test, or missing referenced site asset is a blocker unless explicitly justified. A release cannot be GO when any required artifact is NO-GO or materially unverified. Keep source-code readiness outside scope except where needed to explain artifact provenance.',
        produces: {
          path: 'artifact-integrity-review.md',
          kind: 'markdown-report',
          minBytes: 2000,
        },
      },
    ],
    evaluate: {
      prompt:
        'Grade `artifact-integrity-review.md`: (1) expected and present assets are reconciled; (2) each artifact has provenance, size/type/hash, checks, and an individual verdict; (3) archive/package contents and metadata were inspected in isolation; (4) safe smoke tests include commands and exit codes while unrun platform tests are NOT VERIFIED; (5) versions/commits and bundled content agree across artifacts; (6) secrets, licenses/SBOM, source maps/debug files, signatures/checksums, entrypoints, and missing site assets were considered where applicable; (7) the release verdict follows blockers and uncertainty. PASS all or loop back with exact gaps.',
      loopBackTo: 'report',
      deliverable: {
        path: 'artifact-integrity-review.md',
        kind: 'markdown-report',
        minBytes: 2000,
      },
    },
  },
  {
    id: 'reliability-review',
    name: 'Reliability & Resilience Review',
    role: 'maintenance-review',
    description:
      'Review a codebase for production reliability and resilience risks across asynchronous work, external dependencies, state transitions, resource lifecycles, and recovery paths. Uses the repository and per-file indexes to map failure domains, verifies likely issues in source and tests, and leaves a prioritized morning report covering timeouts, retries, idempotency, cancellation, concurrency, backpressure, cleanup, graceful shutdown, observability, and disaster recovery. Use for a weekly reliability sweep, resilience review, failure-mode audit, or pre-production hardening review.',
    tags: [
      'maintenance-review',
      'night-shift',
      'reliability',
      'resilience',
      'failure-modes',
      'codebase',
    ],
    triggers: [
      'reliability review',
      'resilience audit',
      'review failure modes',
      'weekly production hardening',
      'find reliability risks',
      'nightly reliability sweep',
    ],
    toolsets: [
      {
        toolsetId: 'builtin.code-intel',
        autoAllow: true,
        reason: 'map failure domains and verify indexed reliability leads in source',
      },
      {
        toolsetId: 'builtin.code-execution',
        autoAllow: true,
        reason: 'run safe existing tests or focused diagnostic scripts when available',
      },
    ],
    phases: [
      {
        id: 'model',
        name: 'Map failure domains',
        role: 'reviewer',
        summary: 'inventory stateful and asynchronous boundaries plus their reliability contract',
        prompt:
          'Call `map_repo`, `list_file_issues`, and targeted `search_code` queries for queues/jobs, timers, promises, subprocesses, network/database/filesystem calls, caches, locks, transactions, startup/shutdown, and persistence. Build a failure-domain map: critical user journeys, state owners, external dependencies, retry boundaries, resource lifecycles, and recovery expectations. For each boundary define the reliability contract: timeout, retry/backoff/jitter, idempotency, cancellation, concurrency limit/backpressure, cleanup, error propagation, monitoring, and recovery. Record index coverage and areas not statically observable. Write the map and prioritized audit plan to `notes/reliability/failure-map.md`.',
        produces: { path: 'notes/reliability/failure-map.md', kind: 'markdown-notes' },
      },
      {
        id: 'verify',
        name: 'Verify failure handling',
        role: 'reviewer',
        summary: 'trace representative failures through source and tests',
        prompt:
          'For each high-impact boundary, inspect the relevant symbols and callers with `file_review`, `outline_file`, `read_symbol`, and `find_references`. Trace representative failures: slow/hung dependency, transient failure, duplicate delivery, partial write, cancellation, concurrent mutation, process restart, disk full/corrupt state, and shutdown during work. Locate tests and run safe existing checks when practical. Confirm whether timeouts are bounded; retries have caps/backoff/jitter and do not multiply side effects; operations are idempotent; cancellations and errors propagate; resources/timers/listeners/subprocesses are released; transactions or durable journals protect multi-step state; startup and shutdown are safe; and operators get useful signals. Record confirmed issues and verified-safe controls with real file:line/test/command evidence in `notes/reliability/evidence.md`.',
        produces: { path: 'notes/reliability/evidence.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Write the reliability report',
        role: 'reviewer',
        summary: 'ranked failure-mode report with concrete hardening work',
        prompt:
          'Write `reliability-review.md` with `## Verdict`, `## Coverage and assumptions`, `## Failure-domain scorecard`, `## Findings`, `## Verified controls`, `## Not verified`, and `## Hardening sequence`. Each finding must cite real file:line or test/command evidence, state the initiating failure, propagation path, user/operator impact, likelihood, severity, and a concrete remediation plus the failure-injection/regression test to add. Rank by impact × likelihood × recoverability. Distinguish a missing control from a merely untested control. Do not demand distributed-systems machinery for local, low-risk code. On a loop-back, fix only named gaps.',
        produces: { path: 'reliability-review.md', kind: 'markdown-report', minBytes: 1800 },
      },
    ],
    evaluate: {
      prompt:
        'Grade `reliability-review.md`: (1) critical failure domains and contracts are mapped; (2) findings cite real source/test/command evidence; (3) timeouts, retries/backoff, idempotency, cancellation, concurrency/backpressure, cleanup, partial writes, restart, and shutdown were considered where relevant; (4) propagation and user/operator impact are explained; (5) each remediation includes a failure-injection or regression test; (6) verified controls and unverified areas are explicit; (7) priorities reflect impact, likelihood, and recoverability without overengineering. PASS all or loop back.',
      loopBackTo: 'report',
      deliverable: { path: 'reliability-review.md', kind: 'markdown-report', minBytes: 1800 },
    },
  },
  {
    id: 'documentation-drift-review',
    name: 'Documentation Drift Review',
    role: 'maintenance-review',
    description:
      'Review project documentation against the code, configuration, commands, API surface, and shipped behavior to find stale or misleading guidance. Uses the indexed docs and source map to verify examples and references instead of proofreading in isolation, then leaves a prioritized morning report with exact doc locations, source-of-truth evidence, corrected text, owners, and a prevention plan. Use for a weekly docs-health sweep, documentation accuracy review, stale README audit, or finding runbook and API-documentation drift.',
    tags: ['maintenance-review', 'night-shift', 'documentation', 'drift', 'accuracy', 'codebase'],
    triggers: [
      'documentation drift review',
      'find stale docs',
      'weekly docs review',
      'check docs against code',
      'audit the readme and runbooks',
      'nightly documentation sweep',
    ],
    toolsets: [
      {
        toolsetId: 'builtin.code-intel',
        autoAllow: true,
        reason:
          'compare documented behavior with indexed symbols, configs, routes, and entrypoints',
      },
      {
        toolsetId: 'builtin.code-execution',
        autoAllow: true,
        reason: 'safely verify documented package commands and examples when available',
      },
    ],
    phases: [
      {
        id: 'inventory',
        name: 'Inventory documentation contracts',
        role: 'reviewer',
        summary: 'map docs to the source-of-truth surfaces they claim to describe',
        prompt:
          'Call `map_repo`, `list_file_issues`, and `search_code` to inventory user/admin/developer docs: README and setup guides, API references, CLI help/examples, configuration/environment-variable docs, architecture/decision docs, runbooks, migration/release guides, and inline examples. Build a traceability matrix mapping each important claim to its source of truth (package script, schema, route, exported symbol, config default, CLI definition, or runtime behavior). Prioritize high-harm docs used during install, deploy, recovery, security, and API integration. Record index coverage, generated docs that should not be hand-edited, and the verification plan in `notes/docs/traceability.md`.',
        produces: { path: 'notes/docs/traceability.md', kind: 'markdown-notes' },
      },
      {
        id: 'verify',
        name: 'Verify documented behavior',
        role: 'reviewer',
        summary: 'check commands, examples, links, schemas, defaults, and architecture claims',
        prompt:
          'Verify the high-priority claims against real source. Use `outline_file`/`read_symbol` for definitions and `find_references`/`search_code` for renamed concepts. Compare documented commands to package scripts/CLI help, env vars and defaults to schemas/config readers, API examples to route schemas and status codes, file paths to the workspace, and architecture statements to current dependencies/entrypoints. Run safe documented commands or examples when practical and capture exit codes; otherwise mark them statically verified or not verified. Check internal links and code/file references. For each confirmed drift item record doc file:line, exact stale claim, source-of-truth file:line or command evidence, reader impact, severity, corrected wording, and likely owner. Record true positives, false positives, and verified-current docs in `notes/docs/evidence.md`.',
        produces: { path: 'notes/docs/evidence.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Write the documentation drift report',
        role: 'reviewer',
        summary: 'prioritized corrections and prevention work for morning triage',
        prompt:
          'Write `documentation-drift-review.md` with `## Verdict`, `## Coverage`, `## Drift findings`, `## Verified current`, `## Not verified`, `## Corrections by owner`, and `## Prevention`. Every finding must cite the doc file:line and source-of-truth evidence, explain the reader harm, and include corrected text or an exact update. Rank broken install/deploy/recovery/security/API guidance above tone or grammar. Distinguish stale docs from missing docs and generated docs. Recommend durable prevention such as tested snippets, generated reference sections, link checks, or ownership near source—only where it addresses an observed class of drift. On a loop-back, repair only named gaps.',
        produces: {
          path: 'documentation-drift-review.md',
          kind: 'markdown-report',
          minBytes: 1800,
        },
      },
    ],
    evaluate: {
      prompt:
        'Grade `documentation-drift-review.md`: (1) high-harm doc classes are covered; (2) every drift finding cites doc file:line plus source-of-truth file:line or command evidence; (3) commands, examples, links, API/config/default claims, and architecture references were checked where relevant; (4) findings include reader impact and exact corrected text; (5) stale, missing, generated, verified-current, and not-verified docs are distinguished; (6) ownership and priority are actionable; (7) prevention recommendations address observed drift patterns. PASS all or loop back.',
      loopBackTo: 'report',
      deliverable: {
        path: 'documentation-drift-review.md',
        kind: 'markdown-report',
        minBytes: 1800,
      },
    },
  },
];
