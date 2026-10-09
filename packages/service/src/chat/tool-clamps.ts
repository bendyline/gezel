/**
 * Which tool-surface clamps a session's next turn runs under: an immediate
 * file write, direct file work, a scenario repair, project orchestration, an
 * exact craftbook route, or a gate repair. Each is read from the session and
 * the message it is about to answer; `ChatManager.ensureState` rebuilds a
 * live session when one of them flips, and `buildSessionOpts` narrows the
 * tool surface to match.
 */
import {
  type ChatMessage,
  type ChatSession,
  type GezelDetail,
  type TaskCraftbookStep,
  parseTaskRef,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import {
  extractDeliverableTargetPath,
  shouldConstrainToDirectFileWork,
  shouldConstrainToImmediateFileWrite,
  shouldConstrainToScenarioFileRepair,
} from './role-tool-filter.js';
import { projectOrchestrationConstraintActive } from './session-tool-surface.js';
import { repairClampDisabled, stepGateRepairActive } from './step-tool-kit.js';
import { shouldConstrainToExactCraftbookInvocation } from './turn-intent-plan.js';

export function latestUserMessageContent(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return undefined;
}

/**
 * Byte floor for "an existing substantial file" — above a stub, big
 * enough that a full `write_file` rewrite is corruption-prone for a weak
 * local model. A 15-byte placeholder stays on the write-only path; a
 * 16 KB game does not. See deliverableIsExistingSubstantialFile.
 */
const EXISTING_SUBSTANTIAL_FILE_BYTES = 1500;

/**
 * True when the immediate-file-write deliverable in `message` names an
 * existing, substantial workspace file — a modification, not a create —
 * so {@link constrainAllowlistForImmediateFileWrite} keeps the surgical
 * patch tools available instead of forcing a `write_file`-only full
 * rewrite the model corrupts. Fresh creates (file absent, e.g. evals)
 * and stubs stay on the `write_file`-only path.
 */
export async function deliverableIsExistingSubstantialFile(
  store: Store,
  projectId: string,
  message: string | undefined,
): Promise<boolean> {
  const target = extractDeliverableTargetPath(message);
  if (!target) return false;
  const normalized = target.replace(/^\.?\/?workspace\//i, '').replace(/^\.\//, '');
  const content = await store.readProjectWorkspaceFile(projectId, normalized).catch(() => null);
  return (content?.length ?? 0) >= EXISTING_SUBSTANTIAL_FILE_BYTES;
}

export async function immediateFileWriteConstraintActive(
  store: Store,
  record: ChatSession,
  gezel: GezelDetail,
  pendingUserText?: string,
): Promise<boolean> {
  const latestUserMessage = pendingUserText ?? latestUserMessageContent(record.messages);
  let hasToolsetOverride = false;
  try {
    const perGezel = await store.listInstalledToolsets({
      kind: 'gezel',
      gezelId: record.gezelId,
    });
    hasToolsetOverride = perGezel.some((toolset) => toolset.runtime.kind === 'builtin');
  } catch {
    hasToolsetOverride = false;
  }
  return shouldConstrainToImmediateFileWrite({
    role: gezel.role,
    latestUserMessage,
    hasToolsetOverride,
  });
}

/**
 * D4 clamp-lifetime derivation for the rebuild check: read the
 * session's active step (step-scoped sessions only) and combine with
 * the ad-hoc deliverable plateau. One task read per send on
 * step-scoped sessions — the same read buildSessionOpts pays.
 */
export async function gateRepairConstraintActive(
  store: Store,
  record: ChatSession,
): Promise<boolean> {
  if (repairClampDisabled()) return false;
  let step: TaskCraftbookStep | undefined;
  if (record.taskRef && record.stepId) {
    const parsed = parseTaskRef(record.taskRef);
    if (parsed) {
      const task = await store.readTask(parsed.projectId, parsed.num).catch(() => null);
      step = task?.craftbook.steps.find((s) => s.id === record.stepId);
    }
  }
  return stepGateRepairActive(step, record);
}

export async function scenarioFileRepairConstraintActive(
  store: Store,
  record: ChatSession,
  gezel: GezelDetail,
  pendingUserText?: string,
): Promise<boolean> {
  const latestUserMessage = pendingUserText ?? latestUserMessageContent(record.messages);
  let hasToolsetOverride = false;
  try {
    const perGezel = await store.listInstalledToolsets({
      kind: 'gezel',
      gezelId: record.gezelId,
    });
    hasToolsetOverride = perGezel.some((toolset) => toolset.runtime.kind === 'builtin');
  } catch {
    hasToolsetOverride = false;
  }
  return shouldConstrainToScenarioFileRepair({
    role: gezel.role,
    latestUserMessage,
    hasToolsetOverride,
  });
}

export async function directFileWorkConstraintActive(
  store: Store,
  record: ChatSession,
  gezel: GezelDetail,
  pendingUserText?: string,
): Promise<boolean> {
  const latestUserMessage = pendingUserText ?? latestUserMessageContent(record.messages);
  let hasToolsetOverride = false;
  try {
    const perGezel = await store.listInstalledToolsets({
      kind: 'gezel',
      gezelId: record.gezelId,
    });
    hasToolsetOverride = perGezel.some((toolset) => toolset.runtime.kind === 'builtin');
  } catch {
    hasToolsetOverride = false;
  }
  if (
    shouldConstrainToDirectFileWork({
      role: gezel.role,
      latestUserMessage,
      hasToolsetOverride,
    })
  ) {
    return true;
  }
  if (hasToolsetOverride || record.expectedDeliverable?.kind !== 'file') return false;
  const filePath = record.expectedDeliverable.filePath?.trim();
  if (!filePath) return false;
  return shouldConstrainToDirectFileWork({
    role: gezel.role,
    latestUserMessage:
      `The deliverable is the workspace file ${filePath}. ` +
      `Write the result to ${filePath} with workspace file tools.`,
    hasToolsetOverride,
  });
}

export function sessionProjectOrchestrationConstraintActive(
  record: ChatSession,
  gezel: GezelDetail,
  pendingUserText?: string,
): boolean {
  const latestUserMessage = pendingUserText ?? latestUserMessageContent(record.messages);
  return projectOrchestrationConstraintActive({
    record,
    role: gezel.role,
    provider: record.providerName,
    latestUserMessage,
  });
}

export function exactCraftbookConstraintActive(
  record: ChatSession,
  gezel: GezelDetail,
  pendingUserText?: string,
): boolean {
  return shouldConstrainToExactCraftbookInvocation({
    role: gezel.role,
    latestUserMessage: pendingUserText ?? latestUserMessageContent(record.messages),
  });
}
