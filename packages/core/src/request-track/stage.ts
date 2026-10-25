import type { CraftbookStep, CraftbookStepStage } from '../schemas/craftbook.js';
import { normalizeStepGate } from '../schemas/gate.js';
import { isLoopBackStep } from '../tasks/prompt-context.js';

type StageStep = Pick<
  CraftbookStep,
  'id' | 'name' | 'next' | 'branches' | 'gate' | 'terminal' | 'stage'
>;

/** Leading steps that take the request in: "Scope the week", "Write the brief", `offer-scope`. */
const INTAKE_ID =
  /^(scope|brief|intake|plan|planning|criteria|requirements|clarify|frame|triage)$|-scope$|^scope-/;
const INTAKE_NAME =
  /^(scope|define|clarify|understand|frame|plan|triage)\b|\b(scope|brief|intake)$/i;

/**
 * Steps that check what was made. Only after something was made: in
 * "scope > review > report" the review is the work itself.
 */
const CHECK_ID =
  /^(evaluate|evaluation|review|verify|validate|check|qa|test|tests|polish|proof|proofread|repair|revise|critique|approve|approval|sign-?off|finish|done|halt|wrap-?up|needs-user|owner-review)$/;
const CHECK_NAME =
  /^(evaluate|review|verify|validate|check|test|polish|proofread|repair|revise|critique|approve|sign off|finish|escalate|re-measure)\b/i;

function routesRejectionBack(step: StageStep, steps: readonly StageStep[]): boolean {
  if (!step.gate) return false;
  const target = normalizeStepGate(step.gate).onReject;
  if (!target) return false;
  const at = steps.findIndex((s) => s.id === step.id);
  const to = steps.findIndex((s) => s.id === target);
  return to >= 0 && to < at;
}

/**
 * Each step's stage, in book order. A step's own `stage` wins. Otherwise:
 * leading scope/brief steps take the request in; once something has been
 * made, a review, verify, repair or finish step, a step that loops back, a
 * gate that sends rejections back, and the terminal step check it; every
 * other step makes it.
 */
export function craftbookStepStages(
  steps: readonly StageStep[],
): ReadonlyMap<string, CraftbookStepStage> {
  const out = new Map<string, CraftbookStepStage>();
  let made = false;
  for (const step of steps) {
    // Older and hand-written task records can lack either field.
    const id = step.id ?? '';
    const name = (step.name ?? '').trim();
    let stage: CraftbookStepStage;
    if (step.stage) stage = step.stage;
    else if (!made && (INTAKE_ID.test(id) || INTAKE_NAME.test(name))) {
      stage = 'intake';
    } else if (
      made &&
      (CHECK_ID.test(id) ||
        CHECK_NAME.test(name) ||
        step.terminal === true ||
        isLoopBackStep(step, steps) ||
        routesRejectionBack(step, steps))
    ) {
      stage = 'check';
    } else stage = 'make';
    if (stage === 'make') made = true;
    out.set(id, stage);
  }
  return out;
}

/** {@link craftbookStepStages} for one step; `make` when it is not in `steps`. */
export function stepStage(step: StageStep, steps: readonly StageStep[]): CraftbookStepStage {
  return craftbookStepStages(steps).get(step.id) ?? step.stage ?? 'make';
}

/** Verbs whose last consonant doubles before -ing. */
const DOUBLING = new Set([
  'map',
  'plan',
  'scan',
  'run',
  'log',
  'set',
  'put',
  'get',
  'cut',
  'stop',
  'tag',
  'pin',
  'dig',
]);

/**
 * First words that are not verbs although they open step names ("Visual
 * design", "Copywriting", "Summary"); such a name gets the stage's phrase.
 */
const NOT_VERBS = new Set([
  'visual',
  'game',
  'offer',
  'data',
  'schema',
  'rules',
  'spec',
  'flow',
  'style',
  'content',
  'voice',
  'ad',
  'editorial',
  'copywriting',
  'summary',
  'halted',
  'dry-run',
  'final',
  'first',
  'ui',
  'ux',
  'api',
  'brand',
  'chart',
  'slide',
  'threat',
  'key',
  'aesthetic',
  'dimension',
  'criteria',
  'hypothesis',
  'keyword',
  'question',
  'report',
  'inventory',
  'owner',
  'needs',
]);

/** Verbs a person would not say about their own request, said plainly. */
const PLAIN_VERBS: Readonly<Record<string, string>> = {
  scope: 'working out',
  evaluate: 'checking',
  triage: 'sorting',
  synthesize: 'pulling together',
  assemble: 'putting together',
};

/** "write" → "writing", "map" → "mapping", "verify" → "verifying". */
export function gerund(verb: string): string {
  const word = verb.toLowerCase();
  const plain = PLAIN_VERBS[word];
  if (plain) return plain;
  if (word.endsWith('ie')) return `${word.slice(0, -2)}ying`;
  if (word.endsWith('e') && !/(ee|ye|oe)$/.test(word)) return `${word.slice(0, -1)}ing`;
  const last = word.split('-').at(-1) ?? word;
  if (DOUBLING.has(last)) return `${word}${word.at(-1)}ing`;
  return `${word}ing`;
}

/**
 * What a step name can hold that a person should not read: code, template
 * tokens, file names, and words for the machinery. A name that needs any of
 * them removed reads broken without them ("writing to the"), so it gets the
 * stage's phrase instead.
 */
const MACHINERY =
  /`[^`]*`|\{\{[^}]*\}\}|\S+\.[a-z0-9]{2,5}\b|\b(craftbooks?|artifacts?|workspace|task|step|gate|manifest|json|markdown)\b/i;

/**
 * What the person reads while a step runs, as a present-participle phrase
 * for "Dejan is …": the step's own `personLabel`, else its name with the
 * verb turned ("Draft the invoices" → "drafting the invoices"), else the
 * stage's phrase. `noun` names the kind of file the work makes ("PDF").
 */
export function stepPersonLabel(
  step: Pick<CraftbookStep, 'name' | 'personLabel' | 'terminal'>,
  stage: CraftbookStepStage,
  opts: { noun?: string } = {},
): string {
  if (step.personLabel?.trim()) return step.personLabel.trim();
  const yours = opts.noun ? `your ${opts.noun}` : undefined;
  const cleaned = step.name
    .replace(/\bthe deliverable\b/gi, yours ?? 'the work')
    .replace(/\s+/g, ' ')
    .trim();
  const [first, ...rest] = cleaned.split(' ');
  if (first && rest.length > 0 && !NOT_VERBS.has(first.toLowerCase()) && !MACHINERY.test(cleaned)) {
    const phrase = `${gerund(first)} ${rest.join(' ')}`;
    if (phrase.length <= 60) return phrase;
  }
  if (step.terminal && stage === 'check') return 'wrapping up';
  if (stage === 'intake') return 'getting clear on what you need';
  if (stage === 'check') return yours ? `checking ${yours}` : 'checking the work';
  return yours ? `making ${yours}` : 'working on it';
}
