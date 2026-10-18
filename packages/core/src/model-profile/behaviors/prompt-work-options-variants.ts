/**
 * Stage-2 ablations of `prompt.work-options-prelude`: each marker strips one
 * part of the pre-ranked note so an A/B can tell whether it earns its place.
 * They have no hooks; the chat manager reads them when it ranks the turn and
 * shapes the list with `shapeWorkOptions` before the prelude renders it.
 * Each needs `prompt.work-options-prelude` on as well. OFF by default; A/B
 * with `GEZEL_FORCE_BEHAVIORS`.
 */

import type { Behavior } from '../types.js';

export const PromptWorkOptionsNoGuidance: Behavior = {
  id: 'prompt.work-options-no-guidance',
  description:
    'Ablation of prompt.work-options-prelude: the note lists only the options, without the guidance lines (answer in chat yourself, ask, hand off, write a recipe). No hooks; read by the chat manager.',
};

export const PromptWorkOptionsOrdinal: Behavior = {
  id: 'prompt.work-options-ordinal',
  description:
    'Ablation of prompt.work-options-prelude: options are numbered "1", "2", … and start_work takes the number, instead of semantic ids like type:trip-planner. No hooks; read by the chat manager.',
};

export const PromptWorkOptionsTopOne: Behavior = {
  id: 'prompt.work-options-top-one',
  description:
    'Ablation of prompt.work-options-prelude: the note offers only the best option, keeping the guidance lines. No hooks; read by the chat manager.',
};
