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
import { type CraftbookContract, contractSuitsReview } from '../schemas/craftbook-contract.js';
import type { OutcomeReviewMode, TaskReviewSetting, TaskStrategy } from '../task-strategy.js';
import { renderTaskContractBlock } from './prompt-context.js';

/**
 * The review a task gets when its request names none. All of these must hold:
 * the person has not turned reviews off (`config.taskReview`), the task runs
 * as an outcome (the only strategy measured; stepwise and generalist books
 * carry their own review steps), the book's work suits a review
 * ({@link contractSuitsReview}), and the model that will run the task was
 * measured to gain from one (`tuning.taskStrategy.review`). Decided once at
 * create and stamped on the task.
 *
 * A fresh review runs in a read-only session ({@link REVIEW_FOCUS_BUILTIN_TOOLS}):
 * told only not to edit, a fresh reviewer changed the project in all six
 * bug-fix trials of the counted test, twice undoing a correct fix.
 */
export function resolveOutcomeReview(args: {
  setting?: TaskReviewSetting | undefined;
  strategy: TaskStrategy;
  contract: Pick<CraftbookContract, 'deliverables' | 'reviewable'> | undefined;
  measured: OutcomeReviewMode | undefined;
}): OutcomeReviewMode | undefined {
  if (args.setting === 'off' || args.strategy !== 'outcome' || !args.measured) return undefined;
  return contractSuitsReview(args.contract) ? args.measured : undefined;
}

/**
 * The built-in tools of a fresh-eyes review session, whatever the reviewer's
 * role: reading the work, its sources and the project, and the factual
 * lookups a CHECK finding rests on. Nothing that writes, runs code, asks the
 * person or reaches another gezel. With no `write_file` on the roster, a
 * local engine also cannot put the turn in its write-the-file mode, which the
 * brief's quoted request ("write alert-rules.yaml …") once triggered.
 */
export const REVIEW_FOCUS_BUILTIN_TOOLS: readonly string[] = [
  'list_dir',
  'read_file',
  'read_files',
  'stat',
  'grep_files',
  'find_files',
  'diff_files',
  'list_artifacts',
  'read_artifact',
  'read_artifacts',
  'grep_artifact',
  'read_doc_as_markdown',
  'search_docs',
  'list_documents',
  'read_document',
  'search_documents',
  'list_tables',
  'describe_table',
  'query_table',
  'outline_file',
  'find_symbol',
  'read_symbol',
  'find_references',
  'search_code',
  'search',
  'wikipedia_search',
  'wikipedia_read',
  'web_search',
  'fetch_url',
];

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

/**
 * What a fix may never take away, for the fresh mode only (self-review was
 * measured with its own wording). Revisions that answered a finding by
 * deleting required content were the fresh mode's one repeated loss on Gemma
 * 4 E4B: a reviewer said to remove a required alert to meet a page budget and
 * the owner did, and an owner replaced the rows of an invoice table with bare
 * dates (review re-measurement, 2026-11-12). The contract checks passed both.
 */
const REVIEWER_KEEP_RULE =
  'A change corrects the part in place. Never ask to remove something the request or the contract asks for; when it breaks a rule, say how to change it.';
const OWNER_KEEP_RULE =
  'Change only what a finding names, in place, and keep every row, section and item it does not name. Never remove something the request or the contract asks for; if a finding says to, change that part so it meets the finding instead.';

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
    `Review the work handed in for task ${args.taskRef}, "${args.title}". You have not seen it being made and remember nothing of it. Read it with fresh eyes and report what keeps it from meeting the request and the contract below. You can open files but not change them; your reply is the review.`,
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
      REVIEWER_KEEP_RULE,
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
    `Apply a FIX finding when its quote and its evidence hold up. Change a CHECK finding only where the sources or the request confirm it. ${FIX_RULE} ${OWNER_KEEP_RULE} Then call advance_task_step again. If no finding holds up, call advance_task_step again without changes.`,
  ].join('\n\n');
}
