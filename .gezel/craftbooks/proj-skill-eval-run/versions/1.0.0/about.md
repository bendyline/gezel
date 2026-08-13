Run gezel eval suites (core scorecard, smoke, extended deep-dives) or single scenarios end-to-end on this device, then produce a postmortem with a fixed 0-10 rubric and a positives/negatives report. Use when the user says "run an eval", "kick off a benchmark", names a scenario or suite, or asks to evaluate a model.

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.

# eval-run

Closes the loop on gezel evaluations: pre-flight → run → score → report → strategic-check.

> Converted from `.claude/skills/eval-run/SKILL.md` (skill "eval-run").
> - 5 shell block(s) kept as prose (not statically convertible)