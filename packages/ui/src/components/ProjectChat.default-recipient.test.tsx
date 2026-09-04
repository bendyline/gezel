import type {
  ChatEventEnvelope,
  ChatSessionSummary,
  GezelSummary,
  ProjectDetail,
} from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

/**
 * Who the composer is addressed to when the user opens a project, and which
 * thread it posts into. Continuity wins while a conversation is still live;
 * past the staleness floor the voorman gets a blank thread instead of the
 * user silently resuming something they finished days ago.
 *
 * `SessionSwitcher` is REAL here — its auto-pick is half the behavior under
 * test, and stubbing it would hide exactly the stomp these tests exist for.
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
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));
vi.mock('../views/tasks/NewTaskDialog.js', () => ({ NewTaskDialog: () => null }));
vi.mock('./ProjectTimeline.js', () => ({ ProjectTimeline: () => <div data-testid="timeline" /> }));
vi.mock('./TerminalComposer.js', () => ({
  TerminalComposer: () => <div data-testid="terminal" />,
  queueTerminalCommand: vi.fn(),
}));
vi.mock('./ChatReferences.js', () => ({
  ChatReferences: ({
    banner,
    children,
  }: {
    banner?: (api: Record<string, unknown>) => ReactNode;
    children: (api: Record<string, unknown>) => ReactNode;
  }) => {
    const api = {
      onToolActivity: vi.fn(),
      onArtifactReference: vi.fn(),
      onWorkspaceReference: vi.fn(),
      onTaskReference: vi.fn(),
    };
    return (
      <div>
        {banner?.(api)}
        {children(api)}
      </div>
    );
  },
}));
// Surfaces the recipient + thread the composer would post to, and exposes
// the To-line pivot so a test can act as the user picking someone else.
vi.mock('./ChatComposer.js', () => ({
  ChatComposer: ({
    gezelId,
    sessionId,
    belowAddressLine,
    onPrimaryRecipientChange,
  }: {
    gezelId: string;
    sessionId?: string;
    belowAddressLine?: ReactNode;
    onPrimaryRecipientChange?: (gezelId: string) => void;
  }) => (
    <div data-testid="composer" data-gezel={gezelId} data-session={sessionId ?? ''}>
      <button type="button" onClick={() => onPrimaryRecipientChange?.('g2')}>
        Pick Wren
      </button>
      {belowAddressLine}
    </div>
  ),
}));

const { ProjectChat } = await import('./ProjectChat.js');
const { api } = await import('../api.js');

const PROJECT = {
  id: 'p1',
  name: 'gezel',
  voormanGezelId: 'g1',
  gezelIds: ['g1', 'g2'],
} as unknown as ProjectDetail;

const GEZELS = [
  { id: 'g1', name: 'Amadou' },
  { id: 'g2', name: 'Wren' },
] as unknown as GezelSummary[];

const HOURS_AGO_2 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const DAYS_AGO_3 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function session(
  id: string,
  gezelId: string,
  overrides: Partial<ChatSessionSummary> = {},
): ChatSessionSummary {
  return {
    id,
    gezelId,
    projectId: 'p1',
    providerName: 'mock',
    title: `Thread ${id}`,
    createdAt: DAYS_AGO_3,
    lastActivityAt: HOURS_AGO_2,
    lastHumanActivityAt: HOURS_AGO_2,
    archived: false,
    ...overrides,
  } as ChatSessionSummary;
}

/** Newest-first, and scoped to one gezel when the caller asks for that. */
function mockSessions(sessions: ChatSessionSummary[]) {
  vi.mocked(api.listChatSessions).mockImplementation(async (filter) => ({
    sessions: filter?.gezelId ? sessions.filter((s) => s.gezelId === filter.gezelId) : sessions,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS });
  vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] });
  vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] });
  mockSessions([]);
});

describe('ProjectChat default recipient', () => {
  it('resumes the conversation the user is still in the middle of', async () => {
    mockSessions([session('wren-live', 'g2'), session('amadou-old', 'g1', { ...stale() })]);

    render(<ProjectChat project={PROJECT} />);

    await waitFor(() => {
      const composer = screen.getByTestId('composer');
      expect(composer).toHaveAttribute('data-gezel', 'g2');
      expect(composer).toHaveAttribute('data-session', 'wren-live');
    });
  });

  it('falls back to the voorman on a blank thread once the last one is stale', async () => {
    // Exactly the shape that made opening the gezel project land on the
    // meester: the newest ordinary thread is days old, and it is not the
    // voorman's.
    mockSessions([
      session('wren-stale', 'g2', { ...stale() }),
      session('amadou-stale', 'g1', { ...stale() }),
    ]);

    render(<ProjectChat project={PROJECT} />);

    await waitFor(() => {
      expect(screen.getByTestId('composer')).toHaveAttribute('data-gezel', 'g1');
    });
    // Blank: the switcher must not auto-pick the voorman's own stale thread
    // either. `ChatComposer` lazy-creates on the first send.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('composer')).toHaveAttribute('data-session', '');
    expect(vi.mocked(api.createChatSession)).not.toHaveBeenCalled();
  });

  it('does not count a nudge as the user still being in the conversation', async () => {
    // A meester check-in bumped `lastActivityAt` overnight; the user has not
    // said anything for days.
    mockSessions([
      session('wren-nudged', 'g2', {
        lastActivityAt: HOURS_AGO_2,
        lastHumanActivityAt: DAYS_AGO_3,
      }),
    ]);

    render(<ProjectChat project={PROJECT} />);

    await waitFor(() => {
      const composer = screen.getByTestId('composer');
      expect(composer).toHaveAttribute('data-gezel', 'g1');
      expect(composer).toHaveAttribute('data-session', '');
    });
  });

  it('gives an explicitly picked recipient their newest thread back', async () => {
    mockSessions([
      session('wren-stale', 'g2', { ...stale() }),
      session('amadou-stale', 'g1', { ...stale() }),
    ]);

    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);
    await waitFor(() => {
      expect(screen.getByTestId('composer')).toHaveAttribute('data-gezel', 'g1');
    });

    await user.click(screen.getByRole('button', { name: 'Pick Wren' }));

    // Choosing someone deliberately is not the arrival default — the user
    // asked for Wren, so they get the conversation they had with Wren.
    await waitFor(() => {
      const composer = screen.getByTestId('composer');
      expect(composer).toHaveAttribute('data-gezel', 'g2');
      expect(composer).toHaveAttribute('data-session', 'wren-stale');
    });
  });

  it('lists the thread starters the composer files here', async () => {
    // The composer stamps every draft with this surface's scope and the
    // picker filters on it. When the two disagree the Drafts section is
    // permanently empty, and a draft you can see yourself typing vanishes
    // from the menu the moment you look at another thread.
    mockSessions([session('s1', 'g1')]);
    vi.mocked(api.listPromptDrafts).mockResolvedValue({
      drafts: [
        {
          id: '2026-09-03-0007',
          projectId: 'p1',
          gezelId: 'g1',
          sessionId: null,
          scope: 'project',
          status: 'draft',
          title: 'sdfsd',
          createdAt: HOURS_AGO_2,
          updatedAt: HOURS_AGO_2,
          hasFiles: false,
          fileCount: 0,
        },
      ],
    } as never);

    render(<ProjectChat project={PROJECT} />);

    expect(await screen.findByRole('option', { name: /sdfsd/ })).toBeInTheDocument();
  });
});

function stale(): Partial<ChatSessionSummary> {
  return { lastActivityAt: DAYS_AGO_3, lastHumanActivityAt: DAYS_AGO_3 };
}
