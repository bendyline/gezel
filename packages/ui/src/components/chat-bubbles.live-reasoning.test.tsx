import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';
import type { StreamingSegment } from './chat-bubbles.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const { StreamingBubble } = await import('./chat-bubbles.js');

const tool = (name: string) => ({ name, durationMs: 10, success: true });

describe('StreamingBubble live reasoning placement', () => {
  it('renders the think phase in wire order among the turn segments', () => {
    // The bug this guards: reasoning used to live on a slot-level
    // accumulator rendered in one capped box above every segment, so on a
    // long tool-loop turn the trace grew off-screen at the top of the
    // bubble while the user watched tool rows and thinking dots pile up
    // at the bottom.
    const segments: StreamingSegment[] = [
      { kind: 'reasoning', content: 'I need the file first.' },
      { kind: 'tool', tool: tool('read_file') },
      { kind: 'reasoning', content: 'Now I can write it.' },
      { kind: 'tool', tool: tool('write_file') },
    ];
    const { container } = render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={segments}
        startedAt={Date.now() - 5_000}
      />,
    );

    const rendered = [...container.querySelectorAll('.msg-stream-segment')].map((el) =>
      el.querySelector('.msg-stream-reasoning') ? 'reasoning' : 'tools',
    );
    expect(rendered).toEqual(['reasoning', 'tools', 'reasoning', 'tools']);
  });

  it('keeps a think phase as one block across a slow-token pause', () => {
    // Text deltas break into fresh segments after an idle gap; reasoning
    // deliberately does not, so a pause mid-deliberation cannot scatter
    // one act of thinking into several labelled boxes.
    const { container } = render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={[{ kind: 'reasoning', content: 'One continuous thought.' }]}
        startedAt={Date.now() - 5_000}
      />,
    );

    expect(container.querySelectorAll('.msg-stream-reasoning')).toHaveLength(1);
  });

  it('drops a whitespace-only reasoning segment rather than framing an empty box', () => {
    const { container } = render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={[{ kind: 'reasoning', content: '  \n ' }]}
        startedAt={Date.now() - 5_000}
      />,
    );

    expect(container.querySelector('.msg-stream-reasoning')).toBeNull();
  });

  it('still shows the thinking dots under a streaming trace', () => {
    // Before reasoning joined the segment list this state had an empty
    // segment array, so the dots were there. Losing them on a silent
    // think phase would read as a stall.
    const { container } = render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={[{ kind: 'reasoning', content: 'Still deliberating.' }]}
        startedAt={Date.now() - 5_000}
      />,
    );

    expect(container.querySelector('.thinking-dots')).not.toBeNull();
  });
});
