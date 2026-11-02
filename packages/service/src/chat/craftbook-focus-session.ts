import {
  type ChatSession,
  type TurnMessageOrigin,
  craftbookCheckup,
  renderCraftbookFocusBlock,
  renderCraftbookTurnLine,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

type CraftbookReader = Pick<Store, 'getLocalCraftbookTemplate'>;

/**
 * The craftbook a thread is pinned to, as it stands for this turn, with its
 * checkup. Read fresh on every turn of the person's, because they edit the
 * book by hand in the editor beside the chat; a book that cannot be read
 * costs the line, never the turn.
 */
export async function readCraftbookStateLine(args: {
  store: CraftbookReader;
  session: Pick<ChatSession, 'craftbookRef'>;
  origin: TurnMessageOrigin;
}): Promise<string | null> {
  const ref = args.session.craftbookRef;
  if (!ref) return null;
  if (args.origin !== 'direct-user' && args.origin !== 'question-answer') return null;
  const book = await args.store.getLocalCraftbookTemplate(ref).catch(() => null);
  return book ? renderCraftbookTurnLine(book, craftbookCheckup(book)) : null;
}

/**
 * The system-prompt section of a thread pinned to a craftbook (the editor's
 * AI assist): what the conversation is about and how to change it.
 * Session-stable; the book's current state rides each turn instead
 * ({@link readCraftbookStateLine}), because the person edits it by hand.
 */
export async function craftbookFocusPromptBlock(args: {
  store: CraftbookReader;
  craftbookRef: string;
  toolNames: readonly string[];
}): Promise<string> {
  const book = await args.store.getLocalCraftbookTemplate(args.craftbookRef).catch(() => null);
  return renderCraftbookFocusBlock({
    id: args.craftbookRef,
    name: book?.name,
    toolNames: args.toolNames,
  });
}
