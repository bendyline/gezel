import type { GezelSummary } from '@bendyline/gezel';
import { Box, Text, renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { FeedRow } from '../feed.js';
import { ChatFeed } from './ChatFeed.js';

const gezels = [
  {
    id: 'builder',
    name: 'Bo',
    role: 'Developer',
    roleBasedName: 'Builder',
  },
] as GezelSummary[];

describe('ChatFeed', () => {
  it('renders the welcome state when the feed is empty', () => {
    const output = renderToString(
      <ChatFeed rows={[]} gezels={gezels} boring focusedSessionId={undefined} />,
    );
    expect(output).toContain('Type a message to begin');
    expect(output).toContain('/help for commands');
  });

  it('keeps the visible tail, labels speakers, and marks the focused session', () => {
    const output = renderToString(
      <ChatFeed
        rows={[
          row('old', 'user', 'discarded'),
          row('focus', 'user', 'question'),
          row('focus', 'assistant', 'answer', 'builder'),
        ]}
        gezels={gezels}
        boring
        focusedSessionId="focus"
        visible={2}
      />,
    );
    expect(output).not.toContain('discarded');
    expect(output).toContain('▎you: question');
    expect(output).toContain('▎Builder: answer');
  });

  it('labels queued user input as pending', () => {
    const output = renderToString(
      <ChatFeed
        rows={[row('focus', 'pending', 'please also inspect the tests', 'builder')]}
        gezels={gezels}
        boring
        focusedSessionId="focus"
      />,
    );

    expect(output).toContain('▎pending: please also inspect the tests');
    expect(output).not.toContain('Builder: please also inspect the tests');
  });

  it('leaves a blank line between the feed and the prompt area', () => {
    const output = renderToString(
      <Box flexDirection="column">
        <ChatFeed
          rows={[row('focus', 'assistant', 'answer', 'builder')]}
          gezels={gezels}
          boring
          focusedSessionId="focus"
        />
        <Text>prompt area</Text>
      </Box>,
    );

    expect(output).toContain('▎Builder: answer\n\nprompt area');
  });

  it('renders terminal blocks without a speaker prefix and humanizes assistant tool markup', () => {
    const output = renderToString(
      <ChatFeed
        rows={[
          row('term-1', 'shell', '$ ls\na.md'),
          row(
            'chat',
            'assistant',
            '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
            'builder',
          ),
        ]}
        gezels={gezels}
        boring={false}
        focusedSessionId="chat"
      />,
    );
    expect(output).toContain('$ ls\na.md');
    expect(output).not.toContain('shell: $ ls');
    expect(output).toContain('Bo · Developer: 🔧 read_file (path: README.md)');
  });

  it('trims trailing whitespace and caps runaway output', () => {
    const output = renderToString(
      <ChatFeed
        rows={[row('chat', 'note', `${'x'.repeat(8_010)}   `)]}
        gezels={gezels}
        boring
        focusedSessionId={undefined}
      />,
      { columns: 10_000 },
    );
    expect(output).toContain('… (truncated)');
    expect(output).not.toContain('xxx   ');
  });
});

function row(sessionId: string, kind: FeedRow['kind'], text: string, gezelId = ''): FeedRow {
  return {
    key: `${sessionId}-${kind}-${text.slice(0, 4)}`,
    sessionId,
    gezelId,
    kind,
    text,
    open: false,
  };
}
