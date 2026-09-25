import type { ChatSession, ChatSessionSummary } from '../schemas/session.js';
import { ChatSessionSummarySchema } from '../schemas/session.js';
import { NEW_THREAD_TITLE, deriveThreadTitleFromMessages } from '../thread-title.js';

export function slugifyEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Choose a `roleBasedName` for a gezel given its role and the set of
 * names already in use on this install. Exported for tests; the
 * stateful wrapper lives on `Store.computeRoleBasedName`.
 *
 *   - With role: base = `slugify(role)`. If unused, return it. Else
 *     append `-2`, `-3`, … until free.
 *   - Without role (or role slugifies to empty): return the first
 *     unused `gezel-N` starting from `gezel-1`.
 */
export function pickRoleBasedName(role: string | undefined, taken: ReadonlySet<string>): string {
  const base = role ? slugifyEntityName(role) : '';
  if (base && !taken.has(base)) return base;
  for (let i = base ? 2 : 1; i < 10000; i++) {
    const candidate = `${base || 'gezel'}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(
    base
      ? `roleBasedName collision overflow for role "${role}"`
      : 'roleBasedName collision overflow for roleless gezel',
  );
}

export function sessionSummary(session: ChatSession): ChatSessionSummary {
  const latest = session.messages.at(-1)?.content.replace(/\s+/g, ' ').trim() ?? '';
  let lastMessagePreview = '';
  for (const character of latest) {
    if (lastMessagePreview.length + character.length > 200) break;
    lastMessagePreview += character;
  }
  let chars = 0;
  const involved = new Set([session.gezelId]);
  let lastHumanActivityAt: string | undefined;
  for (const message of session.messages) {
    chars += message.content.length;
    if (message.role === 'user' && !message.from) lastHumanActivityAt = message.at;
    if (message.from) involved.add(message.from.gezelId);
    for (const call of message.toolCalls ?? [])
      chars +=
        call.name.length +
        (call.argsFull ?? call.argsSummary ?? '').length +
        (call.resultText ?? '').length;
  }
  return ChatSessionSummarySchema.parse({
    ...session,
    title:
      session.title === NEW_THREAD_TITLE
        ? (deriveThreadTitleFromMessages(session.messages, { requireCompletedTurn: true }) ??
          session.title)
        : session.title,
    lastHumanActivityAt,
    lastMessagePreview: lastMessagePreview || undefined,
    involvedGezelIds: [...involved],
    transcriptTokens: Math.ceil(chars / 4),
  });
}
