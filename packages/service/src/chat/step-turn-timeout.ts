/**
 * Step turn timeout
 *
 * A craftbook step can cap each model turn it runs (`turnTimeoutSec`): media
 * review's healthy turns take 30 seconds, while a runaway held a provider slot
 * for the 10 minutes Codex took to cut it off. ChatManager reads the cap once
 * per send and lets it win over the provider-keyed defaults; the provider then
 * fails the turn at the limit and the handoff's bounded retries take over.
 *
 * Related files: `manager.ts` (applies it to `sendAndWait`'s `timeoutMs`),
 * `core/src/schemas/craftbook.ts` (`CraftbookStepSchema.turnTimeoutSec`).
 */
import { type ChatSession, parseTaskRef } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { readTaskWithEffectiveStatus } from '../tasks/effective-status.js';

/** The bound task step's `turnTimeoutSec` in ms, or null when the session has none. */
export async function stepTurnTimeoutMs(
  store: Pick<Store, 'readTask'>,
  record: Pick<ChatSession, 'taskRef' | 'stepId'>,
): Promise<number | null> {
  const parsed = record.taskRef && record.stepId ? parseTaskRef(record.taskRef) : null;
  if (!parsed) return null;
  const task = await readTaskWithEffectiveStatus(store, parsed.projectId, parsed.num).catch(
    () => null,
  );
  const seconds = task?.craftbook.steps.find((step) => step.id === record.stepId)?.turnTimeoutSec;
  return seconds ? seconds * 1000 : null;
}
