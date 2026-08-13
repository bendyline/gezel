Iteratively tune a specific local chat model to convergence — baseline it across 10+ evals, then adjust its catalog tuning (sampling, reasoning, engine) and model-profile behaviors one lever at a time, A/B each change, regression-sweep, and repeat until the model is well-tuned. Works on a freshly-added untuned model AND on improving an already-tuned one. Use when the user says "tune <model>", "dial in / optimize <model>", "tune the sampling/behaviors for <model>", or "get <model> well-tuned".

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. **If a lever adds
> or changes a value in a core Zod schema — a new `style.family`, a new
> behavior id, a new tool-grammar format — run `pnpm gilde:export-schemas`
> BEFORE `build-index`**, or the manifest fails gilde's *generated*
> `schemas/*.schema.json` ajv identity check and the model is **silently
> dropped from the index** (`build-index --verbose` → `skip …
> invalid-identity`). When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.
>
> **Verifying the link took.** `pnpm link:gilde` links at the *catalog
> package* level (`packages/catalog/node_modules/@bendyline/gilde`), NOT
> the workspace root — a root `readlink node_modules/@bendyline/gilde`
> will mislead you into thinking it's still pinned. Confirm with
> `cd packages/catalog && node -e "console.log(require('module').createRequire(process.cwd()+'/package.json').resolve('@bendyline/gilde/package.json'))"`
> — it should print your `../gilde` checkout path. Point evals at the
> checkout explicitly with `GEZEL_GILDE_DATA_DIR=/abs/path/to/gilde/data`.

# tune-model

Turns a single model into a **tuning campaign**: baseline → diagnose → change one lever → A/B → regression-sweep → converge → report. Where [eval-run](../eval-run/SKILL.md) scores ONE trial and stops, `tune-model` runs the outer loop that keeps changing catalog tuning + behaviors until the aggregate stops improving.

It works both directions:
- **New / untuned model** (e.g. `qwen3.5-122b-a10b-q4` just added to the catalog): establish a working baseline tuning from a same-family sibling, then optimize.
- **Existing model**: improve from its current manifest, hunting the scenarios that under-score.

The whole skill is governed by [docs/eval-strategy.md](../../../docs/eval-strategy.md)'s frame: **a medium-tier model SHOULD pass the anchored scenarios; the answer is never "use a bigger model," it's "which specific tuning or framework lever closes the gap."** Tuning is lane #1 of that doc. This skill is how you work that lane systematically.

> Converted from `.claude/skills/tune-model/SKILL.md` (skill "tune-model").
> - 4 shell block(s) kept as prose (not statically convertible)