import { valueGrounding, wordBand } from '@bendyline/gezel/checks';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { evaluateCraftbookGateChecks } from '../gates.ts';
import { findProjectIdByName, workspaceFromClient } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  authoredCraftbookSummaries,
  ensureAuthoringProject,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  progressBytes,
  sendMeesterKickoff,
} from './helpers.ts';

/**
 * craftbook-route-multi — the SELECT-THEN-EXECUTE probe: find the library
 * recipe that fits, and then actually run it to a deliverable that holds up.
 *
 * Axis: the handoff between selection and execution. The two other
 * selection probes (`craftbook-find-vs-create`, `dev-craftbook-routing`)
 * end at task creation on purpose, to cap the cost of measuring routing
 * alone. That leaves the more valuable half unmeasured — a model that
 * invokes the right recipe and then produces a shapeless artifact has not
 * done the job, and nothing in either scorecard suite noticed.
 *
 * Grading is deliberately two-layered. The ROUTE is graded structurally
 * (a task sourced from the bundled book, no book authored). The OUTPUT is
 * graded on class-level properties of a press release — a dateline, an
 * attributed quote, a boilerplate, a contact line, a sane length — never
 * on this scenario's vocabulary, per the anti-overtuning rule in
 * docs/eval-strategy.md. A real press release has those things whatever it
 * is announcing.
 *
 * The precision half comes from a stale draft seeded beside the brief,
 * carrying a superseded date and a wrong job title. Grounding against the
 * approved fact sheet rather than the convenient nearby draft is the same
 * discrimination `constrained-comms` measures, applied to a recipe run.
 */

const PROJECT_NAME = 'Fieldstone Launch Comms';

/** The only correct route. */
export const PRESS_RELEASE_CRAFTBOOK_ID = 'press-release';

export const FACTS_PATH = 'facts/announcement.md';
export const STALE_DRAFT_PATH = 'drafts/old-teaser.md';
export const RELEASE_PATH = 'out/press-release.md';

export const ANNOUNCEMENT_FACTS = `# Approved announcement facts

Do not use any figure or title that is not on this page.

- What: Fieldstone Goods opens its first permanent retail workshop.
- Where: Rotterdam, Netherlands.
- When: doors open 14 October 2026.
- Who: founded 2019 by Marijke Tenhoven, who is Fieldstone's **managing director**.
- Why: 68 percent of last year's orders came from within 40 km of the city,
  and the workshop lets customers watch pieces being finished.
- Scale: the workshop employs 11 people and holds open evenings twice a month.

## Approved quote (use verbatim, attributed to Marijke Tenhoven)

"We have spent seven years posting parcels to people who live twenty minutes away.
Now they can watch the glaze go on."

## Boilerplate (use verbatim as the final paragraph)

Fieldstone Goods makes handmade homeware in the Netherlands. Founded in 2019,
it sells mugs, notebooks, candles and totes to more than 40 independent shops.

## Press contact

Sanne de Ruiter, press@fieldstone.example, +31 10 555 0142
`;

/**
 * The trap. An abandoned teaser with a date that moved and a title that was
 * never right. Nothing marks it as stale except that it is in `drafts/`
 * and the approved facts say otherwise.
 */
export const STALE_DRAFT = `# Teaser (draft, not sent)

Fieldstone Goods opens its Rotterdam workshop on 30 September 2026.
Quote from Marijke Tenhoven, founder and CEO: "Come and see us."
`;

export const ROUTE_MULTI_MISSION_OBJECTIVES = [
  `Produce a send-ready press release at ${RELEASE_PATH} announcing the Rotterdam workshop,`,
  `using only the approved facts in ${FACTS_PATH}.`,
  'Set the work up as a task in this project, started from an existing library recipe for this',
  'kind of writing rather than assembled by hand, and drive that task to completion.',
].join(' ');

export const ROUTE_MULTI_KICKOFF_MESSAGE = [
  'We are opening our first permanent workshop in Rotterdam and I need something we can',
  'actually send to journalists — properly formatted, not a blog post.',
  `Everything you are allowed to state is in ${FACTS_PATH}: the date, the numbers, the approved`,
  'quote, our standard boilerplate and the press contact. There is an old abandoned teaser',
  `sitting in ${STALE_DRAFT_PATH} — ignore it, the date moved and the title in it was wrong.`,
  `Put the finished release at ${RELEASE_PATH}.`,
  'Do not write this freehand: check the recipe library for the one that covers this kind of',
  'writing and start the task from it, then see the task through until the release is actually',
  'written. Concretely — call suggest_craftbook with a short description of the job, invoke the',
  'best match, and then drive the resulting task to completion.',
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Announce the opening of Fieldstone Goods’ first permanent retail workshop in ' +
      'Rotterdam. The approved facts are fixed; an abandoned earlier teaser is not.',
    missionObjectives: ROUTE_MULTI_MISSION_OBJECTIVES,
  });
  for (const fixture of [
    { path: FACTS_PATH, content: ANNOUNCEMENT_FACTS },
    { path: STALE_DRAFT_PATH, content: STALE_DRAFT },
  ]) {
    await ctx.client.writeProjectWorkspaceFile(projectId, fixture);
  }
  ctx.log('[authoring:setup] seeded the approved fact sheet and the stale teaser decoy');
  await sendMeesterKickoff(ctx, projectId, ROUTE_MULTI_KICKOFF_MESSAGE);
}

/**
 * Class-level properties of a press release, checked against the seeded
 * facts. Exported so the unit test can prove a reference release passes and
 * a decoy-grounded one fails.
 */
export function checkPressRelease(markdown: string): {
  ok: boolean;
  score: number;
  scoreMax: number;
  failures: string[];
} {
  const failures: string[] = [];
  let score = 0;

  // 150, not 180: the reference release in authoring.test.ts carries every
  // required element — dateline, lede, body, attributed quote, boilerplate,
  // contact — in 167 words. A floor above what a complete-but-terse release
  // needs would grade verbosity rather than completeness.
  const band = wordBand(markdown, { min: 150, max: 700 });
  if (band.ok) score++;
  else failures.push(`press release length is off: ${band.detail} — aim for 150-700 words`);

  // A dateline is the one structural marker every press release carries.
  if (/rotterdam/i.test(markdown)) score++;
  else failures.push('no dateline naming the city the announcement is datelined from');

  // The approved quote, attributed. Match on a distinctive interior phrase
  // so ordinary re-wrapping and smart quotes do not fail a correct release.
  if (/watch the glaze go on/i.test(markdown)) score++;
  else failures.push('the approved quote does not appear — it must be used verbatim');
  if (/marijke\s+tenhoven/i.test(markdown)) score++;
  else failures.push('the quote is not attributed to the named spokesperson');

  if (/more than 40 independent shops/i.test(markdown)) score++;
  else failures.push('the approved boilerplate paragraph is missing from the end of the release');

  if (/press@fieldstone\.example/i.test(markdown)) score++;
  else failures.push('no press contact line — journalists need someone to call');

  // Grounding: the approved date and title must win over the stale draft's.
  const grounding = valueGrounding(markdown, [
    {
      id: 'opening-date',
      label: 'opening date',
      required: ['14 october', 'october 14', '2026-10-14'],
      forbidden: ['30 september', 'september 30'],
    },
    {
      id: 'spokesperson-title',
      label: 'spokesperson title',
      required: ['managing director'],
      forbidden: ['\\bceo\\b'],
    },
  ]);
  if (grounding.ok) score++;
  else {
    failures.push(
      `the release is grounded in the stale teaser rather than the approved facts: ${grounding.detail}`,
    );
  }

  return { ok: failures.length === 0, score, scoreMax: 7, failures };
}

const TOTAL_CHECKS = 11;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const failures: string[] = [];
  const authored = await authoredCraftbookSummaries(ctx.client, projectId);
  const found = await findTaskForCraftbookAnywhere(
    ctx.client,
    projectId,
    PRESS_RELEASE_CRAFTBOOK_ID,
  );

  let gradeProjectId = projectId;
  if (!found) {
    failures.push(
      `no task has been started from the bundled "${PRESS_RELEASE_CRAFTBOOK_ID}" recipe yet — search the recipe library for the one that covers writing an announcement for journalists and invoke it on this project`,
    );
  } else {
    gradeProjectId = found.projectId;
    if (found.task.status !== 'complete') {
      failures.push(
        `task ${found.task.ref} (from "${PRESS_RELEASE_CRAFTBOOK_ID}") has status "${found.task.status}" — drive it to completion`,
      );
    }
  }
  if (authored.length > 0) {
    failures.push(
      `a new craftbook was authored (${authored.map((cb) => cb.id).join(', ')}) — the library already covers this kind of writing; use the existing recipe`,
    );
  }

  const workspace = workspaceFromClient(ctx.client, gradeProjectId);
  const gateResult = await evaluateCraftbookGateChecks(
    [{ kind: 'minBytes', file: RELEASE_PATH, bytes: 600 }],
    workspace,
  );
  failures.push(...gateResult.failures);

  const release = await workspace.read(RELEASE_PATH);
  if (release !== null) failures.push(...checkPressRelease(release).failures);

  return finishAuthoringPoll(ctx, {
    scenarioId: routeMultiScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    // `bytes` is what the MODEL produced. It used to add the seeded facts
    // sheet, so the very first poll reported ~1000 bytes with nothing
    // written, the runner read that as an artifact to be stubborn about,
    // and the retry loop killed the trial at 13-14 minutes in three
    // consecutive rounds — each time telling the model its 0-byte
    // out/press-release.md "EXISTS" and not to recreate it.
    bytes: progressBytes(release),
    deliverableMissing: release === null || release.length === 0,
    repairPath: RELEASE_PATH,
    repairDirective: [
      'CRAFTBOOK_ROUTE_AND_RUN_REPAIR: this eval grades BOTH the route and the release.',
      'Use suggest_craftbook / invoke_craftbook to start the task from the existing library',
      'recipe for announcements to journalists — do not author a new recipe and do not write the',
      'release freehand. Then execute the task through to completion.',
      `Every fact must come from ${FACTS_PATH}, not from ${STALE_DRAFT_PATH}: the opening date`,
      'moved and the title in that draft was never correct. Use the approved quote verbatim,',
      'attribute it to the named spokesperson, end with the approved boilerplate, and include the',
      'press contact.',
    ].join(' '),
    successReason:
      'invoked the bundled press-release recipe, ran the task to completion, and the release carries a dateline, the attributed approved quote, the boilerplate, a contact, and the approved facts rather than the stale draft',
  });
}

export const routeMultiScenario: EvalScenario = {
  id: 'craftbook-route-multi',
  description:
    'Select-then-execute probe: a plain announcement brief must route to the bundled ' +
    'press-release recipe AND the resulting task must run to completion, producing a release ' +
    'that carries the class-level markers (dateline, attributed approved quote, boilerplate, ' +
    'contact) and is grounded in the approved facts rather than a seeded stale draft.',
  prompt: ROUTE_MULTI_KICKOFF_MESSAGE,
  evidenceTexts: [ROUTE_MULTI_KICKOFF_MESSAGE, ROUTE_MULTI_MISSION_OBJECTIVES, ANNOUNCEMENT_FACTS],
  requiredPromptEvidence: [
    { signal: 'opening-date', pattern: /14 october 2026/ },
    { signal: 'spokesperson-title', pattern: /managing director/ },
    { signal: 'approved-quote', pattern: /watch the glaze go on/ },
    { signal: 'boilerplate', pattern: /more than 40 independent shops/ },
    { signal: 'press-contact', pattern: /press@fieldstone\.example/ },
  ],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 80 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  setup,
  successCheck,
};
