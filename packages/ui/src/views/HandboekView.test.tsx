import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

// The squisq renderers pull in heavy layout/measurement machinery that
// jsdom can't drive — the view's own logic (TOC, selection, mode
// toggle, article fetch) is what this file covers.
vi.mock('@bendyline/squisq-react', () => ({
  LinearDocView: ({
    doc,
    className,
    surface,
  }: {
    doc: unknown;
    className?: string;
    surface?: { id: string };
  }) => (
    <div data-testid="linear-doc-view" data-surface-id={surface?.id ?? ''} className={className}>
      {doc ? 'doc' : 'no-doc'}
      <a href="../conceptual/the-crew.md">crew link</a>
      <a href="craftbook/research-report">book link</a>
      <a href="https://gezelgilde.com">external link</a>
    </div>
  ),
  DocPlayer: ({
    captionStyle,
    audioMode,
    doc,
    surface,
  }: {
    captionStyle?: string;
    audioMode?: string;
    doc?: { audio?: { segments: { duration: number }[] } };
    surface?: { id: string };
  }) => (
    <div
      data-testid="doc-player"
      data-caption-style={captionStyle ?? ''}
      data-audio-mode={audioMode ?? ''}
      data-surface-id={surface?.id ?? ''}
      data-clock-length={String(
        (doc?.audio?.segments ?? []).reduce((total, seg) => total + seg.duration, 0),
      )}
    >
      player
    </div>
  ),
  MediaContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

const { HandboekView } = await import('./HandboekView.js');
const { api } = await import('../api.js');

// jsdom has no object-URL support; the narration flow needs both ends.
if (typeof URL.createObjectURL !== 'function') {
  Object.assign(URL, {
    createObjectURL: () => `blob:mock-${Math.random()}`,
    revokeObjectURL: () => {},
  });
}

const TOC = {
  areas: [
    {
      area: 'conceptual',
      title: 'Concepts',
      entries: [
        {
          id: 'welcome',
          title: 'What is gezel?',
          area: 'conceptual',
          order: 1,
          summary: 'Intro.',
          generated: false,
        },
        {
          id: 'the-crew',
          title: 'Your crew',
          area: 'conceptual',
          order: 2,
          generated: false,
        },
      ],
    },
    {
      area: 'gezel-roles',
      title: 'Gezel Roles',
      entries: [
        {
          id: 'role/meester',
          title: 'The Meester',
          area: 'gezel-roles',
          order: 1,
          generated: false,
        },
      ],
    },
    {
      area: 'craftbooks',
      title: 'Craftbooks',
      entries: [
        {
          id: 'craftbooks-index',
          title: 'Every craftbook',
          area: 'craftbooks',
          order: 0,
          generated: true,
        },
        {
          id: 'craftbook/project-kickoff',
          title: 'Project Kickoff',
          area: 'craftbooks',
          order: 10,
          generated: true,
          subcategory: {
            id: 'project-starter',
            title: 'New project starters',
            order: 0,
          },
        },
        {
          id: 'craftbook/status-report',
          title: 'Status Report',
          area: 'craftbooks',
          order: 10,
          generated: true,
          subcategory: {
            id: 'general',
            title: 'General work',
            order: 2,
          },
        },
      ],
    },
  ],
};

function articleFor(id: string) {
  return {
    id,
    title: id === 'welcome' ? 'What is gezel?' : `Article ${id}`,
    area: 'conceptual',
    markdown: `# Heading for ${id}\n\nBody text.`,
    figures: [],
    generated: false,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.getHandboekToc).mockResolvedValue(TOC as never);
  vi.mocked(api.getHandboekArticle).mockImplementation(
    async (id: string) => articleFor(id) as never,
  );
});

describe('HandboekView', () => {
  it('renders the TOC grouped by area and auto-opens the first article', async () => {
    render(<HandboekView />);
    await waitFor(() => {
      expect(screen.getByText('Concepts')).toBeInTheDocument();
    });
    expect(screen.getByText('Gezel Roles')).toBeInTheDocument();
    expect(screen.getByText('The Meester')).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getHandboekArticle).toHaveBeenCalledWith('welcome');
    });
    expect(await screen.findByTestId('linear-doc-view')).toHaveClass('gezel-article-view');
    expect(screen.getByRole('heading', { level: 2, name: 'What is gezel?' })).toBeInTheDocument();
  });

  it('switches article on TOC click and persists the selection', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    const crewEntry = await screen.findByRole('button', { name: 'Your crew' });
    await user.click(crewEntry);
    await waitFor(() => {
      expect(api.getHandboekArticle).toHaveBeenCalledWith('the-crew');
    });
    expect(window.localStorage.getItem('gezel:handboek:article')).toBe('the-crew');
    expect(crewEntry).toHaveAttribute('aria-current', 'page');
  });

  it('collapses and expands each top-level section', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    const concepts = await screen.findByRole('button', { name: 'Concepts' });
    expect(concepts).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Your crew' })).toBeInTheDocument();

    await user.click(concepts);
    expect(concepts).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Your crew' })).not.toBeInTheDocument();

    await user.click(concepts);
    expect(concepts).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Your crew' })).toBeInTheDocument();
  });

  it('groups craftbooks into shelves that are collapsed by default', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByRole('button', { name: 'Craftbooks' });

    expect(screen.getByRole('button', { name: 'Every craftbook' })).toBeInTheDocument();
    const general = screen.getByRole('button', { name: 'General work' });
    expect(general).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Status Report' })).not.toBeInTheDocument();

    await user.click(general);
    expect(general).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Status Report' })).toBeInTheDocument();
  });

  it('reveals the shelf containing a restored craftbook selection', async () => {
    window.localStorage.setItem('gezel:handboek:article', 'craftbook/status-report');
    render(<HandboekView />);

    const general = await screen.findByRole('button', { name: 'General work' });
    await waitFor(() => expect(general).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByRole('button', { name: 'Status Report' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('restores a stored selection when it still exists', async () => {
    window.localStorage.setItem('gezel:handboek:article', 'role/meester');
    render(<HandboekView />);
    await waitFor(() => {
      expect(api.getHandboekArticle).toHaveBeenCalledWith('role/meester');
    });
  });

  it('toggles between document and video modes via the tray', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('radio', { name: 'Video' }));
    const player = await screen.findByTestId('doc-player');
    expect(player).toHaveAttribute('data-caption-style', 'social');
    expect(screen.queryByTestId('linear-doc-view')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Document' }));
    expect(await screen.findByTestId('linear-doc-view')).toBeInTheDocument();
  });

  it('uses the light reading surface in both document and video modes', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    expect(await screen.findByTestId('linear-doc-view')).toHaveAttribute(
      'data-surface-id',
      'gezel-chat-light',
    );

    await user.click(screen.getByRole('radio', { name: 'Video' }));
    expect(await screen.findByTestId('doc-player')).toHaveAttribute(
      'data-surface-id',
      'gezel-chat-light',
    );
  });

  it('gives the unnarrated player a clock to run on', async () => {
    // An article with no narration still has to play. The player takes its
    // timeline length from the audio track, so a doc with no segments leaves
    // it frozen at 0:00 / 0:00 — see the synthetic-segment shim in the view.
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('radio', { name: 'Video' }));
    const player = await screen.findByTestId('doc-player');
    expect(player).toHaveAttribute('data-audio-mode', 'synthetic');
    expect(Number(player.getAttribute('data-clock-length'))).toBeGreaterThan(0);
  });

  it('offers Listen in video mode when TTS is healthy and switches to media audio', async () => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue({
      stt: { status: 'no-model' },
      tts: { status: 'ok' },
    } as never);
    // The test article's markdown parses to exactly one doc block, so a
    // one-segment manifest aligns 1:1 and narration engages for real.
    vi.mocked(api.getHandboekNarration).mockResolvedValue({
      articleId: 'welcome',
      voice: 'mock',
      model: 'mock',
      segments: [{ blockId: 'b1', hash: 'a'.repeat(64), durationMs: 500 }],
    } as never);
    vi.mocked(api.fetchHandboekNarrationAudio).mockResolvedValue(new Blob(['x']) as never);
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('radio', { name: 'Video' }));
    const listen = await screen.findByRole('button', { name: 'Listen' });
    await user.click(listen);
    await waitFor(() => {
      expect(api.getHandboekNarration).toHaveBeenCalledWith('welcome');
    });
    await waitFor(() => {
      expect(screen.getByTestId('doc-player')).toHaveAttribute('data-audio-mode', 'media');
    });
  });

  it('hides Listen when the TTS engine is not ready', async () => {
    vi.mocked(api.getAudioEngineStatus).mockResolvedValue({
      stt: { status: 'no-model' },
      tts: { status: 'no-model' },
    } as never);
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('radio', { name: 'Video' }));
    await screen.findByTestId('doc-player');
    expect(screen.queryByRole('button', { name: 'Listen' })).not.toBeInTheDocument();
  });

  it('intercepts relative article links and resolves them against the TOC', async () => {
    const user = userEvent.setup();
    render(<HandboekView />);
    await screen.findByTestId('linear-doc-view');
    // Relative .md path → stem-matched against TOC ids.
    await user.click(screen.getByText('crew link'));
    await waitFor(() => {
      expect(api.getHandboekArticle).toHaveBeenCalledWith('the-crew');
    });
  });

  it('surfaces article load errors', async () => {
    vi.mocked(api.getHandboekArticle).mockRejectedValue(new Error('boom'));
    render(<HandboekView />);
    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument();
    });
  });
});
