import type { SuggestWorkResult, WorkActionOption, WorkGuidance } from '../schemas/work-options.js';

/**
 * The model-facing text of a `suggest_work` result.
 *
 * Every alternative is a line of its own — an option to start, or a verdict
 * to act on with the coordinator's own tools — instead of a paragraph of
 * conditions to reason through. Small models pick an item from a list far
 * more reliably than they decide to pick none of a list.
 */

const START_LINE =
  'Call start_work({ option: "<id>" }) with the id that fits. The request and destination are already bound; you do not need to restate them.';
const ORDINAL_START_LINE =
  'Call start_work({ option: "<number>" }) with the number of the one that fits. The request and destination are already bound; you do not need to restate them.';

export interface WorkOptionsRenderOptions {
  /**
   * Number the options and ask `start_work` for the number, instead of
   * naming each option's id (the `prompt.work-options-ordinal` ablation).
   */
  ordinalIds?: boolean;
}

export function renderSuggestWorkResult(
  result: SuggestWorkResult,
  opts: WorkOptionsRenderOptions = {},
): string {
  const [first] = result.options;
  if (first?.kind === 'craftbook' && first.exact) {
    return [
      `Exact match: [${first.id}] ${first.name}${first.description ? ` — ${shortDescription(first.description)}` : ''}.${setupNote(first)}`,
      `Call start_work({ option: "${first.id}" }) now.`,
    ].join('\n');
  }

  const lines: string[] = [];
  const questionFirst = result.question && result.guidance[0]?.kind === 'self';
  if (questionFirst) {
    lines.push(guidanceLine(result.guidance[0]!, true));
    if (result.options.length > 0) {
      lines.push('Only if the person actually asked for work:');
    }
  }
  result.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${optionLine(option, opts.ordinalIds === true)}`);
  });
  if (result.options.length > 0) lines.push(opts.ordinalIds ? ORDINAL_START_LINE : START_LINE);
  for (const verdict of questionFirst ? result.guidance.slice(1) : result.guidance) {
    lines.push(guidanceLine(verdict, false));
  }
  return lines.join('\n');
}

/**
 * The pre-ranked block for a turn (the `prompt.work-options-prelude` arm):
 * the same list, framed as already looked up, so the first call can be
 * `start_work` itself. Null when there is nothing to start — a menu on
 * "what's 17 × 23?" only invites over-routing.
 */
export function renderWorkOptionsPrelude(
  result: SuggestWorkResult,
  opts: WorkOptionsRenderOptions = {},
): string | null {
  if (result.options.length === 0 || result.question) return null;
  return `(System note for this turn: suggest_work already ran for this message.\n${renderSuggestWorkResult(result, opts)})`;
}

/**
 * The one-line note for a turn that reads as a question (the
 * `prompt.work-options-question-note` arm). The options prelude stays silent
 * there, and Qwen 3.5 9B then handed questions to a researcher with
 * `message_gezel` instead of answering: 6 of 28 with the routing tools, 4 of
 * 29 without (2026-10-18). Null for anything that is not a question.
 *
 * It names no tools, and it says to look things up first. A list of helpers
 * ("consult_builder, consult_designer, consult_developer, search") crowded
 * out `list_tasks`; with no list, "answer it yourself in chat" read as
 * "answer without looking", and Gemma 4 E4B told the person no deck existed
 * while one was running — 0 of 5, against 5 of 5 without the note.
 */
export function renderQuestionNote(result: SuggestWorkResult): string | null {
  if (!result.question) return null;
  return '(System note for this turn: this reads as a question. Look up what you need with your own tools, then answer in chat yourself; do not start new work or pass it to another gezel.)';
}

const MAX_DESCRIPTION_CHARS = 140;

/**
 * A description's first sentence, at most 140 characters. Catalog
 * descriptions run to 600+ characters of routing advice for the authoring
 * model; four of them in full turned a short list into a wall of text.
 */
export function shortDescription(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s+|:\s+|\s+—\s+/)[0] ?? '';
  const clause = first.replace(/[.!?]+$/, '');
  return clause.length <= MAX_DESCRIPTION_CHARS
    ? clause
    : `${clause.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function optionLine(option: WorkActionOption, ordinal: boolean): string {
  const description = option.description ? ` — ${shortDescription(option.description)}` : '';
  const setup = option.kind === 'craftbook' ? setupNote(option) : '';
  const id = ordinal ? '' : `[${option.id}] `;
  return `${id}${option.name}${description}${setup}`;
}

function setupNote(option: Extract<WorkActionOption, { kind: 'craftbook' }>): string {
  return option.setupRequired && option.setupRequired.length > 0
    ? ` [needs setup: ${option.setupRequired.join(', ')}]`
    : '';
}

function guidanceLine(verdict: WorkGuidance, lead: boolean): string {
  switch (verdict.kind) {
    case 'self': {
      const tools =
        verdict.tools.length > 0 ? ` If you need help, you have ${verdict.tools.join(', ')}.` : '';
      return lead
        ? `This reads as a question: answer it yourself in chat. No start_work is needed.${tools}`
        : `If none of these fits, answer in chat yourself.${tools}`;
    }
    case 'ask':
      return `Nothing clearly fits yet. Ask the person with ask_user_question({ question: ${JSON.stringify(verdict.question)}, choices: ${JSON.stringify(verdict.choices)} }), then end your turn.`;
    case 'specialist':
      return `This is ${verdict.role} work in this project: you can hand it over with ${verdict.tool}.`;
    case 'author':
      return 'No existing recipe fits this repeatable procedure: read one with craftbook_read for the shape, save a new one with craftbook_write({ create: true, content }), then start it with start_work({ option: "craftbook:<new id>" }).';
  }
}
