export * from './schemas/index.js';
export * from './filemap/index.js';
export * from './code-intel/compose.js';
export * from './scripts/source-split.js';
export * from './chat-model-aliases.js';
export * from './project-local-id.js';
export * from './markdown/index.js';
export * from './fonts.js';
export * from './engagement.js';
export * from './night-shift.js';
export * from './project-properties.js';
export * from './growth-cosmetics.js';
export * from './security/policy.js';
export * from './gezel-display.js';
export * from './log.js';
export * from './redact.js';
export * from './ollama-models.js';
export * from './model-fit.js';
export * from './fitness-badge.js';
export * from './recommendation.js';
export * from './tool-names.js';
export * from './names.js';
export * from './voices.js';
export * from './poppetje/index.js';
export * from './project-types/taxonomy.js';
export * from './roles/index.js';
export * from './deliverable.js';
export * from './binary-document.js';
export * from './device-safety.js';
export * from './toolset-trust.js';
export * from './craftbook-collapse.js';
export * from './craftbook-doc.js';
export * from './skills/index.js';
export * from './execution-density.js';
export * from './plan/plan-document.js';
export * from './mentions.js';
export * from './pnpm-invocation.js';
export * from './net-retry.js';

/**
 * The package version is embedded into health responses and logs so clients
 * can surface it in the UI.
 */
export const GEZEL_VERSION = '0.0.0';

/**
 * Default ISO-timestamp helper so every package produces the same shape.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
