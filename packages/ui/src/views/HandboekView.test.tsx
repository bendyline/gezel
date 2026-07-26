import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// The squisq renderers pull in heavy layout/measurement machinery that
// jsdom can't drive — the view's own logic (TOC, selection, mode
// toggle, article fetch) is what this file covers.
vi.mock('@bendyline/squisq-react', () => ({
  LinearDocView: ({ doc }: { doc: unknown }) => (
    <div data-testid="linear-doc-view">
      {doc ? 'doc' : 'no-doc'}
      <a href="../conceptual/the-crew.md">crew link</a>
      <a href="craftbook/research-report">book link</a>
      <a href="https://gezelgilde.com">external link</a>
    </div>
  ),
  DocPlayer: ({ captionStyle, audioMode }: { captionStyle?: string; audioMode?: string }) => (
    <div
      data-testid="doc-player"
      data-caption-style={captionStyle ?? ''}
      data-audio-mode={audioMode ?? ''}
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
    expect(await screen.findByTestId('linear-doc-view')).toBeInTheDocument();
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
