import { formatAbsoluteTime, formatClockTime } from '../relative-time.js';

/**
 * "Offline since 10:45 AM" (a date when it began before today), or the host
 * that did not answer. A connection waiting for the network is not broken,
 * so this is a calm line, never an error.
 */
export function connectorWaitingLine(
  waiting: { since: string; offline: boolean; host?: string },
  now: Date = new Date(),
): string {
  const began = new Date(waiting.since);
  const since =
    began.toDateString() === now.toDateString()
      ? formatClockTime(began)
      : formatAbsoluteTime(began);
  return waiting.offline
    ? `Offline since ${since}`
    : `Couldn't reach ${waiting.host ?? 'the service'} since ${since}. Trying again.`;
}

/**
 * What a connection's records are called, by connection family: a mailbox
 * holds emails, a calendar events. A type not listed here holds "items".
 */
const NOUNS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^mail-/, 'email', 'emails'],
  [/^calendar-/, 'event', 'events'],
  [/^files-/, 'file', 'files'],
  [/^youtube-/, 'video', 'videos'],
  [/^(x|bluesky|linkedin)-posts$/, 'post', 'posts'],
  [/^instagram-/, 'post', 'posts'],
  [/^rss-feed$/, 'article', 'articles'],
  [/-issues$/, 'issue', 'issues'],
  [/^(github-wiki|website)$/, 'page', 'pages'],
];

/** "email" for one, "emails" for any other count. */
export function connectorItemNoun(type: string, count: number): string {
  const [, one, many] = NOUNS.find(([re]) => re.test(type)) ?? [null, 'item', 'items'];
  return count === 1 ? one : many;
}

/** "1 email", "1,204 emails", "3 items". */
export function connectorItemCount(type: string, count: number): string {
  return `${count.toLocaleString()} ${connectorItemNoun(type, count)}`;
}
