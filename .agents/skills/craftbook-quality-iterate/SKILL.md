---
name: craftbook-quality-iterate
description: Improve craftbook template quality from audit findings and local-model eval evidence. Use when reviewing craftbook coverage, interpreting craftbook eval failures, tightening gates/prompts/roles, or applying low-hanging fixes across generated and hand-authored craftbooks.
---

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Source-only authoring, generation, and validation should use the
> sibling checkout directly (`GILDE_DIR=../gilde`; the generators also detect
> that checkout) and must not relink the workspace dependency tree. Run
> `pnpm link:gilde` only when a daemon or end-to-end eval must resolve the local
> checkout as the installed `@bendyline/gilde` package. Before linking, run
> `pnpm deps:install`; allow the relink/install to finish without a
> short command timeout, and stop the quality loop immediately if it fails.
> Refresh generated indexes with `pnpm --filter @bendyline/gezel-catalog
> build-index`. When the loop lands: run `pnpm unlink:gilde`, confirm
> `pnpm check:local-links`, then PR the gilde changes, publish, and bump the pin
> in `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry in
> `pnpm-workspace.yaml`).


# Craftbook Quality Iterate

Use this skill to close the loop from audit or eval evidence back into better craftbooks.

## Workflow

1. Start with static coverage:

   ```sh
   pnpm --filter @bendyline/gezel-evals run craftbook:coverage -- --limit 50
   ```

2. For a failed local-model run, score facts before judging:

   ```sh
   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts <runDir>
   ```

3. Inspect `log.txt`, `history.jsonl`, task state, and sessions for observable failure modes: no craftbook selected, wrong role, missing gate, gate message too vague, tool unavailable, truncated file write, reviewer routed to finish too early, or simulator/grader mismatch.

4. Fix low-hanging fruit in the right source:
   - Generated gallery book: edit `packages/catalog/scripts/craftbook-archetypes.ts`, `packages/catalog/scripts/gallery-specs/*.json`, or the generator in `packages/catalog/src/archetype.ts`, then regenerate.
   - Hand-authored book: edit the specific manifest/about/scripts under `../gilde/data/craftbook-templates`.
   - Gate class issue: edit `packages/core/src/deliverable.ts` or shared checks under `packages/core/src/checks`.
   - Eval/harness issue: edit `evals/src/craftbooks/*` or `evals/src/scenarios/*`.

5. Re-run catalog and eval tests:

   ```sh
   pnpm --filter @bendyline/gezel-catalog test -- craftbook
   pnpm --filter @bendyline/gezel-evals test -- craftbooks
   pnpm --filter @bendyline/gezel-evals run craftbook:coverage
   ```

## Quality Bar

A strong craftbook has clear phase ordering, suggested roles, concrete prompts, observable deliverables, completion gates with repair routes, bounded attempts, a reviewer/evaluate step when static checks are insufficient, and at least one eval spec.

## Guardrails

- Do not explain failure as a model ceiling until gates, role routing, tool availability, repair feedback, and harness realism have been checked.
- Do not add scenario-specific recipes to global model tuning or about.md templates.
- Prefer reusable gate/check improvements over one-off prompt patches.
- Mark `coverage.status: validated` only after a local-model run supports the claim.
