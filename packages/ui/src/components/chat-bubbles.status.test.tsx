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

describe('StreamingBubble — waiting for the engine vs wedged mid-turn', () => {
  it('keeps the queue badge while the daemon is still re-asserting the wait', () => {
    const { container } = render(
      <StreamingBubble
        authorLabel="Luciana"
        authorIcon={null}
        localEngine="llama-cpp"
        segments={[]}
        startedAt={Date.now() - 8 * 60_000}
        lastActivityAt={Date.now() - 5 * 60_000}
        hasProgress
        queueAhead={1}
        queuedAt={Date.now() - 2_000}
      />,
    );

    // Eight minutes in with a live queue notice: still the queue state, and
    // emphatically NOT the "wedged" banner. This is the wild-caught case —
    // a Voorman parked behind another gezel's agentic loop on a
    // single-slot engine.
    expect(screen.getByText('model queue · position 2')).toBeInTheDocument();
    expect(container.querySelector('.msg-slow-banner')).toBeNull();
  });

  it('expires a stale queue notice instead of showing a frozen position', () => {
    render(
      <StreamingBubble
        authorLabel="Luciana"
        authorIcon={null}
        localEngine="llama-cpp"
        segments={[]}
        startedAt={Date.now() - 60_000}
        lastActivityAt={Date.now() - 40_000}
        queueAhead={1}
        queuedAt={Date.now() - 60_000}
      />,
    );

    // The daemon stopped re-asserting, so the turn acquired its slot.
    expect(screen.queryByText('model queue · position 2')).toBeNull();
    expect(screen.getByText(/Still working/)).toBeInTheDocument();
  });

  it('does not call a turn wedged when it never produced any output', () => {
    render(
      <StreamingBubble
        authorLabel="Luciana"
        authorIcon={null}
        localEngine="llama-cpp"
        segments={[]}
        startedAt={Date.now() - 5 * 60_000}
        lastActivityAt={Date.now() - 5 * 60_000}
        hasProgress
      />,
    );

    // "Wedged mid-turn" presumes a mid-turn. With no text streamed, the
    // honest reading is that it has not started producing yet.
    expect(screen.queryByText(/may have wedged mid-turn/)).toBeNull();
    expect(screen.getByText(/hasn't started producing output/)).toBeInTheDocument();
    expect(screen.getByText(/waiting its turn on the engine/)).toBeInTheDocument();
  });

  it('still reports a genuine mid-turn wedge once output has streamed', () => {
    render(
      <StreamingBubble
        authorLabel="Luciana"
        authorIcon={null}
        localEngine="llama-cpp"
        segments={[{ kind: 'text', content: 'Reading the task notes…' }]}
        startedAt={Date.now() - 5 * 60_000}
        lastActivityAt={Date.now() - 5 * 60_000}
        hasProgress
      />,
    );

    expect(screen.getByText(/may have wedged mid-turn/)).toBeInTheDocument();
  });
});

describe('StreamingBubble elapsed clock', () => {
  it('stops counting once the turn has failed', async () => {
    // A dead turn kept ticking: the failed shell read "11:15" and climbing
    // on a turn that had aborted 40 seconds earlier, so the first question
    // it raised was "is this still running?" instead of "what went wrong?".
    vi.useFakeTimers();
    try {
      const startedAt = Date.now() - 90_000;
      const { rerender, container } = render(
        <StreamingBubble
          authorLabel="Koray"
          authorIcon={null}
          segments={[]}
          startedAt={startedAt}
          error="[Mac AI] no first byte from the engine"
        />,
      );
      const clock = () => container.querySelector('.msg-live-status')?.textContent ?? '';
      const before = clock();
      expect(before).toMatch(/1:30/);

      await vi.advanceTimersByTimeAsync(30_000);
      rerender(
        <StreamingBubble
          authorLabel="Koray"
          authorIcon={null}
          segments={[]}
          startedAt={startedAt}
          error="[Mac AI] no first byte from the engine"
        />,
      );
      expect(clock()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
