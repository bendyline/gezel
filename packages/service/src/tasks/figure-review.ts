import {
  type ChatSession,
  type ReferencedFile,
  type Task,
  isUserCreatedProject,
  todayIso,
} from '@bendyline/gezel';
import { type FigureFinding, checkFigures, extractMoneyAmounts } from '@bendyline/gezel/checks';
import type { Store } from '../fs/store.js';
import { findOwnerThread } from './owner-thread.js';

/**
 * Checks the numbers in what a task made before the owner relies on them.
 *
 * A review run's crew sent the owner a quote with a $297 subtotal over items
 * that add up to $197, a Friday that was a Saturday, and two prices the owner
 * never gave. The review card and the wrap-up now carry what the checks
 * found, in the owner's words, and say plainly when the numbers hold up.
 *
 * Prices are checked against what the owner actually said: their own
 * messages in the launch thread, their notes and answers on the task, the
 * task description, the project's about and mission, and any price list or
 * menu in the project folder. Launch parameters are left out on purpose: a
 * model fills most of them, and an invented price there would launder itself
 * into "known".
 */

export interface FigureReview {
  /** One owner-facing sentence per problem. */
  problems: string[];
  /** What was checked at all, for an honest all-clear. */
  checked: Array<'sums' | 'prices' | 'dates'>;
}

export type FigureReviewStore = Pick<
  Store,
  | 'findSessionById'
  | 'readProjectArtifact'
  | 'readProjectWorkspaceFile'
  | 'listProjectWorkspace'
  | 'listTaskNotes'
  | 'listProjectQuestions'
  | 'getProject'
>;

const TEXT_OUTPUT_RE = /\.(md|markdown|txt|csv)$/i;
const PRICE_SOURCE_RE = /(price|pricing|menu|rates?|tarie?f)[^/]*\.(md|markdown|txt|csv)$/i;
const MAX_FILE_CHARS = 256 * 1024;
const MAX_PROBLEMS = 6;
const MAX_PRICES_NAMED = 4;

function ownerTyped(thread: ChatSession | null): string[] {
  if (!thread) return [];
  return thread.messages
    .filter((m) => m.role === 'user' && !m.origin && !m.from && !m.synthetic)
    .map((m) => m.content);
}

/** Every amount the owner supplied for this task. */
async function ownerAmounts(store: FigureReviewStore, task: Task): Promise<number[]> {
  const texts: string[] = [task.description ?? ''];
  texts.push(...ownerTyped(await findOwnerThread(store, task).catch(() => null)));
  const notes = await store.listTaskNotes(task.projectId, task.num).catch(() => []);
  texts.push(...notes.filter((n) => n.author.kind === 'user').map((n) => n.text));
  const questions = await store.listProjectQuestions(task.projectId).catch(() => []);
  for (const q of questions) {
    if (q.taskRef === task.ref && q.answer?.writeIn) texts.push(q.answer.writeIn);
  }
  const project = await store.getProject(task.projectId).catch(() => null);
  if (project) {
    texts.push(project.about ?? '', project.missionObjectives ?? '');
    // The Default project is a catch-all; its folder is no one's price list.
    if (isUserCreatedProject(project)) {
      const entries = await store.listProjectWorkspace(task.projectId).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory || !PRICE_SOURCE_RE.test(entry.name)) continue;
        const text = await store
          .readProjectWorkspaceFile(task.projectId, entry.path)
          .catch(() => null);
        if (text) texts.push(text.slice(0, MAX_FILE_CHARS));
      }
    }
  }
  return texts.flatMap((text) => extractMoneyAmounts(text));
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Check the text files a task made; null when there is nothing to check. */
export async function reviewTaskFigures(
  store: FigureReviewStore,
  task: Task,
  outputs: readonly ReferencedFile[],
  opts: { today?: string } = {},
): Promise<FigureReview | null> {
  const files = outputs.filter((file) => TEXT_OUTPUT_RE.test(file.path));
  if (files.length === 0) return null;
  const today = opts.today ?? todayIso();
  const known = await ownerAmounts(store, task);
  const problems: string[] = [];
  const checked = new Set<FigureReview['checked'][number]>();

  for (const file of files) {
    const name = baseName(file.path);
    // A dated file name ("weekly_review_2024-05-20.md") carries a stale date too.
    const nameCheck = checkFigures(name.replace(/[_]+/g, ' '), { today });
    for (const finding of nameCheck.findings) {
      if (finding.kind === 'stale-date') {
        problems.push(`The file name \`${name}\` has a date that has already passed.`);
      }
    }
    const read =
      file.kind === 'artifact'
        ? store.readProjectArtifact(task.projectId, file.path)
        : store.readProjectWorkspaceFile(task.projectId, file.path);
    const text = await read.catch(() => null);
    if (!text) continue;
    const result = checkFigures(text.slice(0, MAX_FILE_CHARS), { today, knownAmounts: known });
    if (result.checked.sums + result.checked.lineMath > 0) checked.add('sums');
    if (result.checked.prices > 0) checked.add('prices');
    if (result.checked.dates > 0) checked.add('dates');

    const unsourced: FigureFinding[] = [];
    for (const finding of result.findings) {
      if (finding.kind === 'unsourced-price') unsourced.push(finding);
      else problems.push(`${finding.message} (\`${name}\`)`);
    }
    if (unsourced.length > 0) {
      const named = unsourced.slice(0, MAX_PRICES_NAMED).map((f) => `${f.item} ${f.amount}`);
      const more = unsourced.length - named.length;
      problems.push(
        `Prices in \`${name}\` that didn't come from you: ${joinList(named)}${more > 0 ? ` and ${more} more` : ''}.`,
      );
    }
  }
  if (checked.size === 0 && problems.length === 0) return null;
  const order: FigureReview['checked'] = ['sums', 'prices', 'dates'];
  return {
    problems: problems.slice(0, MAX_PROBLEMS),
    checked: order.filter((kind) => checked.has(kind)),
  };
}

/**
 * The review as markdown lines under `lead` ("Before you approve, check:").
 * With nothing wrong it says what was checked, never more than that.
 */
export function renderFigureReview(
  review: FigureReview | null | undefined,
  lead: string,
): string[] {
  if (!review) return [];
  if (review.problems.length > 0) {
    return [lead, '', ...review.problems.map((problem) => `- ${problem}`)];
  }
  if (review.checked.length === 0) return [];
  return [`I checked the ${joinList(review.checked)} in these files, and they hold up.`];
}
