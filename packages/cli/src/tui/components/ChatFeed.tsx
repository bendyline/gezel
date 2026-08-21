import { GEZEL_VERSION, type GezelSummary } from '@bendyline/gezel';
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import { type FeedRow, MAX_FEED_ROW_CHARS, gezelLabel } from '../feed.js';
import { humanizeToolMarkup } from '../tool-markup.js';

const TABLE_LOGO = [
  '   o  ____________________',
  'o-[O]|____________________|',
  '   |    /|____________|\\',
  '   o   /_|            |_\\',
].join('\n');

export const CHAT_FEED_ROW_STYLES: Record<
  FeedRow['kind'],
  { color: string | undefined; dimColor: boolean }
> = {
  user: { color: 'white', dimColor: false },
  pending: { color: 'yellow', dimColor: true },
  assistant: { color: 'cyan', dimColor: false },
  thinking: { color: 'magentaBright', dimColor: false },
  write: { color: 'yellow', dimColor: true },
  tool: { color: 'yellow', dimColor: false },
  note: { color: 'magenta', dimColor: false },
  error: { color: 'red', dimColor: false },
  shell: { color: undefined, dimColor: false },
};

/**
 * Scrolling view of the live multi-agent feed. Shows the last `visible`
 * rows; each row is prefixed with the speaking gezel (or "you" for user
 * turns). The `focused` session is highlighted so it's clear where input
 * will land when you interject.
 */
export function ChatFeed(props: {
  rows: ReadonlyArray<FeedRow>;
  gezels: ReadonlyArray<GezelSummary>;
  boring: boolean;
  focusedSessionId: string | undefined;
  visible?: number;
}): JSX.Element {
  const { rows, gezels, boring, focusedSessionId, visible = 16 } = props;
  // The reducer starts a write decoder as soon as structured arguments
  // arrive, often before the selected content/text field. Do not flash an
  // empty "writing:" row while path/ref arguments are still streaming.
  const visibleRows = rows.filter((row) => row.kind !== 'write' || row.text.length > 0);
  const shown = visibleRows.slice(Math.max(0, visibleRows.length - visible));

  return (
    <Box flexDirection="column" flexGrow={1} marginBottom={1}>
      {shown.length === 0 ? (
        <Box flexDirection="row">
          <Text color="yellow">{TABLE_LOGO}</Text>
          <Box flexDirection="column" marginLeft={3}>
            <Text>gezel {GEZEL_VERSION}</Text>
            <Text dimColor>Type a message to begin</Text>
            <Text dimColor>/help for commands</Text>
          </Box>
        </Box>
      ) : (
        shown.map((row) => {
          const rowStyle = CHAT_FEED_ROW_STYLES[row.kind];
          // Shell output is already a terminal-formatted block. Rendering a
          // speaker label inline steals width from only its first line, which
          // makes column-aware output such as `ls` wrap asymmetrically.
          if (row.kind === 'shell' && row.sessionId.startsWith('term-')) {
            return (
              <Text key={row.key} wrap="wrap">
                {clip(row.text)}
              </Text>
            );
          }
          const who =
            row.kind === 'user'
              ? 'you'
              : row.kind === 'pending'
                ? 'pending'
                : row.kind === 'thinking'
                  ? 'thinking'
                  : row.kind === 'write'
                    ? 'writing'
                    : row.gezelId
                      ? gezelLabel(row.gezelId, gezels, boring)
                      : row.kind === 'tool'
                        ? 'tool'
                        : row.kind === 'shell'
                          ? 'shell'
                          : row.kind === 'error'
                            ? 'error'
                            : 'system';
          const isFocused = focusedSessionId && row.sessionId === focusedSessionId;
          // Full message body, wrapped to the terminal width (Ink's default).
          // Only the speaker prefix is fixed; long chat replies render in
          // full rather than being clipped to a line.
          return (
            <Box key={row.key} flexDirection="row">
              <Text dimColor={!isFocused} color={isFocused ? 'green' : undefined}>
                {isFocused ? '▎' : ' '}
              </Text>
              <Text wrap="wrap">
                <Text bold color={rowStyle.color}>
                  {who}
                  {': '}
                </Text>
                <Text color={rowStyle.color} dimColor={rowStyle.dimColor}>
                  {clip(
                    row.taskEvent
                      ? taskEventText(row, gezels, boring)
                      : row.kind === 'assistant'
                        ? humanizeToolMarkup(row.text)
                        : row.text,
                  )}
                </Text>
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/**
 * History summaries deliberately keep friendly names. Rewrite only the
 * actor-bearing task phrases from structured event metadata, leaving the
 * durable audit prose untouched while respecting this CLI's fixed naming
 * mode. The generic placeholder prevents a one-render name flash while a
 * newly recruited gezel is being added to the live roster snapshot.
 */
function taskEventText(row: FeedRow, gezels: ReadonlyArray<GezelSummary>, boring: boolean): string {
  const event = row.taskEvent;
  if (!boring || !event?.gezelId) return row.text;
  const actor = gezelLabel(event.gezelId, gezels, true);
  switch (event.kind) {
    case 'task.entry.dispatched':
      return row.text.replace(/ handed to .*$/, ` handed to ${actor}`);
    case 'tasknote.appended':
      return row.text.replace(/^task · .*? noted on /, `task · ${actor} noted on `);
    case 'tasknote.deleted':
      return row.text.replace(
        /^task · .*? removed a note from /,
        `task · ${actor} removed a note from `,
      );
    case 'tasknote.updated':
      return row.text.replace(/^task · .*? edited a note on /, `task · ${actor} edited a note on `);
    default:
      return row.text;
  }
}

/**
 * Trim trailing whitespace and cap pathological lengths (e.g. a runaway
 * shell dump) so one row can't blow up the render. Newlines are preserved
 * — ink wraps and honors them.
 */
function clip(text: string): string {
  const t = text.replace(/\s+$/, '');
  return t.length > MAX_FEED_ROW_CHARS ? `${t.slice(0, MAX_FEED_ROW_CHARS)}\n… (truncated)` : t;
}
