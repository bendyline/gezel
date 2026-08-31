import type { ChatEventEnvelope, GezelSummary, ProjectDetail } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

/**
 * What the chat pane shows before its roster arrives. Switching projects
 * remounts `ProjectChat` with an empty gezel list, so the genuine "no
 * gezellen" copy used to flash on every switch — a claim that was simply
 * false for any staffed project. The pane must stay silent until the roster
 * answers, and only then say the crew is empty.
 */

const stream = vi.hoisted(() => ({
  async *consume(): AsyncGenerator<ChatEventEnvelope> {
    await new Promise<void>(() => {});
  },
}));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));
vi.mock('../views/tasks/NewTaskDialog.js', () => ({ NewTaskDialog: () => null }));
vi.mock('./ProjectTimeline.js', () => ({ ProjectTimeline: () => <div data-testid="timeline" /> }));
vi.mock('./TerminalComposer.js', () => ({
  TerminalComposer: () => <div data-testid="terminal" />,
  queueTerminalCommand: vi.fn(),
}));
vi.mock('./SessionSwitcher.js', () => ({ SessionSwitcher: () => null }));
vi.mock('./ChatReferences.js', () => ({
  ChatReferences: ({ children }: { children: (api: Record<string, unknown>) => ReactNode }) => (
    <div>
      {children({
        onToolActivity: vi.fn(),
        onArtifactReference: vi.fn(),
        onWorkspaceReference: vi.fn(),
        onTaskReference: vi.fn(),
      })}
    </div>
  ),
}));
vi.mock('./ChatComposer.js', () => ({
  ChatComposer: ({ gezelId }: { gezelId: string }) => (
    <div data-testid="composer" data-gezel={gezelId} />
  ),
}));

const { ProjectChat } = await import('./ProjectChat.js');
const { api } = await import('../api.js');

const PROJECT = {
  id: 'p1',
  name: 'gezel',
  voormanGezelId: 'g1',
  gezelIds: ['g1'],
} as unknown as ProjectDetail;

const GEZELS = [{ id: 'g1', name: 'Amadou' }] as unknown as GezelSummary[];

const EMPTY_COPY = /No gezellen available to chat with yet/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] });
  vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] });
});

describe('ProjectChat hydration placeholder', () => {
  it('shows the composer-shaped placeholder instead of the empty state while the roster loads', async () => {
    let resolveRoster: (value: { gezels: GezelSummary[] }) => void = () => {};
    vi.mocked(api.listGezels).mockReturnValue(
      new Promise((resolve) => {
        resolveRoster = resolve;
      }),
    );

    const { container } = render(<ProjectChat project={PROJECT} />);

    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(container.querySelector('.project-chat-placeholder')).toBeTruthy();
    // The stand-in draws the composer frame the hydrated pane settles into.
    expect(container.querySelector('.project-chat-compose-shell')).toBeTruthy();

    resolveRoster({ gezels: GEZELS });

    await waitFor(() => {
      expect(screen.getByTestId('composer')).toHaveAttribute('data-gezel', 'g1');
    });
    expect(container.querySelector('.project-chat-placeholder')).toBeNull();
  });

  it('says the crew is empty once the roster comes back empty', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] });

    const { container } = render(<ProjectChat project={PROJECT} />);

    await waitFor(() => {
      expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    });
    // The pane's own children carry the gutters, so the bare paragraph
    // that replaces them needs its own.
    expect(container.querySelector('.project-chat-empty')).toBeTruthy();
    expect(container.querySelector('.project-chat-placeholder')).toBeNull();
  });

  it('keeps the pane hydrated when the roster refetches after a voorman change', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS });

    const { container, rerender } = render(<ProjectChat project={PROJECT} />);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeInTheDocument());

    let resolveRefetch: (value: { gezels: GezelSummary[] }) => void = () => {};
    vi.mocked(api.listGezels).mockReturnValue(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    rerender(
      <ProjectChat project={{ ...PROJECT, gezelIds: ['g1', 'g2'] } as unknown as ProjectDetail} />,
    );

    expect(vi.mocked(api.listGezels)).toHaveBeenCalled();
    expect(container.querySelector('.project-chat-placeholder')).toBeNull();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    resolveRefetch({ gezels: GEZELS });
  });
});
