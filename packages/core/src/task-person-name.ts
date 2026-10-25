import type { Task } from './schemas/task.js';
import { deliverableFormatNoun, taskDeliverableCandidates } from './task-deliverable.js';

function comparable(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The task's title as a person would say it, or undefined when the title is
 * only the craftbook's own name. A bakery asked for October's invoices and was
 * told "**Formatted Report** is finished": the book's name, not their request.
 */
export function taskPersonName(
  task: Pick<Task, 'title'> & { craftbook?: Pick<Task['craftbook'], 'id' | 'name'> },
): string | undefined {
  const title = task.title?.trim();
  if (!title) return undefined;
  const key = comparable(title);
  if (!key) return undefined;
  // Records built in code and older snapshots can lack either field.
  const book = task.craftbook as Partial<Pick<Task['craftbook'], 'id' | 'name'>> | undefined;
  if (key === comparable(book?.name) || key === comparable(book?.id)) return undefined;
  return title;
}

/**
 * How to name a task in the middle of a sentence: its title in quotes, else
 * the kind of file it promises ("your PDF"), else "the work".
 */
export function taskPersonNoun(task: Task): string {
  const name = taskPersonName(task);
  if (name) return `"${name}"`;
  const promised = taskDeliverableCandidates(task)[0];
  return promised ? `your ${deliverableFormatNoun(promised.path)}` : 'the work';
}
