import {
  type SuggestWorkResult,
  type WorkActionOption,
  type WorkGuidance,
  workOptionId,
} from '../schemas/work-options.js';
import { looksLikeQuestionOrAdvice } from './question.js';

/**
 * Turn per-kind candidates into the ordered options `suggest_work` returns.
 *
 * The order is a fixed policy, never a blended score: craftbook cosines,
 * project-type tag hits and recurring matches live on different scales, and
 * a sum of them would only decide which scale happened to run hot. Each kind
 * arrives here already past its own floor, ranked within itself. The caller
 * (the service gatherer) owns floors because they are embedder-specific.
 *
 *   exact format → project type → new project (a build from Default)
 *     → craftbook → recurring → task here → author → ask → self
 *
 * An exact-format route returns that one option and nothing else: a medium
 * model handed the exact call plus a menu browsed the menu and lost the
 * route, so a resolved call stays alone.
 */

export const MAX_WORK_OPTIONS = 4;

export interface WorkCraftbookCandidate {
  craftbookId: string;
  name: string;
  description?: string;
  setupRequired?: string[];
  /** Invocation params read from the message. */
  params?: Record<string, string>;
  /** Clears the stricter floor that lets a book stand beside a question. */
  strong?: boolean;
}

export interface WorkRankInput {
  request: string;
  projectId: string;
  /** The Default project, where a new project is a fresh destination. */
  inDefault: boolean;
  /** The request asks for work at all (turn-intent `looksLikeWorkRequest`). */
  workRequest: boolean;
  /** An exact-format route, already resolved to its book. */
  exact?: WorkCraftbookCandidate;
  /** Types the brief names, best first. Ignored outside Default unless a new project was asked for. */
  projectTypes?: Array<{ typeId: string; name: string; description?: string }>;
  craftbooks?: WorkCraftbookCandidate[];
  recurring?: Array<{ key: string; name: string; description?: string; pause: boolean }>;
  /** The message asks to build or start something substantive. */
  newProject?: boolean;
  /** The message asks for a separate project even from inside one. */
  separateProject?: boolean;
  /** A repeatable procedure ("every month", "a recipe for"). */
  procedure?: boolean;
  /** Implementation work (code, a site, an app). */
  implementation?: boolean;
  /** On-roster tools that serve an answer the coordinator gives itself. */
  selfTools?: string[];
  /** The on-roster delegate for implementation inside an existing project. */
  specialist?: { role: string; tool: string };
}

export function rankWorkOptions(input: WorkRankInput): SuggestWorkResult {
  const base = { schemaVersion: 1 as const, request: input.request, projectId: input.projectId };

  if (input.exact) {
    return {
      ...base,
      question: false,
      options: [craftbookOption(input.exact, true)],
      guidance: [],
    };
  }

  const question = looksLikeQuestionOrAdvice(input.request) || !input.workRequest;
  const newDestination = input.inDefault || input.separateProject === true;
  const options: WorkActionOption[] = [];
  const push = (option: WorkActionOption): void => {
    if (options.length < MAX_WORK_OPTIONS && !options.some((o) => o.id === option.id)) {
      options.push(option);
    }
  };

  // A request to build something from Default gets its own project, not a
  // recipe run inside Default: the project path decides the kickoff's
  // structure from the best-matching recipe itself. The recipes are therefore
  // left off the list, not just placed after the project — listed second,
  // "Branding Website — build a small marketing website" still beat a generic
  // "A new project" on 10 of 12 build probes across both small models, which
  // pick the option that describes the request best, whatever its position
  // (S1 and S1b, 2026-10-17).
  const buildFromDefault = !question && newDestination && input.newProject === true;
  // The same holds for a request a project type fits: the type is the whole
  // job (its own lead, board and tools) and a recipe beside it is one piece
  // of it. Qwen 3.5 9B took `invoice-run` over Freelance Office and
  // `weekly-menu-plan` over Meal Planner, listed after them, where the
  // baseline went to the type (S1). Types pass their own precision floors
  // (a tag no other type has, or a clear lead on meaning) before they get here.
  const typeFits = !question && newDestination && (input.projectTypes?.length ?? 0) > 0;
  const craftbooks =
    buildFromDefault || typeFits
      ? []
      : (input.craftbooks ?? []).filter((c) => !question || c.strong);
  if (!question && newDestination) {
    for (const type of input.projectTypes ?? []) {
      push({
        kind: 'project-type',
        id: workOptionId({ kind: 'project-type', typeId: type.typeId }),
        typeId: type.typeId,
        name: type.name,
        ...(type.description ? { description: type.description } : {}),
      });
    }
  }
  if (buildFromDefault) {
    push({
      kind: 'new-project',
      id: 'new-project',
      name: 'A new project to build this in',
      description:
        'Its own workspace, a lead suited to the goal, and a kickoff task with a plan to follow.',
    });
  }
  for (const book of craftbooks) push(craftbookOption(book, false));
  if (!question) {
    for (const item of input.recurring ?? []) {
      push({
        kind: 'recurring',
        id: workOptionId({ kind: 'recurring', key: item.key, pause: item.pause }),
        key: item.key,
        pause: item.pause,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      });
    }
    if (!input.inDefault && !input.separateProject) {
      push({
        kind: 'task-here',
        id: 'task-here',
        projectId: input.projectId,
        name: 'A task in this project',
        description: 'A general plan-and-do task for the current crew.',
      });
    }
  }

  const guidance: WorkGuidance[] = [];
  const selfVerdict: WorkGuidance = { kind: 'self', tools: (input.selfTools ?? []).slice(0, 6) };
  if (question) guidance.push(selfVerdict);
  if (!question && input.implementation && !input.inDefault && input.specialist) {
    guidance.push({ kind: 'specialist', ...input.specialist });
  }
  if (!question && input.procedure && !craftbooks.some((c) => c.strong)) {
    guidance.push({ kind: 'author' });
  }
  if (!question && options.length === 0 && !input.procedure) {
    guidance.push(askVerdict(input.inDefault));
  }
  if (!question) guidance.push(selfVerdict);

  return { ...base, question, options, guidance };
}

function craftbookOption(book: WorkCraftbookCandidate, exact: boolean): WorkActionOption {
  return {
    kind: 'craftbook',
    id: workOptionId({ kind: 'craftbook', craftbookId: book.craftbookId }),
    craftbookId: book.craftbookId,
    name: book.name,
    ...(book.description ? { description: book.description } : {}),
    ...(exact ? { exact: true } : {}),
    ...(book.setupRequired && book.setupRequired.length > 0
      ? { setupRequired: book.setupRequired }
      : {}),
    ...(book.params && Object.keys(book.params).length > 0 ? { params: book.params } : {}),
  };
}

function askVerdict(inDefault: boolean): WorkGuidance {
  return inDefault
    ? {
        kind: 'ask',
        question: 'What would you like help with?',
        choices: ['A document or report', 'A project to work on over time', 'Just talk it through'],
      }
    : {
        kind: 'ask',
        question: 'What should the crew do here?',
        choices: ['A task in this project', 'Just talk it through'],
      };
}
