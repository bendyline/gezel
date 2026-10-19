/**
 * `prompt.work-options-question-note` — on a turn the work ranking reads as
 * a question, tell the coordinator to answer it itself. The options prelude
 * is silent for questions (a menu there invites over-routing), which left
 * those turns with no steer at all, and Qwen 3.5 9B handed some to a
 * researcher with `message_gezel` instead of answering.
 *
 * Requires `prompt.work-options-prelude`, which computes the ranking this
 * reads. OFF by default; A/B with `GEZEL_FORCE_BEHAVIORS`.
 */

import { renderQuestionNote } from '../../work-routing/render.js';
import type { Behavior } from '../types.js';

export const PromptWorkOptionsQuestionNote: Behavior = {
  id: 'prompt.work-options-question-note',
  description:
    'On a turn the work ranking reads as a question, a one-line note: look up what you need, answer in chat yourself, and do not start new work or pass it to another gezel. Requires prompt.work-options-prelude.',

  userPromptPrelude(ctx) {
    if (!ctx.workOptions?.question) return null;
    if (ctx.messageOrigin !== 'direct-user' && ctx.messageOrigin !== 'question-answer') return null;
    if (!ctx.availableToolNames.includes('start_work')) return null;
    return renderQuestionNote(ctx.workOptions);
  },
};
