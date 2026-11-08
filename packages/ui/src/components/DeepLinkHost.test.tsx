import type { GezelDeepLink } from '@bendyline/gezel';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navActions = vi.hoisted(() => ({
  runNavActions: vi.fn(),
  navigateToTab: vi.fn(),
  openHandboekArticleActions: vi.fn((id: string) => [{ kind: 'open-handboek', id }]),
}));

vi.mock('../api.js', () => ({
  api: {
    listProjects: vi.fn(async () => ({ projects: [{ id: 'default', name: 'Default' }] })),
    listGezels: vi.fn(async () => ({ gezels: [] })),
    getConfig: vi.fn(async () => ({ recentTabs: [] })),
  },
}));
vi.mock('./nav-actions.js', () => navActions);
vi.mock('../views/tasks/NewTaskDialog.js', () => ({
  NewTaskDialog: (props: { initialCraftbookId?: string; defaultProjectId: string }) => (
    <div data-testid="task-dialog">
      {props.initialCraftbookId} in {props.defaultProjectId}
    </div>
  ),
}));
vi.mock('../views/projects/NewProjectDialog.js', () => ({
  NewProjectDialog: (props: { initialTypeId?: string }) => (
    <div data-testid="project-dialog">{props.initialTypeId}</div>
  ),
}));

const { DeepLinkHost } = await import('./DeepLinkHost.js');

let deliver: ((link: GezelDeepLink) => void) | null = null;

beforeEach(() => {
  deliver = null;
  window.__GEZEL__ = {
    onDeepLink: (callback: (link: GezelDeepLink) => void) => {
      deliver = callback;
      return () => {
        deliver = null;
      };
    },
  } as unknown as NonNullable<typeof window.__GEZEL__>;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.__GEZEL__ = undefined;
});

async function send(link: unknown) {
  await act(async () => {
    deliver?.(link as GezelDeepLink);
  });
}

describe('DeepLinkHost', () => {
  it('opens an app link on the New Project form for that type', async () => {
    render(<DeepLinkHost onHome={vi.fn()} />);
    await send({ kind: 'app', id: 'meal-planner' });
    expect((await screen.findByTestId('project-dialog')).textContent).toBe('meal-planner');
  });

  it('opens a craftbook link on its launch form in the project new work goes to', async () => {
    render(<DeepLinkHost onHome={vi.fn()} />);
    await send({ kind: 'craftbook', id: 'fact-check' });
    expect((await screen.findByTestId('task-dialog')).textContent).toBe('fact-check in default');
  });

  it('opens a docs link as a Handboek article', async () => {
    render(<DeepLinkHost onHome={vi.fn()} />);
    await send({ kind: 'docs', id: 'model-scorecard' });
    expect(navActions.openHandboekArticleActions).toHaveBeenCalledWith('model-scorecard');
    expect(navActions.runNavActions).toHaveBeenCalledOnce();
  });

  it('goes Home for a home link and ignores a malformed one', async () => {
    const onHome = vi.fn();
    render(<DeepLinkHost onHome={onHome} />);
    await send({ kind: 'home' });
    expect(onHome).toHaveBeenCalledOnce();
    await send({ kind: 'app', id: '../../etc' });
    await send({ kind: 'run', id: 'fact-check' });
    expect(onHome).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('project-dialog')).toBeNull();
  });

  it('waits for the startup handoff before opening a link that launched the app', async () => {
    window.__GEZEL_STARTUP__ = {} as NonNullable<typeof window.__GEZEL_STARTUP__>;
    render(<DeepLinkHost onHome={vi.fn()} />);
    await send({ kind: 'app', id: 'word-clues' });
    expect(screen.queryByTestId('project-dialog')).toBeNull();
    window.__GEZEL_STARTUP__ = undefined;
    await act(async () => {
      window.dispatchEvent(new Event('gezel:startup-finished'));
    });
    expect((await screen.findByTestId('project-dialog')).textContent).toBe('word-clues');
  });

  it('stops listening when it unmounts', () => {
    const { unmount } = render(<DeepLinkHost onHome={vi.fn()} />);
    expect(deliver).not.toBeNull();
    unmount();
    expect(deliver).toBeNull();
  });
});
