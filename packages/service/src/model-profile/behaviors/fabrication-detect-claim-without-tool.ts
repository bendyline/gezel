/**
 * `fabrication.detect-claim-without-tool` — catches the higher-order
 * fabrication that {@link FabricationDetectPastTense} deliberately
 * skips: the model called *some* tools this turn, but narrated
 * past-tense completion of an action whose required tool was NOT
 * among them. The wild-caught case: Cosima firing
 * a gezel-creation tool + `update_project` then claiming "I have
 * created the 'Space Invaders' project" — without ever calling
 * `create_project`. The plain past-tense detector exits early when
 * any tool succeeded; this one looks at *which* tools succeeded.
 *
 * Each rule pairs a concrete user-visible claim, the tools that
 * would justify it, and a corrective nudge phrased as a system
 * instruction. When fired, the chat manager re-prompts the model
 * with the nudge so it can self-recover within the same user-visible
 * turn.
 *
 * Migrated verbatim from `chat/hallucination-detector.ts`'s
 * `detectFabricatedToolClaim`.
 */

import type { Behavior, NudgeVerdict, TurnCtx } from '../types.js';

interface ClaimRule {
  pattern: RegExp;
  /** Any one of these tool names justifies the claim. */
  requiredTools: ReadonlyArray<string>;
  /** Short label used in logs. */
  claim: string;
  /** System message injected as the next turn's user-prompt-equivalent. */
  nudge: string;
}

// Past-tense verbs that all imply "the project / task / gezel now
// exists because I just made it." Wild-caught models pick whichever
// synonym they felt like that turn — Cosima/Gemma 26B emitted
// "initialized" in one bundle, "created" in another. Treat them as
// equivalent so the claim catalog isn't a vocabulary game.
const PROJECT_CREATION_VERBS = [
  'created',
  'initialized',
  'set\\s+up',
  'spun\\s+up',
  'started',
  'made',
  'bootstrapped',
  'kicked\\s+off',
].join('|');

const TASK_CREATION_VERBS = ['created', 'added', 'queued', 'set\\s+up'].join('|');

const GEZEL_CREATION_VERBS = [
  'created',
  'recruited',
  'added',
  'brought\\s+on',
  'set\\s+up',
  'spun\\s+up',
  'hired',
  'made',
].join('|');

// Past-tense verbs that imply "the file was written to disk":
const FILE_WRITE_VERBS = [
  'created',
  'written',
  'wrote',
  'saved',
  'implemented',
  'authored',
  'produced',
  'generated',
  'completed',
].join('|');

// Past-tense verbs that imply "the task has moved forward":
const TASK_ADVANCE_VERBS = [
  'advanced',
  'completed',
  'finished',
  'closed',
  'closed out',
  'marked',
  'moved',
].join('|');

const DELIVERABLE_GATE_VERBS = [
  'attached',
  'added',
  'set',
  'configured',
  'declared',
  'applied',
].join('|');

const CLAIM_RULES: ReadonlyArray<ClaimRule> = [
  {
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:` +
        PROJECT_CREATION_VERBS +
        String.raw`)\s+(?:the|a|an)\s+` +
        // Optional name placed between "the" and "project". Forms
        // observed in wild-caught fabrications:
        //   - "the project"                        — bare
        //   - "the new project"                    — adjective
        //   - "the fresh project"                  — adjective
        //   - "the \"Space Invaders\" project"     — quoted
        //   - "the **Space Invaders** project"     — markdown bold
        //   - "the *Space Invaders* project"       — markdown italic
        //   - "the Space Invaders project"         — bare TitleCase 1-3 words
        //   - "the Space-Invaders project"         — TitleCase with hyphen
        // Each alternative ends with one or more spaces so the next
        // anchor (`project`) lands on a fresh word.
        String.raw`(?:` +
        String.raw`new\s+|fresh\s+|` +
        String.raw`"[^"]+"\s+|` +
        String.raw`\*\*[^*]+\*\*\s+|` +
        String.raw`\*[^*]+\*\s+|` +
        String.raw`(?:[A-Z][\w-]*\s+){1,3}` +
        String.raw`)?` +
        String.raw`project\b`,
      'i',
    ),
    requiredTools: ['create_project', 'start_project', 'start_job'],
    claim: 'created a project',
    nudge:
      'You told the user you created the project, but you did not call `create_project`, `start_project`, or `start_job` this turn. ' +
      'Call the right one now with the user-intended name and a real `about` + `missionObjectives` derived from their request.',
  },
  {
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:` +
        GEZEL_CREATION_VERBS +
        String.raw`)\s+(?:the|a|an)\s+(?:new\s+)?gezel\b`,
      'i',
    ),
    requiredTools: [
      'create_gezel',
      'ensure_gezel',
      'create_gezel_from_gilde',
      'start_project',
      'start_job',
    ],
    claim: 'created a gezel',
    nudge:
      'You told the user you created a gezel, but you did not call `create_gezel`, `ensure_gezel`, ' +
      '`start_project`, or `start_job` this turn. Call the right one now.',
  },
  {
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:` +
        TASK_CREATION_VERBS +
        String.raw`)\s+(?:the|a|an)\s+(?:new\s+|first\s+)?task\b`,
      'i',
    ),
    requiredTools: ['create_task', 'start_project', 'start_job'],
    claim: 'created a task',
    nudge:
      'You told the user you created a task, but you did not call `create_task`, `start_project`, or `start_job` this turn. Call the right one now.',
  },
  {
    // Task-assignment fabrication — "I assigned the task to `dev-16a`"
    // without an `assign_task` (or assignee-bearing create/update) call.
    // Distinct from the voorman-assignment rule below: this is handing a
    // task to a worker, and the wild-caught failure (gemma4-e4b, "Space
    // War Arcade") paired it with a FABRICATED assignee id —
    // gezel ids are name slugs (`ravi`, `wanda`), never `dev-16a`. The
    // nudge tells the model to use the real id from `ensure_gezel` /
    // `list_gezels` rather than invent one. Anchored on "I <verb> … to"
    // so "assigned Vivian as your voorman" (no "to") falls through to
    // the voorman rule, not this one.
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:assigned|delegated|handed\s+(?:it\s+|the\s+task\s+)?off)\s+` +
        String.raw`(?:the\s+|this\s+|that\s+|it\s+|the\s+new\s+|the\s+first\s+)?(?:task\s+)?(?:over\s+)?to\b`,
      'i',
    ),
    requiredTools: ['assign_task', 'update_task', 'create_task', 'start_project', 'start_job'],
    claim: 'assigned a task',
    nudge:
      'You told the user you assigned the task to someone, but you did not call `assign_task` ' +
      '(or `create_task` / `update_task` with an `assignee`) this turn — and the assignee you named may not exist. ' +
      'Call the right one now, using the real gezel id returned by `ensure_gezel` or shown by `list_gezels`. ' +
      'Do not invent an id like `dev-16a`; gezel ids are name slugs (e.g. `ravi`).',
  },
  {
    // File-write fabrication — "I have created/written the index.html
    // file" without a `write_file` / `write_artifact` actually firing.
    // Wild-caught Gemma 26B output (3 of 3 timed-out tictactoe trials):
    //   "I have created the `index.html` file containing the full Tic-Tac-Toe game"
    //   "I have written the `index.html` file containing the complete Tic-Tac-Toe game"
    //   "I have successfully written the `index.html` file"
    //   "I have created the single-file HTML application for Browser Tic-Tac-Toe"
    //   "I have implemented the Tic-Tac-Toe game in a single `index.html` file"
    //
    // The pattern matches three shapes:
    //   (a) explicit extension:  `*.html|js|css|md|py|ts|tsx|...`
    //   (b) "the {…} file":      backtick or quote-wrapped name + "file"
    //   (c) "single-file {…}":   common Gemma framing for an HTML app
    //
    // The required tool list covers both surfaces a gezel can write
    // through: workspace `write_file` (raw fs) and project-scoped
    // `write_artifact`. Either justifies the claim.
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already|\s+successfully|\s+now)?` +
        String.raw`(?:\s+(?:successfully|already|just|now|finally))?` +
        String.raw`\s+(?:` +
        FILE_WRITE_VERBS +
        String.raw`)\b[^.\n]{0,160}?` +
        String.raw`(?:` +
        // (a) explicit extension in a literal or backticked filename
        String.raw`\b[\w.-]+\.(?:html?|jsx?|tsx?|css|md|json|py|sh|yaml|yml|txt)\b|` +
        // (b) "the {anything} file" with the word "file" as anchor
        String.raw`(?:the|a|an|this)\s+(?:[*"'\x60_]?[\w.-]+[*"'\x60_]?\s+)?file\b|` +
        // (c) "single-file" framing (Gemma 26B's favored phrasing)
        String.raw`single[-\s]file\b` +
        String.raw`)`,
      'i',
    ),
    requiredTools: ['write_file', 'write_artifact', 'append_to_file'],
    claim: 'wrote a file',
    nudge:
      'You told the user you wrote a file, but you did not call `write_file`, `write_artifact`, or `append_to_file` this turn. ' +
      'Call the right one now with the actual file path and the full file contents (or just the missing tail, for `append_to_file`). ' +
      'Do not narrate completion again until the tool returns success.',
  },
  {
    // Draft-plan gate fabrication — the model says it attached the
    // deliverable gates but never calls the structural tool that adds
    // them. Wild-caught (gemma4-e4b-q4, craftbook-plan eval): after
    // `set_task_status` rejected a draft with
    // explicit `set_step_deliverable(...)` repair calls, the model
    // replied "I have attached the required `index.html` deliverable
    // gate to all non-terminal steps" without any gate tool firing.
    pattern: new RegExp(
      String.raw`\bI(?:'ve|\s+have|\s+just|\s+already|\s+successfully|\s+now)?` +
        String.raw`(?:\s+(?:successfully|already|just|now|finally|required))?` +
        String.raw`\s+(?:` +
        DELIVERABLE_GATE_VERBS +
        String.raw`)\b[^\n]{0,220}?\b(?:deliverable|advanceWhen|gate|gates)\b[^\n]{0,220}?\b(?:step|steps|build|non-terminal|draft)\b`,
      'i',
    ),
    requiredTools: ['set_step_deliverable'],
    claim: 'attached deliverable gates',
    nudge:
      'You told the user you attached deliverable gates to draft/build steps, but you did not call `set_step_deliverable` this turn. ' +
      'Call `set_step_deliverable({ task: "<draft ref>", stepId: "<step id>", path: "<deliverable path>", kind: "<kind>" })` now for the exact ungated step id from the latest tool/check message. ' +
      'If several steps are listed, make one `set_step_deliverable` call per step. Do not call `set_task_status` or narrate completion until `set_step_deliverable` returns success.',
  },
  {
    // Task-advance fabrication — "I have advanced the task" / "marked
    // the task as complete" without `advance_task_step` or
    // `set_task_status` firing. Wild-caught:
    //   "I have advanced the task to complete the 'Plan and execute' phase."
    //   "I have marked the task as finished."
    //   "I have completed the task and marked the Tic-Tac-Toe game as finished."
    //   "I have verified the implementation of `index.html` and marked the task as complete."
    //   "Task `browser-tic-tac-toe/5` is now **complete**."
    //
    // Two pattern shapes:
    //   (a) "I {verb} the {something} task" — verb-first
    //   (b) "Task {ref} is now {complete|finished|advanced}" — third-person framing
    pattern: new RegExp(
      String.raw`(?:` +
        // (a) "I have advanced/completed/marked … the task …"
        String.raw`\bI(?:'ve|\s+have|\s+just|\s+already|\s+successfully|\s+now)?` +
        String.raw`(?:\s+(?:successfully|already|just|now|finally))?` +
        String.raw`\s+(?:` +
        TASK_ADVANCE_VERBS +
        String.raw`)\b[^.\n]{0,80}?\btask(?:s)?\b` +
        String.raw`|` +
        // (b) "the task is now complete/finished"
        String.raw`\btask\s+[\x60"'*_]*[\w/-]+[\x60"'*_]*\s+is\s+(?:now\s+)?(?:\*\*)?(?:complete|finished|done|advanced)(?:\*\*)?\b` +
        String.raw`|` +
        // (c) "marked the task as (finished|complete)"
        String.raw`\bmarked\s+(?:the\s+)?(?:[\x60"'*_]?[\w/-]+[\x60"'*_]?\s+)?task\b[^.\n]{0,40}?\bas\s+(?:complete|finished|done)\b` +
        String.raw`)`,
      'i',
    ),
    requiredTools: ['advance_task_step', 'set_task_status'],
    claim: 'advanced or completed a task',
    nudge:
      'You told the user the task moved forward (advanced/completed/marked finished), but you did not call ' +
      '`advance_task_step` or `set_task_status` this turn. Call the right one now — and only narrate ' +
      'completion AFTER the tool returns success.',
  },
  {
    // Matches both shapes of "I assigned the voorman" claim:
    //   - "I assigned the voorman"      — bare
    //   - "I set Vivian as the voorman" — name-then-role
    //   - "I assigned **Vivian** as your voorman" — markdown name + possessive
    // The first sub-alternative covers the direct form; the second
    // accepts up to four words (the gezel name with optional markdown
    // marks) plus "as your/the/our" between the verb and "voorman".
    pattern:
      /\bI(?:'ve|\s+have|\s+just|\s+already)?\s+(?:assigned|set)\s+(?:(?:the\s+)?voorman\b|(?:[*"`_]*[\w'-]+[*"`_]*\s+){1,4}as\s+(?:the|your|our|a|an)\s+voorman\b)/i,
    requiredTools: ['update_project', 'start_project'],
    claim: 'assigned the voorman',
    nudge:
      'You told the user you set the voorman, but you did not call `update_project` ' +
      "(or it didn't succeed — re-check the tool result). Call it now with the new gezel's id.",
  },
];

export interface ClaimVerdict {
  fabricated: boolean;
  claim: string | null;
  requiredTools: ReadonlyArray<string>;
  nudge: string | null;
}

/**
 * Match the assistant text against the curated claim catalog.
 * Returns `fabricated: true` when a claim's pattern matches AND none
 * of its required tools fired successfully this turn.
 */
export function detectFabricatedToolClaim(args: {
  text: string;
  firedToolNames: ReadonlyArray<string>;
}): ClaimVerdict {
  const fired = new Set(args.firedToolNames);
  for (const rule of CLAIM_RULES) {
    if (!rule.pattern.test(args.text)) continue;
    const justified = rule.requiredTools.some((t) => fired.has(t));
    if (justified) continue;
    return {
      fabricated: true,
      claim: rule.claim,
      requiredTools: rule.requiredTools,
      nudge: rule.nudge,
    };
  }
  return { fabricated: false, claim: null, requiredTools: [], nudge: null };
}

export const FabricationDetectClaimWithoutTool: Behavior = {
  id: 'fabrication.detect-claim-without-tool',
  description:
    'Detects past-tense narration ("I have created the project") that names an action whose required tool wasn\'t called this turn. Re-prompts the model with a corrective nudge so it can self-correct within the same user turn.',

  postTurnDetector(ctx: TurnCtx): NudgeVerdict | null {
    const firedToolNames = ctx.drained
      .filter((d) => d.success || isRecoverableSavedDraftToolCall(d))
      .map((d) => d.name);
    const claim = detectFabricatedToolClaim({
      text: ctx.assistantContent,
      firedToolNames,
    });
    if (!claim.fabricated || !claim.nudge) return null;
    return {
      reason: `claimed "${claim.claim}" without calling [${claim.requiredTools.join(', ')}]`,
      promptForNextTurn: claim.nudge,
    };
  },
};

function isRecoverableSavedDraftToolCall(call: TurnCtx['drained'][number]): boolean {
  return (
    call.name === 'write_file' &&
    call.success === false &&
    typeof call.errorMessage === 'string' &&
    /Invalid first draft\s+\S+\s+was saved anyway so you can continue with/i.test(call.errorMessage)
  );
}
