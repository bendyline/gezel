/**
 * Fixed-function image brief
 *
 * Fixed-function image gezels do not read the LLM system prompt. A task
 * handoff's user message is only a generic "you've been assigned" seed, so
 * forwarding it verbatim would render the workflow instructions instead of
 * the requested subject. Recover the visual brief and output path from the
 * persisted project/task/step metadata that an LLM-backed worker would have
 * received in its prompt.
 *
 * Plain chat sends keep the user's text unchanged. An explicit
 * expectedDeliverable still supplies an authoritative saveAs for either
 * path, matching message_gezel's file-handoff contract.
 *
 * Related files: `manager.ts` (`runFixedFunctionSend` composes the call
 * args from this), `fixed-function-adapters.ts` (the pure text helpers).
 */
import {
  type ChatSession,
  createLogger,
  parseTaskRef,
  stepDeliverablePath,
} from '@bendyline/gezel';
import {
  DEFAULT_PROJECT_ABOUT_MD,
  DEFAULT_PROJECT_MISSION_MD,
} from '../fs/default-project-docs.js';
import type { Store } from '../fs/store.js';
import {
  fixedFunctionImageHandoff,
  fixedFunctionImagePath,
  stripGezelMentions,
} from './fixed-function-adapters.js';

const log = createLogger('chat');

const SEEDED_DEFAULT_PROJECT_DOCS = new Set(
  [DEFAULT_PROJECT_ABOUT_MD, DEFAULT_PROJECT_MISSION_MD].map((doc) => doc.trim()),
);

export async function resolveFixedFunctionTaskImageArgs(
  store: Pick<Store, 'readTask' | 'getProject'>,
  record: Pick<ChatSession, 'taskRef' | 'stepId' | 'projectId' | 'expectedDeliverable'>,
  userText: string,
): Promise<{ prompt: string; saveAs?: string }> {
  const explicitPath =
    record.expectedDeliverable?.kind === 'file'
      ? fixedFunctionImagePath(record.expectedDeliverable.filePath)
      : null;
  if (!record.taskRef) {
    const handoff = fixedFunctionImageHandoff(userText);
    const saveAs = explicitPath ?? handoff.saveAs;
    return {
      prompt: handoff.prompt,
      ...(saveAs ? { saveAs } : {}),
    };
  }

  const parsed = parseTaskRef(record.taskRef);
  if (!parsed) {
    return {
      prompt: stripGezelMentions(userText),
      ...(explicitPath ? { saveAs: explicitPath } : {}),
    };
  }

  try {
    const [task, project] = await Promise.all([
      store.readTask(parsed.projectId, parsed.num),
      store.getProject(record.projectId),
    ]);
    const step = task
      ? ((record.stepId
          ? task.craftbook.steps.find((candidate) => candidate.id === record.stepId)
          : undefined) ??
        task.craftbook.steps.find((candidate) => candidate.id === task.activeStepId))
      : undefined;
    const stepPath = step ? fixedFunctionImagePath(stepDeliverablePath(step)) : null;
    const promptParts: string[] = [];
    const seenPromptParts = new Set<string>();
    for (const candidate of [
      task?.title,
      task?.description,
      project?.about,
      project?.missionObjectives,
      step?.description,
    ]) {
      const part = candidate?.trim();
      const key = part?.replace(/\s+/g, ' ').toLowerCase();
      if (!part || !key || seenPromptParts.has(key)) continue;
      // Default's seeded docs describe the catch-all bucket, not the
      // picture; ~800 chars of it ahead of the step description can crowd
      // the actual subject out of a short-prompt image engine.
      if (SEEDED_DEFAULT_PROJECT_DOCS.has(part)) continue;
      seenPromptParts.add(key);
      promptParts.push(part);
    }
    const prompt = promptParts.join('\n\n');
    const saveAs = explicitPath ?? stepPath;
    return {
      prompt: prompt || stripGezelMentions(userText),
      ...(saveAs ? { saveAs } : {}),
    };
  } catch (err) {
    log.warn(
      `fixed-function image handoff metadata lookup failed for ${record.taskRef}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      prompt: stripGezelMentions(userText),
      ...(explicitPath ? { saveAs: explicitPath } : {}),
    };
  }
}
