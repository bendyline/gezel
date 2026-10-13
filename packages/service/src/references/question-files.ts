import { type ProjectReferencedFile, type Question, parseTaskRef } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { createFileStatResolver } from './file-references.js';

/**
 * Resolve the files each pending question's prompt names, as the chat does
 * for a reply, so a card's `tasks/12/report.pdf` opens the report instead of
 * reading as inert code. Computed per read and never stored, so a card links
 * what exists now. Answered questions render as a one-line summary and are
 * left alone.
 *
 * A question about a task is resolved against the task's project first: a
 * task-finished card is filed in the wrap-up thread's project, but the files
 * it lists are the task's, and that thread's project may hold a different
 * task with the same number.
 */
export async function withQuestionFileReferences(
  store: Pick<Store, 'statProjectArtifactPath' | 'statProjectWorkspacePath'>,
  questions: Question[],
): Promise<Question[]> {
  const resolve = createFileStatResolver(store);
  const out: Question[] = [];
  for (const question of questions) {
    if (question.answer) {
      out.push(question);
      continue;
    }
    const taskProjectId = question.taskRef ? parseTaskRef(question.taskRef)?.projectId : undefined;
    const projectIds =
      taskProjectId && taskProjectId !== question.projectId
        ? [taskProjectId, question.projectId]
        : [question.projectId];
    const hits = await resolve(question.prompt, projectIds).catch(() => []);
    if (hits.length === 0) {
      out.push(question);
      continue;
    }
    const referencedFiles = hits.map(
      ({ projectId, ...file }): ProjectReferencedFile =>
        projectId === question.projectId ? file : { ...file, projectId },
    );
    out.push({ ...question, referencedFiles });
  }
  return out;
}
