/**
 * `tools.work-routing` — gives a coordinator one routing surface:
 * `suggest_work` (every kind of next step, ranked on the daemon) and
 * `start_work` (start the option chosen, by id). The Meester's older routing
 * tools — `list_craftbooks`, `suggest_craftbook`, `invoke_craftbook`,
 * `start_project`, `start_project_from_type`, `list_project_types` — leave
 * its roster while this is on.
 *
 * Rationale: a small model asked to pick the KIND of work before calling
 * anything routes badly, and `suggest_craftbook`'s answer handed that choice
 * back as a paragraph of conditions. Here the alternatives — a project
 * instead of a recipe, answering instead of starting anything — are items in
 * one list, and the model copies an id.
 *
 * The roster swap lives in `computeToolAllowlist` (`workRouting`, threaded
 * from `profileHasBehavior(profile, 'tools.work-routing')`). The per-turn
 * note below replaces the two preludes that stand down with the old tools
 * (`prompt.meester-build-prelude`, `prompt.meester-craftbook-prelude`), on
 * exactly their triggers, so an A/B of this behavior against the baseline
 * compares tool surfaces rather than "a nudge versus no nudge". It defers to
 * `prompt.work-options-prelude` when that arm has already ranked the turn.
 * On by default for `small`, `medium` and `large` local models
 * (`SCOPED_DEFAULT_BEHAVIORS` in
 * registry.ts); elsewhere A/B it with `GEZEL_FORCE_BEHAVIORS=tools.work-routing`.
 */

import type { Behavior } from '../types.js';
import {
  explicitlyRequestsSeparateProject,
  looksLikeNewBuildRequest,
  namesDocumentDeliverable,
} from './prompt-meester-build-prelude.js';
import {
  looksLikeDataTransformRequest,
  looksLikeLibraryLookupRequest,
  looksLikeProcedureRequest,
} from './prompt-meester-craftbook-prelude.js';

const WORK_ROUTING_PRELUDE =
  '(System note for this turn: the person is asking for work. Make your first call `suggest_work` — it lists the ways to handle this request. Then call `start_work` with the id that fits, or answer in chat if it says the message is a question.)';

/** The turns the build and craftbook preludes claim, read the same way. */
function baselinePreludeWouldFire(text: string, projectId: string): boolean {
  const separate = explicitlyRequestsSeparateProject(text);
  const build =
    looksLikeNewBuildRequest(text) &&
    !(namesDocumentDeliverable(text) && !separate) &&
    (projectId === 'default' || separate);
  return (
    build ||
    looksLikeLibraryLookupRequest(text) ||
    looksLikeProcedureRequest(text) ||
    looksLikeDataTransformRequest(text)
  );
}

export const ToolsWorkRouting: Behavior = {
  id: 'tools.work-routing',
  description:
    "Replaces a coordinator's craftbook launcher and project macros with suggest_work (every kind of next step, ranked by policy) and start_work (start one option by id), with a per-turn note on the old preludes' triggers. On by default for small, medium and large local models.",

  userPromptPrelude(ctx) {
    if (!ctx.isMeester || ctx.messageOrigin !== 'direct-user') return null;
    if (!ctx.availableToolNames.includes('suggest_work')) return null;
    if (ctx.workOptions) return null;
    if (/^\s*\[Answer to:/i.test(ctx.userText)) return null;
    return baselinePreludeWouldFire(ctx.userText, ctx.projectId) ? WORK_ROUTING_PRELUDE : null;
  },
};
