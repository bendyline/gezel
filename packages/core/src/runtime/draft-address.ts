import type { PromptDraftMeta } from '../schemas/prompt-draft.js';
import type { ChatSession } from '../schemas/session.js';

export function draftMatchesSession(draft: PromptDraftMeta, session: ChatSession): boolean {
  return (
    draft.projectId === session.projectId &&
    draft.gezelId === session.gezelId &&
    (!draft.sessionId || draft.sessionId === session.id) &&
    (!draft.taskRef || draft.taskRef === session.taskRef) &&
    (!draft.craftbookRef || draft.craftbookRef === session.craftbookRef)
  );
}
