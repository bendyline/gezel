export * from './schemas/index.js';
export * from './filemap/index.js';
export * from './code-intel/compose.js';
export * from './scripts/source-split.js';
export * from './chat-model-aliases.js';
export * from './project-local-id.js';
export * from './markdown/index.js';
export * from './fonts.js';
export * from './engagement.js';
export * from './entity-id.js';
export * from './night-shift.js';
export * from './project-properties.js';
export * from './project-icons.js';
export * from './shared-project.js';
export * from './growth-cosmetics.js';
export * from './security/policy.js';
export * from './gezel-display.js';
export * from './task-handoff-note.js';
export * from './external-gezel-model.js';
export * from './github-urls.js';
export * from './github-pr-selection.js';
export * from './log.js';
export * from './error-report.js';
export * from './turn-cancel.js';
export * from './process-errors.js';
export * from './keyed-lock.js';
export * from './redact.js';
export * from './ollama-models.js';
export * from './model-fit.js';
export * from './model-attribution.js';
export * from './model-quantization.js';
export * from './fitness-badge.js';
export * from './recommendation.js';
export * from './retrieval-budget.js';
export * from './tool-names.js';
export * from './file-refs.js';
export * from './names.js';
export * from './voices.js';
export * from './poppetje/index.js';
export * from './project-types/taxonomy.js';
export * from './json-schema/validate.js';
export * from './roles/index.js';
export * from './deliverable.js';
export * from './binary-document.js';
export * from './scorecard/index.js';
export * from './device-safety.js';
export * from './toolset-trust.js';
export * from './craftbook-categories.js';
export * from './craftbook-collapse.js';
export * from './craftbook-doc.js';
export * from './skills/index.js';
export * from './execution-density.js';
export * from './plan/plan-document.js';
export * from './mentions.js';
export * from './pnpm-invocation.js';
export * from './net-retry.js';
export * from './suspend-clock.js';
export * from './gezel-version.js';
export * from './outside-in-paths.js';
export * from './shadow-paths.js';
export * from './thread-title.js';
export * from './catalog-work-in-progress.js';
export * from './distribution/profile.js';

/**
 * The package version is embedded into health responses and logs so clients
 * can surface it in the UI.
 */
export const GEZEL_VERSION = '0.0.0';

/**
 * The HTTP contract generation this build speaks, and the oldest one it still
 * serves. Reported on `/api/health` as `apiCompat`.
 *
 * This is NOT a version. `GEZEL_VERSION` moves on every release and says
 * nothing about whether two builds can talk; the only comparison anyone made
 * with it was string equality, which reads every ordinary release as a
 * mismatch. A store-distributed client cannot restart or replace the daemon
 * it finds — its whole decision is "can I use this one, or must I run my
 * own?" — so it needs an answer that stays stable across the releases where
 * nothing about the contract changed.
 *
 * Bump `GEZEL_API_GENERATION` only for a breaking, client-visible change to
 * the schemas in `schemas/` as served over HTTP. Raise
 * `GEZEL_API_GENERATION_FLOOR` to the same number only when dropping support
 * for the older shape — keeping the floor behind the current generation is
 * what lets one daemon serve clients from several releases.
 */
export const GEZEL_API_GENERATION = 1;
export const GEZEL_API_GENERATION_FLOOR = 1;

/**
 * The date-based line this build sits on, for content compatibility only.
 *
 * `minGezelVersion` floors in gilde are authored as `1.YYDDD` — "any build of
 * that day or later" — so satisfying one is a question about *recency*, not
 * about which release this is. Those happen to be the same thing for the
 * Electron scheme (`1.YYDDD.RUN`) and are entirely different for npm, whose
 * versions are semver and carry no date at all.
 *
 * Comparing floors against `GEZEL_VERSION` therefore broke the npm channel in
 * both directions: `0.1.0` and `1.0.0` sit below every floor ever authored (so
 * floored content silently vanished), while a future `2.0.0` sits above every
 * floor (so content needing a newer build would be served to one that cannot
 * run it — the failure the floor exists to prevent, inverted).
 *
 * Both release paths stamp this from `scripts/calver.mjs`; an unstamped
 * checkout stays `0.0.0`, which `satisfiesMinGezelVersion` treats as a dev
 * build and never gates. Keep it out of anything user-facing —
 * `GEZEL_VERSION` is what `gezel --version` and `/api/health` report.
 */
export const GEZEL_CONTENT_COMPAT = '0.0.0';

/**
 * Default ISO-timestamp helper so every package produces the same shape.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
