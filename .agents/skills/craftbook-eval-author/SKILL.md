---
name: craftbook-eval-author
description: Create or extend per-craftbook eval coverage for gezel craftbook templates. Use when adding a new craftbook eval spec, deciding whether a craftbook needs a generic adapter scenario or custom scenario, writing deterministic success gates, or connecting a craftbook template to the local-model eval matrix.
---

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.


# Craftbook Eval Author

Use this skill to turn one craftbook template into a measurable local-model eval.

## Workflow

1. Run coverage first:

   ```sh
   pnpm --filter @bendyline/gezel-evals run craftbook:coverage -- --limit 30
   ```

2. Read the template manifest and `about.md` under `../gilde/data/craftbook-templates/**/<id>/versions/1.0.0/`.

3. Choose the smallest honest eval shape:
   - **Existing scenario link**: use when a hand-authored scenario already measures the task well. Add or update an entry in `evals/src/craftbooks/specs.ts` with `existingScenarioId`.
   - **Generic adapter**: use when deterministic workspace file gates are enough. Add a spec with `prompt`, `setup`, and `success.deliverables`; it becomes runnable through `craftbookScenarioFromSpec`.
   - **Custom scenario**: use when the grader must run code, use Playwright, inspect multiple files, or give precise repair nudges. Add `evals/src/scenarios/<id>.ts`, tests, and register it in `evals/src/scenarios/index.ts`.
   - **Simulator-backed scenario**: use when the craftbook depends on an external CLI, API, MCP server, or dataset. Pair this with `$craftbook-simulator-builder`.

4. Keep the eval self-contained. Seed fixtures in `setup`; do not depend on live web pages, real credentials, current dates, or services outside the trial home.

5. Make gates objective and user-shaped. Prefer shared checks from `@bendyline/gezel/checks`, compiler/runtime execution, Playwright assertions, or exact fixture-derived properties. Do not require hidden vocabulary unless the prompt or seeded project docs explicitly ask for it.

6. Update tests:

   ```sh
   pnpm --filter @bendyline/gezel-evals test -- craftbooks
   pnpm --filter @bendyline/gezel-evals run craftbook:coverage
   ```

## Spec Rules

- `craftbookId` must name a bundled template.
- `scenarioId` must be unique across evals.
- `coverage.status` means:
  - `planned`: design exists, harness missing.
  - `implemented`: runnable or linked to a runnable scenario.
  - `validated`: at least one local-model run has passed and the postmortem supports the measurement.
- `gaps` must name concrete missing work, not vague quality concerns.
- Generic adapter specs should include a prompt that asks for the craftbook by name so selection/invocation is observable in history.

## Anti-Overfit

Never change a craftbook prompt or grader just to make one local model pass. Fix broad failure modes: missing gates, weak repair messages, absent simulators, insufficient fixture data, unclear role routing, or runtime checks that do not reflect the user request.
