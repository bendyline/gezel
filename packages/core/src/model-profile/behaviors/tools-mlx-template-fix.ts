/**
 * `tools.mlx-template-fix` — applies a curated per-family Jinja chat
 * template on the MLX engine, overriding the model's stored one at request
 * time (no reinstall).
 *
 * Upstream chat templates ship real bugs (Qwen 3.5/3.6: thinking-bleed
 * into tool turns, premature stop on XML tool calls, whole-turn history
 * wipes, parallel-call interleaving). This behavior carries a vetted,
 * gezel-authored replacement in its `template` config; the MLX provider
 * forwards it as the server's `chat_template_override`, and
 * `_build_prompt` renders with `apply_chat_template(..., chat_template=...)`.
 *
 * Config-required: enabling without a `template` is a no-op (resolution
 * drops it with a warning), so toggling it via `GEZEL_FORCE_BEHAVIORS` in
 * an A/B only bites when a manifest also supplies the template config —
 * keeping the control arm on the model's stock template.
 *
 * MLX engine only. The curated template CONTENT is authored + validated
 * against the live model separately (the schema/plumbing live here); do
 * NOT vendor community templates wholesale — audit for hidden control
 * strings first (e.g. the popular Qwen template's self-scrubbing
 * `<|think_off|>` magic string reachable from any system/user text).
 */

import { z } from 'zod';

import type { Behavior } from '../types.js';

const ToolsMlxTemplateFixConfigSchema = z.object({
  /** Curated Jinja template string applied in place of the model's stored one. */
  template: z.string().min(1),
});

export type ToolsMlxTemplateFixConfig = z.infer<typeof ToolsMlxTemplateFixConfigSchema>;

export const ToolsMlxTemplateFix: Behavior<ToolsMlxTemplateFixConfig> = {
  id: 'tools.mlx-template-fix',
  description:
    "Applies a curated per-family Jinja chat template via the MLX server's chat_template_override (no reinstall). Config carries the template string; enabling without it is a no-op. MLX engine only.",
  configSchema: ToolsMlxTemplateFixConfigSchema,
};
