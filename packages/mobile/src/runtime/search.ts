import type { MobileSession, MobileState } from '@bendyline/gezel/schemas';

/** Pure, local title/message search; it never sends conversation contents to a provider. */
export function searchConversations(state: MobileState, query: string): MobileSession[] {
  const needle = query.trim().toLocaleLowerCase();
  return state.sessions
    .filter(
      (session) =>
        !needle ||
        session.title.toLocaleLowerCase().includes(needle) ||
        session.messages.some((message) => message.content.toLocaleLowerCase().includes(needle)),
    )
    .slice()
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
