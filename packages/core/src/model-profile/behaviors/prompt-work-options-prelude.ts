/**
 * `prompt.work-options-prelude` — run `suggest_work` for the coordinator
 * before the turn and put its list in the user-prompt slot, so the first
 * call can be `start_work` itself.
 *
 * Requires `tools.work-routing`. The chat manager computes the ranking only
 * while this behavior is on (it is async; prelude hooks are not) and hands
 * it in as `TurnCtx.workOptions`, the same way `libraryRecall` arrives.
 *
 * Silent for questions and for lists with nothing to start: a menu on
 * "what's 17 × 23?" is an invitation to over-route.
 *
 * On by default for `small`, `medium` and `large` local models
 * (`SCOPED_DEFAULT_BEHAVIORS` in
 * registry.ts).
 */

import { renderWorkOptionsPrelude } from '../../work-routing/render.js';
import type { Behavior } from '../types.js';

export const PromptWorkOptionsPrelude: Behavior = {
  id: 'prompt.work-options-prelude',
  description:
    "Ranks the coordinator's options for this message before the turn and prepends them, so the first call can be start_work. Requires tools.work-routing; silent for questions.",

  userPromptPrelude(ctx) {
    if (!ctx.workOptions) return null;
    if (ctx.messageOrigin !== 'direct-user' && ctx.messageOrigin !== 'question-answer') return null;
    if (!ctx.availableToolNames.includes('start_work')) return null;
    return renderWorkOptionsPrelude(ctx.workOptions, {
      ordinalIds: ctx.workOptionIds === 'ordinal',
    });
  },
};
