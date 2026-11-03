/**
 * What could make a craftbook better, read straight from its structure. The
 * craftbook editor's AI assist sees these at the start of every message and
 * in `craftbook_read`, so its suggestions start from the book rather than
 * from the model's guesses, and it can tell when a change cleared one.
 *
 * Only what the structure shows for certain, and only what the runtime does
 * not already repair: an unconsumed handoff is left out because stepwise
 * runs infer it (`inferredStepInputs`).
 */
import { contractLintProblems } from './craftbook-contract-lint.js';
import { mainContentParamKey, paramAsksUser } from './craftbook-launch.js';
import type { Craftbook, CraftbookStep } from './schemas/craftbook.js';

export interface CraftbookCheckupFinding {
  /** Stable kind, e.g. `step-check`. */
  kind: string;
  /** The step it is about, when it is about one. */
  stepId?: string;
  message: string;
}

export type CraftbookCheckupInput = Pick<
  Craftbook,
  'description' | 'triggers' | 'paramSchema' | 'contract' | 'defaultAssignee'
> & { steps: readonly CraftbookStep[] };

const PATH_PARAM = /(?:path|dir|directory|folder)$/i;

function askedProperties(paramSchema: unknown): Array<[string, Record<string, unknown>]> {
  if (!paramSchema || typeof paramSchema !== 'object' || Array.isArray(paramSchema)) return [];
  const properties = (paramSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      !!entry[1] &&
      typeof entry[1] === 'object' &&
      !Array.isArray(entry[1]) &&
      paramAsksUser(entry[1], entry[0]),
  );
}

function isFreeText(property: Record<string, unknown>): boolean {
  return property.type === 'string' && !property.enum && !property.input;
}

export function craftbookCheckup(book: CraftbookCheckupInput): CraftbookCheckupFinding[] {
  const findings: CraftbookCheckupFinding[] = [];
  if (!book.description?.trim()) {
    findings.push({
      kind: 'description',
      message:
        'The book has no description. Say what it makes and when to use it: the launcher and the Meester show it when they offer the book.',
    });
  }
  if (!book.triggers?.some((trigger) => trigger.trim())) {
    findings.push({
      kind: 'triggers',
      message:
        'The book has no trigger phrases, so chat offers it only when someone names it. Add a few things a person would type when they want it.',
    });
  }

  const asked = askedProperties(book.paramSchema);
  if (
    asked.some(([, property]) => isFreeText(property)) &&
    !mainContentParamKey(book.paramSchema)
  ) {
    findings.push({
      kind: 'main-input',
      message:
        'No input takes the person\'s request. If one of them is the request itself, mark it `"fromMessage": true` so a chat launch fills it from their message.',
    });
  }
  for (const [key, property] of asked) {
    if (!PATH_PARAM.test(key) || property.input || property.default !== undefined) continue;
    findings.push({
      kind: 'path-input',
      message: `Input \`${key}\` asks the person to type a path. Give it a default (such as \`{{task.dir}}\`) or an \`input\` picker instead.`,
    });
  }

  for (const step of book.steps) {
    if (step.assignee?.kind === 'user') continue;
    const named = `Step "${step.name}"`;
    if (
      book.steps.length > 1 &&
      !step.suggestedRole?.trim() &&
      !step.suggestedGezelId &&
      !step.assignee &&
      !book.defaultAssignee
    ) {
      findings.push({
        kind: 'step-role',
        stepId: step.id,
        message: `${named} has no role, so whoever owns the task does it. Name the kind of gezel it needs (a writer, a researcher, a reviewer).`,
      });
    }
    if (!step.prompt?.trim() && !step.description?.trim()) {
      findings.push({
        kind: 'step-prompt',
        stepId: step.id,
        message: `${named} has no prompt, so its assignee knows only the step's name. Say what to read, what to do and what to write.`,
      });
    }
    if (!step.gate && !step.advanceWhen) {
      findings.push({
        kind: 'step-check',
        stepId: step.id,
        message: `${named} has no completion check, so it ends whenever its assignee says it is done. Give it a deliverable or a gate that proves the work.`,
      });
    }
  }

  if (book.contract) {
    for (const problem of contractLintProblems(book.contract)) {
      findings.push({ kind: 'contract', message: `Contract: ${problem}.` });
    }
  }
  return findings;
}
