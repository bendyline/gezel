import { GEZEL_VERSION, type GezelSummary } from '@bendyline/gezel';
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import { type FeedRow, gezelLabel } from '../feed.js';
import { humanizeToolMarkup } from '../tool-markup.js';

const TABLE_LOGO = [
  '   o  ____________________',
  'o-[O]|____________________|',
  '   |    /|____________|\\',
  '   o   /_|            |_\\',
].join('\n');

const KIND_COLOR: Record<FeedRow['kind'], string | undefined> = {
  user: 'white',
  pending: 'yellow',
  assistant: 'cyan',
  tool: 'yellow',
  note: 'magenta',
  error: 'red',
  shell: undefined,
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
  const shown = rows.slice(Math.max(0, rows.length - visible));

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
                <Text bold color={KIND_COLOR[row.kind]}>
                  {who}
                  {': '}
                </Text>
                <Text color={KIND_COLOR[row.kind]} dimColor={row.kind === 'pending'}>
                  {clip(row.kind === 'assistant' ? humanizeToolMarkup(row.text) : row.text)}
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
 * Trim trailing whitespace and cap pathological lengths (e.g. a runaway
 * shell dump) so one row can't blow up the render. Newlines are preserved
 * — ink wraps and honors them.
 */
const MAX_CHARS = 8000;
function clip(text: string): string {
  const t = text.replace(/\s+$/, '');
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n… (truncated)` : t;
}
