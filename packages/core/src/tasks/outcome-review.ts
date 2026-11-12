/**
 * A review of an outcome task's deliverables after its contract checks pass
 * (`TaskStrategyOptions.review`). The contract checks are literal; a review
 * asks what they cannot: whether the work actually answers the request.
 *
 * Both review modes share one focus list and one cap on findings, so a
 * comparison between them measures who reads the work (the owner in its own
 * conversation, or a new session of the same model with no transcript), not
 * what they were told to look for.
 */
import type { CraftbookContract } from '../schemas/craftbook-contract.js';
import { renderTaskContractBlock } from './prompt-context.js';

/** Review rounds per task: the review runs once, the fixes are re-checked by the contract. */
export const OUTCOME_REVIEW_MAX_ROUNDS = 1;

/** The most findings a review returns, most important first. */
export const OUTCOME_REVIEW_MAX_FINDINGS = 5;

const REVIEW_FOCUS = [
  'a name, number, date or quote the sources do not support, or a claim that contradicts them',
  'a part of the request or the contract that is missing, or covered too thinly to use',
  'an error: wrong arithmetic, a contradiction between two parts, code that would not run, a test that would fail',
  'anything the intended reader could not act on as written',
];

const REVIEW_IGNORE =
  'Ignore matters of style and anything the request and the contract do not ask for.';

function focusList(): string {
  return REVIEW_FOCUS.map((line) => `- ${line}`).join('\n');
}

function deliverableList(contract: CraftbookContract): string {
  return contract.deliverables
    .map((d) => `\`${d.path}\`${d.artifact ? ' (artifacts drawer)' : ''}`)
    .join(', ');
}

/** The contract as the owner saw it, without the owner-facing note about runtime checks. */
function contractForReview(contract: CraftbookContract): string {
  const block = renderTaskContractBlock(contract);
  const cut = block.lastIndexOf('\n\nThe runtime checks');
  return cut > 0 ? block.slice(0, cut) : block;
}

/**
 * How a finding is backed, and how a fix is made, for both modes. A same-model
 * reviewer also produces confident, false findings (a 27B claimed `kubectl
 * logs deploy/x` fails with several pods), and an owner told to fix each one
 * obeyed and made the work worse, or added a new invented detail while
 * removing one (review pilot, 2026-11-10). So a finding names its evidence,
 * and a fix removes or corrects, never adds.
 */
const EVIDENCE_RULE =
  'A problem counts only if you can quote the line in the deliverable (or name what is missing) and the evidence that shows it: a line from a source, or the words of the request or the contract it fails. Anything that rests only on your own knowledge is a doubt to check, not a fix.';
const FIX_RULE =
  'Fix by removing or correcting what is wrong, or by adding what is missing from what the sources state. Never add a fact, name, number, date or quote the sources do not state.';

/** The message that asks the owner to review its own work, in its own conversation. */
export function renderSelfReviewMessage(contract: CraftbookContract): string {
  return [
    `Before this task finishes, review your deliverables as an independent reviewer would. Open each one again: ${deliverableList(contract)}.`,
    `Look for:\n${focusList()}\n${REVIEW_IGNORE}`,
    EVIDENCE_RULE,
    `Note at most ${OUTCOME_REVIEW_MAX_FINDINGS} problems, the most important first, each naming one file and one concrete change. ${FIX_RULE} Keep everything else as it is, then call advance_task_step again. If you find nothing you can show this way, call advance_task_step again now.`,
  ].join('\n\n');
}

/** The brief for a reviewer in a new session, who has not seen the work being made. */
export function renderFreshReviewBrief(args: {
  taskRef: string;
  title: string;
  request: string;
  contract: CraftbookContract;
}): string {
  return [
    `Review the work another gezel produced for task ${args.taskRef}, "${args.title}". You did not write it, and you have not seen it being made. Read it with fresh eyes and report what keeps it from meeting the request and the contract below. Do not change, create or delete any file.`,
    `The request:\n\n${args.request.trim()}`,
    contractForReview(args.contract),
    `Open each deliverable with your read tools: ${deliverableList(args.contract)}. Open the sources and inputs it relies on wherever you need to check a claim.`,
    `Look for:\n${focusList()}\n${REVIEW_IGNORE}`,
    `${EVIDENCE_RULE} A file you could not open is not a problem with the work; leave it out.`,
    [
      'Answer in exactly this form, and write nothing else.',
      'When nothing material is wrong:',
      'VERDICT: PASS',
      'Otherwise:',
      'VERDICT: FAIL',
      '1. FIX `<file>` — "<the line you object to>" or <what is missing> — <what is wrong> — evidence: `<source>` "<the line that shows it>" — <what to change>',
      '2. CHECK `<file>` — "<the line you doubt>" — <why, from your own knowledge> — <what to verify>',
      `List at most ${OUTCOME_REVIEW_MAX_FINDINGS} problems, the most important first. Use FIX only with evidence quoted from a source, the request or the contract; anything else is CHECK.`,
    ].join('\n'),
  ].join('\n\n');
}

export interface OutcomeReviewVerdict {
  /** `unclear` when the reply had neither a verdict line nor numbered findings. */
  verdict: 'pass' | 'fail' | 'unclear';
  findings: string[];
}

/** Whether a finding claims evidence (`fix`) or rests on the reviewer's own knowledge (`check`). */
export function outcomeReviewFindingKind(finding: string): 'fix' | 'check' | 'unmarked' {
  const head = /^\W*(FIX|CHECK)\b/i.exec(finding)?.[1]?.toUpperCase();
  return head === 'FIX' ? 'fix' : head === 'CHECK' ? 'check' : 'unmarked';
}

const VERDICT_LINE = /^\W*VERDICT\W*:?\W*(PASS|FAIL)\b/im;
const FINDING_LINE = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/;

/**
 * Read a reviewer's reply. Numbered findings count only under a FAIL verdict,
 * or when the reply gave no verdict at all; a wrapped finding's continuation
 * lines join it.
 */
export function parseOutcomeReviewVerdict(reply: string): OutcomeReviewVerdict {
  const verdictMatch = VERDICT_LINE.exec(reply);
  const said = verdictMatch?.[1]?.toUpperCase();
  const body = verdictMatch ? reply.slice(verdictMatch.index + verdictMatch[0].length) : reply;
  const findings: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const item = FINDING_LINE.exec(line);
    if (item?.[1]) findings.push(item[1].trim());
    else if (findings.length > 0) findings[findings.length - 1] += ` ${line}`;
  }
  const capped = findings.slice(0, OUTCOME_REVIEW_MAX_FINDINGS);
  if (said === 'PASS') return { verdict: 'pass', findings: [] };
  if (said === 'FAIL' || capped.length > 0) {
    return capped.length > 0
      ? { verdict: 'fail', findings: capped }
      : { verdict: 'unclear', findings: [] };
  }
  return { verdict: 'unclear', findings: [] };
}

/** The reviewer's findings as the owner receives them. */
export function renderOutcomeReviewFindings(findings: readonly string[]): string {
  return [
    'A reviewer who did not see your work in progress read your deliverables against the request, the contract and the sources. The reviewer can be wrong, so check each finding before you change anything: open the line it quotes and the evidence it cites.',
    findings.map((finding, i) => `${i + 1}. ${finding}`).join('\n'),
    `Apply a FIX finding when its quote and its evidence hold up. Change a CHECK finding only where the sources or the request confirm it. ${FIX_RULE} Keep everything else as it is, then call advance_task_step again. If no finding holds up, call advance_task_step again without changes.`,
  ].join('\n\n');
}
