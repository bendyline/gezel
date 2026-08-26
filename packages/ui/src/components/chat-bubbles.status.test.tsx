import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const { StreamingBubble } = await import('./chat-bubbles.js');

describe('StreamingBubble status', () => {
  it('splits an activity path so the filename remains visible through middle truncation', () => {
    const { container } = render(
      <StreamingBubble
        authorLabel="Boekwachter"
        authorIcon={null}
        segments={[]}
        startedAt={Date.now() - 2_000}
        thinkingLabel="Indexing packages/knowledge/src/registry-client/fetch.ts · Generating"
      />,
    );

    const label = container.querySelector('.msg-live-status-label');
    expect(label).toHaveAttribute(
      'title',
      'Indexing packages/knowledge/src/registry-client/fetch.ts · Generating',
    );
    expect(label?.querySelector('.msg-live-status-label-prefix')).toHaveTextContent(
      'Indexing packages/knowledge/src/registry-client/',
    );
    expect(label?.querySelector('.msg-live-status-label-suffix')).toHaveTextContent(
      'fetch.ts · Generating',
    );
  });

  it('replaces the thinking dots with a specific model-queue status', () => {
    const { container } = render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        segments={[]}
        startedAt={Date.now() - 40_000}
        queueAhead={2}
      />,
    );

    expect(screen.getByText('model queue · position 3')).toBeInTheDocument();
    expect(screen.getByText('Position 3 in line')).toBeInTheDocument();
    expect(screen.getByText('2 prompts ahead')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Waiting in the model queue, position 3 in line, 2 prompts ahead'),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('.queue-position-ahead')).toHaveLength(2);
    expect(container.querySelector('.queue-position-you')).toHaveTextContent('3');
    expect(container.querySelector('.thinking-dots')).toBeNull();
    expect(container.querySelector('.msg-slow-banner')).toBeNull();
  });

  it('does not claim a macOS timing range for a slow first model load', () => {
    render(
      <StreamingBubble
        authorLabel="Ada"
        authorIcon={null}
        localEngine="llama-cpp"
        segments={[]}
        startedAt={Date.now() - 40_000}
        lastActivityAt={Date.now() - 40_000}
      />,
    );

    expect(
      screen.getByText(/First model load is slow; subsequent turns are much faster/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/30-60s|macOS/)).toBeNull();
  });
});
