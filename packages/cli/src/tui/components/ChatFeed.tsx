import { GEZEL_VERSION, type GezelSummary } from '@bendyline/gezel';
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import { type FeedRow, gezelLabel } from '../feed.js';

const BENCH_FACE_WIDTH = 21;
const benchLabel = `gezel ${GEZEL_VERSION}`;
const benchLabelPadding = Math.max(0, BENCH_FACE_WIDTH - benchLabel.length);
const centeredBenchLabel = `${' '.repeat(Math.floor(benchLabelPadding / 2))}${benchLabel}${' '.repeat(
  Math.ceil(benchLabelPadding / 2),
)}`;
const BENCH_LOGO = [
  '      ______________________',
  `     /${centeredBenchLabel}/|`,
  '    /_____________________/ |',
  '      ||               ||',
].join('\n');

const KIND_COLOR: Record<FeedRow['kind'], string | undefined> = {
  user: 'white',
  assistant: 'cyan',
  tool: 'yellow',
  note: 'magenta',
  error: 'red',
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
    <Box flexDirection="column" flexGrow={1}>
      {shown.length === 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">{BENCH_LOGO}</Text>
          <Text> </Text>
          <Text dimColor>Type a message to begin · /help for commands</Text>
        </Box>
      ) : (
        shown.map((row) => {
          const who =
            row.kind === 'user'
              ? 'you'
              : row.gezelId
                ? gezelLabel(row.gezelId, gezels, boring)
                : row.kind === 'tool'
                  ? 'tool'
                  : row.kind === 'error'
                    ? 'error'
                    : 'system';
          const isFocused = focusedSessionId && row.sessionId === focusedSessionId;
          // Full message body, wrapped to the terminal width (ink's default).
          // Only the speaker prefix is fixed; long replies and multi-line
          // shell output render in full rather than being clipped to a line.
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
                <Text color={KIND_COLOR[row.kind]}>{clip(row.text)}</Text>
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
