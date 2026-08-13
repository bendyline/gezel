Comprehensively run the built-in craftbook evals against the models installed on THIS device, then produce a strategic report that clusters the failures and diagnoses each as a framework bug, an eval bug, a craftbook bug, or a model-capability floor. Use when the user says "sweep the craftbooks", "run the craftbook matrix", "where are the craftbook evals failing", "which craftbooks are broken", or asks to evaluate craftbook coverage against local models.

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.

# craftbook-eval-matrix

The sister of `$eval-run`. Where `eval-run` scores ONE model against the curated scorecard, this skill sweeps the WHOLE built-in craftbook library across every model on the box and answers a different question: **where is the craftbook system failing, and whose bug is each failure?**

The deliverable is a strategic report whose spine is a four-way diagnosis:

| Class | Means | Owner / follow-up |
|---|---|---|
| **framework bug** | the runtime/harness/daemon misbehaved — the model (or the task) did the right thing and the plumbing blocked it | `$eval-run` Phase-3 strategic fixes; `packages/service/src/**` (salvage, role-tool-filter, dispatch, MCP bridge) |
| **eval bug** | the `test.json` spec is wrong — the deliverable met the task-class bar but the gate rejected it, a threshold is off, a fixture is missing, or the gate demands something the prompt never asked for | `$craftbook-eval-author` |
| **craftbook bug** | the model followed the book faithfully but the book led it astray — vague step, missing gate, wrong `suggestedRole`, no repair route, confusing order | `$craftbook-quality-iterate` |
| **model capability** | the book is well-crafted and well-gated, the eval is fair, the framework worked, a stronger model passes the SAME book, but this smaller model can't drive it | accept as a tier floor — **never** "use a bigger model" as the fix |

**The load-bearing rule (from [docs/eval-strategy.md](../../../docs/eval-strategy.md)): "model capability" is the verdict of LAST RESORT.** The product target is "works on a medium local model." A `model`-class failure from the harness is NOT proof of a capability ceiling — it's the harness's default bucket. You must actively rule out the other three before you are allowed to write "model capability." A report that concludes "the model can't" without having tried to pin it on a framework/eval/craftbook fix is producing low-value work.

---

> Converted from `.claude/skills/craftbook-eval-matrix/SKILL.md` (skill "craftbook-eval-matrix").
> - 7 shell block(s) kept as prose (not statically convertible)