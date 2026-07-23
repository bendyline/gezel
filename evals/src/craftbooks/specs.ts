import { evalSpecFromTestSpec } from './adapter.ts';
import { CRAFTBOOK_EVAL_OVERRIDES } from './overrides.ts';
import { loadCraftbookTestSpecsSync } from './test-spec-loader.ts';
import type { CraftbookEvalSpec } from './types.ts';

/**
 * Craftbook eval specs, assembled from the catalog's shipped truth: every
 * bundled book carries a `versions/<v>/test.json` sidecar (sample data,
 * mocks, kickoff prompt, static gates, advisory rubric — enforced by
 * catalog CI), adapted here and merged with the slim evals-internal
 * overrides (run/coverage records, hand-authored scenario links, bespoke
 * scenario ids, gaps).
 *
 * This replaces the old three-tier in-repo spec tables (explicit /
 * gallery / generated-remaining, ~6,300 lines) — see the plan
 * "systematize craftbook evals". To improve a book's eval, edit its
 * test.json next to the craftbook; to record run state, edit
 * `overrides.ts`.
 */
export const CRAFTBOOK_EVAL_SPECS: CraftbookEvalSpec[] = loadCraftbookTestSpecsSync().map(
  (loaded) => evalSpecFromTestSpec(loaded, CRAFTBOOK_EVAL_OVERRIDES[loaded.craftbookId]),
);

export function craftbookEvalSpecMap(): Map<string, CraftbookEvalSpec> {
  return new Map(CRAFTBOOK_EVAL_SPECS.map((spec) => [spec.craftbookId, spec]));
}

export function runnableGenericCraftbookSpecs(): CraftbookEvalSpec[] {
  return CRAFTBOOK_EVAL_SPECS.filter(
    (spec) => spec.coverage.status !== 'planned' && !spec.existingScenarioId && !!spec.prompt,
  );
}
