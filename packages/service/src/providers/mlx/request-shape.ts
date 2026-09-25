/**
 * The per-model shape of an MLX chat-completions request, shared by the send
 * loop and the prefix-cache warm.
 *
 * Both must render the same `[system][tools][transcript]` prefix the engine
 * caches: a warm whose grammar or template override differs from the real
 * turn's saves a prefix no turn can reuse. The rules lived as two hand-kept
 * copies, which is exactly how that drifts, so both call sites build here.
 *
 * - **Tuning.** Catalog manifests own sampling (`tuning.sampling` on each
 *   chat-model identity). With none set, mlx-vlm falls back to its own
 *   defaults, which on older versions is effectively greedy.
 * - **Tool grammar** (`tools.mlx-grammar`). The gezel MLX server builds an
 *   llguidance grammar from this hint plus the advertised `tools`, so a
 *   quantized model cannot hallucinate a tool name. Family-derived because
 *   Qwen's catalog `toolCallFormat` is the coarse `function-call`.
 * - **Template fix** (`tools.mlx-template-fix`). Swaps the model's stored
 *   Jinja template for a curated one at request time, no reinstall.
 */

import type { ToolsMlxTemplateFixConfig } from '../../model-profile/behaviors/tools-mlx-template-fix.js';
import type { ResolvedTuning } from '../../model-profile/index.js';
import { profileBehaviorConfig, profileHasBehavior } from '../../model-profile/runtime.js';
import { familyToToolGrammarHint } from '../../model-profile/tool-grammar.js';
import { MLX_TUNING_MAP, applyTuning } from '../../model-profile/tuning.js';
import type { ResolvedModelProfile } from '../../model-profile/types.js';

export function applyMlxRequestShape(
  body: Record<string, unknown>,
  deps: { tuning?: ResolvedTuning; profile?: ResolvedModelProfile },
  opts: { hasTools: boolean },
): void {
  if (deps.tuning) applyTuning(body, deps.tuning, MLX_TUNING_MAP);
  if (opts.hasTools && profileHasBehavior(deps.profile, 'tools.mlx-grammar')) {
    const grammarHint = familyToToolGrammarHint(deps.profile?.style);
    if (grammarHint) body.tool_grammar = grammarHint;
  }
  const templateFix = profileBehaviorConfig<ToolsMlxTemplateFixConfig>(
    deps.profile,
    'tools.mlx-template-fix',
  );
  if (templateFix?.template) body.chat_template_override = templateFix.template;
}
