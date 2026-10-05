import { randomUUID } from 'node:crypto';
import {
  type AskQuestionRequest,
  type Question,
  type QuestionAnswer,
  nowIso,
} from '@bendyline/gezel';
import { realpathNearest } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';

/** The model supplies a reason; the service supplies every grant-bearing field. */
export async function requestWorkspaceWritePermission(
  store: Store,
  body: AskQuestionRequest,
): Promise<{ question: Question; deduped: boolean }> {
  const project = await store.getProject(body.projectId);
  if (!project) throw new Error('Project not found.');
  const session = await store.findSessionById(body.sessionId);
  if (!session || session.projectId !== body.projectId || session.gezelId !== body.gezelId) {
    throw new Error('Permission requests must belong to the asking chat and project.');
  }
  const gate = await store.assertWorkspaceWritable(body.projectId, { initiatedByGezel: true });
  if (gate.ok) {
    throw new Error(
      'Project file edits are already allowed. This permission cannot fix OS, shell, or external tool restrictions.',
    );
  }
  const workspaceDir = gate.workingDir;
  const realWorkspaceDir = await realpathNearest(workspaceDir);
  if (!realWorkspaceDir) throw new Error('The project folder could not be resolved.');
  const existing = (await store.listProjectQuestions(body.projectId)).find(
    (q) =>
      !q.answer &&
      q.sessionId === body.sessionId &&
      q.intent?.kind === 'workspace-write-permission' &&
      q.intent.workspaceDir === workspaceDir &&
      q.intent.realWorkspaceDir === realWorkspaceDir,
  );
  if (existing) return { question: existing, deduped: true };
  return {
    deduped: false,
    question: {
      id: randomUUID(),
      projectId: body.projectId,
      gezelId: body.gezelId,
      sessionId: body.sessionId,
      prompt: body.prompt,
      choices: ['Allow project file edits and continue', 'Keep current permissions'],
      allowWriteIn: false,
      multiSelect: false,
      ...(session.taskRef ? { taskRef: session.taskRef } : {}),
      ...(session.stepId ? { stepId: session.stepId } : {}),
      intent: {
        kind: 'workspace-write-permission',
        projectName: project.name,
        workspaceDir,
        realWorkspaceDir,
      },
      createdAt: nowIso(),
    },
  };
}

export function workspacePermissionDecision(answer: QuestionAnswer): 'grant' | 'deny' | 'skip' {
  if (answer.silentSkip || answer.declined) {
    if (answer.selectedChoices?.length)
      throw new Error('Choose a permission decision or dismiss the request, not both.');
    return answer.silentSkip ? 'skip' : 'deny';
  }
  if (
    answer.writeIn ||
    answer.npmInstallDecisions ||
    answer.selectedChoices?.length !== 1 ||
    (answer.selectedChoices[0] !== 0 && answer.selectedChoices[0] !== 1)
  ) {
    throw new Error(
      'Choose Allow project file edits or Keep current permissions. Text answers do not grant access.',
    );
  }
  return answer.selectedChoices[0] === 0 ? 'grant' : 'deny';
}

export function workspacePermissionAnswerSeed(question: Question): string {
  if (question.intent?.kind !== 'workspace-write-permission' || !question.answer) {
    throw new Error('Expected an answered workspace permission request.');
  }
  return workspacePermissionDecision(question.answer) === 'grant'
    ? `[Permission granted: Gezel-managed file edits throughout project ${question.projectId}, folder ${question.intent.workspaceDir}, until revoked. Resume the requested work using the available tools. OS, shell, and external tool permissions are unchanged.]`
    : '[Permission denied: the user kept the current project file permissions. Continue only within existing permissions; explain any remaining blocker. Do not ask for the same grant again or claim it was granted.]';
}
