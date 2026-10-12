import type { ReactNode } from 'react';

/**
 * The crew's working, folded into one line of the person's conversation.
 *
 * A task launched from the meester's thread nests its workers' sessions
 * under the turn that launched it, and the person used to read all of it:
 * thinking, tool calls, retries, and red tool errors about "game state"
 * in the middle of their first conversation. Folded, the thread reads as
 * the ask, the crew, one line of who is working, and the finished thing;
 * the whole transcript is one click away.
 *
 * The line is also the one place a stopped worker's failure shows, in a
 * muted tone: the person needs to know the work stopped, not to read a
 * stack of error banners.
 */
export function WorkingNotes({
  names,
  live,
  error,
  defaultOpen = false,
  children,
}: {
  /** The gezels whose sessions are folded here, in order. */
  names: readonly string[];
  /** Any of them is mid-turn. */
  live: boolean;
  /** Why the last of them stopped, when one did. */
  error?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const who = joinNames(names);
  const several = names.length > 1;
  const state = live ? 'live' : error ? 'stopped' : 'done';
  return (
    <details
      className={`timeline-working-notes timeline-working-notes-${state}`}
      data-testid="working-notes"
      data-working-notes-state={state}
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary className="timeline-working-notes-summary">
        <span className="timeline-working-notes-dot" aria-hidden="true" />
        <span className="timeline-working-notes-line">
          {live
            ? `${who} ${several ? 'are' : 'is'} working…`
            : error
              ? `${who} stopped: ${error}`
              : `${who}'s working notes`}
        </span>
        <span className="timeline-working-notes-toggle">Working notes</span>
      </summary>
      <div className="timeline-working-notes-body">{children}</div>
    </details>
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return 'The crew';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
