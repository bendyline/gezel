import type { ChatEventEnvelope, ListTimelineResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const streamState = vi.hoisted(() => ({ mode: 'live' as 'live' | 'completed' }));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));

vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({
    signal,
  }: {
    signal?: AbortSignal;
  }) {
    const phase = (sessionId: string, path: string) =>
      ({
        sessionId,
        gezelId: 'mhairi',
        projectId: 'website',
        event: {
          type: 'engine_phase',
          provider: 'mlx',
          phase: 'generating',
          activity: `Indexing ${path}`,
          detail: 'Generating',
        },
      }) satisfies ChatEventEnvelope;
    const done = (sessionId: string) =>
      ({
        sessionId,
        gezelId: 'mhairi',
        projectId: 'website',
        event: { type: 'done' },
      }) satisfies ChatEventEnvelope;

    yield phase('one-shot:index-file', 'foo.html');
    if (streamState.mode === 'completed') {
      yield done('one-shot:index-file');
      yield phase('one-shot:index-file-2', 'src/bar.ts');
      yield done('one-shot:index-file-2');
      // Code files can receive a summary pass and a symbol-summary pass.
      // The receipt should count the path once.
      yield phase('one-shot:index-file-3', 'foo.html');
      yield done('one-shot:index-file-3');
    }
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

describe('ChatTimelineView — background one-shot activity', () => {
  let boundsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    streamState.mode = 'live';
    window.localStorage.clear();
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    boundsSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const element = this as HTMLElement;
      const height = element.matches('[data-msg-id^="live:"]')
        ? 100
        : element.classList.contains('timeline-session-divider-activity')
          ? 20
          : 0;
      return {
        x: 0,
        y: 0,
        width: 800,
        height,
        top: 0,
        right: 800,
        bottom: height,
        left: 0,
        toJSON: () => ({}),
      };
    });
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'mhairi', name: 'Mhairi', role: 'Boekwachter' }],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'website', name: 'Website' }],
    } as never);
  });

  afterEach(() => boundsSpy.mockRestore());

  it('names the activity instead of presenting the one-shot as a new chat thread', async () => {
    render(
      <ChatTimelineView
        scopeKey="global"
        activeSessionId={undefined}
        loadTimeline={async () => ({ messages: [], hasMore: false }) as ListTimelineResponse}
        streamUrl={() => 'https://example.invalid/events'}
        showProjectName
      />,
    );

    const divider = await waitFor(() => {
      const node = document.querySelector('.timeline-session-divider-activity');
      if (!node) throw new Error('background activity divider not rendered');
      return node;
    });
    expect(divider).toHaveTextContent('Mhairi · Indexing foo.html · in Website');
    expect(divider.tagName).toBe('OUTPUT');
    expect(screen.queryByText(/new thread with Mhairi/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Indexing foo\.html · Generating/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    expect(document.querySelector('.timeline-indexing-receipt')).toHaveTextContent(
      'Mhairi has indexed 1 file in Website',
    );
    const runway = document.querySelector<HTMLElement>('.timeline-response-runway');
    expect(runway).toBeInTheDocument();
    expect(Number.parseFloat(runway?.style.blockSize ?? '300')).toBeLessThan(300);
  });

  it('replaces completed file turns with one expandable, de-duplicated receipt', async () => {
    streamState.mode = 'completed';
    const onWorkspaceReference = vi.fn();
    render(
      <ChatTimelineView
        scopeKey="global"
        activeSessionId={undefined}
        loadTimeline={async () => ({ messages: [], hasMore: false }) as ListTimelineResponse}
        streamUrl={() => 'https://example.invalid/events'}
        showProjectName
        onWorkspaceReference={onWorkspaceReference}
      />,
    );

    const receipt = await waitFor(() => {
      const node = document.querySelector('.timeline-indexing-receipt');
      if (!node) throw new Error('indexing receipt not rendered');
      expect(node).toHaveTextContent('Mhairi has indexed 2 files in Website');
      return node as HTMLDetailsElement;
    });
    expect(receipt.open).toBe(false);
    expect(screen.queryByRole('button', { name: 'Open foo.html' })).not.toBeInTheDocument();
    expect(document.querySelector('.timeline-session-divider-activity')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('.timeline-response-runway')?.style.blockSize,
      ).toBe('300px'),
    );

    fireEvent.click(receipt.querySelector('summary')!);
    const foo = await screen.findByRole('button', { name: 'Open foo.html' });
    expect(screen.getByRole('button', { name: 'Open src/bar.ts' })).toBeInTheDocument();
    fireEvent.click(foo);
    expect(onWorkspaceReference).toHaveBeenCalledWith('foo.html', 'website');
  });
});
