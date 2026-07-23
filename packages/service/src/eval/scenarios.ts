/**
 * Static metadata for known eval scenarios. The actual scenario *logic*
 * (prompt, success-check, runtime assertions) lives in the
 * `@bendyline/gezel-evals` package — this file is just the discoverable
 * surface so the UI's Benchmarks panel can render a picker without
 * bundling the eval source.
 *
 * Source of truth: keep this in sync with
 * `evals/src/scenarios/index.ts`. The id strings here MUST match
 * what the CLI harness accepts as `pnpm eval:run <id>`.
 *
 * Schema is intentionally narrow — adding a new scenario means adding
 * a row here plus a TS file under `evals/src/scenarios/`. The catalog
 * doesn't try to be the prompt's home; it's a manifest for UI
 * discovery and a strategic-frame anchor (the "capability axis"
 * column captures *why* a scenario exists, not just *what* it does).
 */

export interface EvalScenarioManifest {
  /** CLI id — must match `evals/src/scenarios/<...>.ts` id. */
  id: string;
  /** Display name for the UI. */
  name: string;
  /** Short, single-line description. */
  description: string;
  /** Capability axis this scenario probes (see docs/eval-strategy.md). */
  capabilityAxis: string;
  /**
   * Default chat model to pre-select when this scenario is chosen in the UI.
   * Must ship weights for every default engine — on Apple Silicon the default
   * provider is MLX, so a model with no working MLX build (e.g. Gemma-4 E4B,
   * whose mlx block carries `disabledReason`) would crash on load the moment a
   * Mac user hits Run. Pick a cross-engine model (llama.cpp + MLX both work).
   */
  defaultModel: string;
  /** Default image model to pick (only set for image-gen scenarios). */
  defaultImageModel?: string;
  /** Recommended timeout in ms — UI shows this so users can predict run length. */
  timeoutMs: number;
  /** Whether this scenario is one of the anchored "smoke test" scenarios. */
  anchored: boolean;
}

export const EVAL_SCENARIOS: readonly EvalScenarioManifest[] = [
  {
    id: 'tictactoe',
    name: 'Tic-tac-toe',
    description:
      'Meester creates a project, recruits a developer, ships a working tic-tac-toe HTML game.',
    capabilityAxis: 'Single-file JS generation',
    defaultModel: 'qwen3.5-4b-q4',
    timeoutMs: 20 * 60_000,
    anchored: true,
  },
  {
    id: 'petshop',
    name: 'Pet shop website',
    description:
      'Multi-tool orchestration: developer builds a pet-shop HTML, image-generator renders a custom logo, page references it.',
    capabilityAxis: 'Multi-tool orchestration',
    defaultModel: 'qwen3.5-4b-q4',
    defaultImageModel: 'sdxl-base-1.0',
    timeoutMs: 45 * 60_000,
    anchored: true,
  },
  {
    id: 'tankcombat',
    name: 'Tank combat arcade',
    description:
      'Single-page top-down tank arcade game with canvas/SVG, keyboard input, projectiles, scoring.',
    capabilityAxis: 'Single-file JS generation (advanced)',
    defaultModel: 'qwen3.5-4b-q4',
    timeoutMs: 25 * 60_000,
    anchored: true,
  },
  {
    id: 'tool-routing-image',
    name: 'Tool routing — image gen',
    description:
      'Fast-fail probe: does the team route image-gen tasks to the image-generator role (vs trying to install npm packages)?',
    capabilityAxis: 'Tool routing (image-gen)',
    defaultModel: 'qwen3.5-4b-q4',
    defaultImageModel: 'sdxl-base-1.0',
    timeoutMs: 20 * 60_000,
    anchored: false,
  },
  {
    id: 'self-correction-broken-js',
    name: 'Self-correction (broken JS)',
    description:
      'Seeded with a broken counter HTML. Team must find and fix the inline-JS bug without rewriting the file.',
    capabilityAxis: 'Read-debug-fix on existing code',
    defaultModel: 'qwen3.5-4b-q4',
    timeoutMs: 12 * 60_000,
    anchored: false,
  },
];

export function getScenarioManifest(id: string): EvalScenarioManifest | undefined {
  return EVAL_SCENARIOS.find((s) => s.id === id);
}
