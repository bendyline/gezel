import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
// `useEffectiveTheme` subscribes to `window.matchMedia`, which jsdom doesn't
// implement — stub it (same as the DocumentsView / DocumentDetail specs).
vi.mock('../../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

// The squisq renderers pull in heavy layout/measurement machinery that
// jsdom can't drive — the embed's own logic (article fetch, doc/video
// toggle, link routing to the Handboek) is what this file covers.
vi.mock('@bendyline/squisq-react', () => ({
  LinearDocView: ({ doc }: { doc: unknown }) => (
    <div data-testid="linear-doc-view">
      {doc ? 'doc' : 'no-doc'}
      <a href="the-crew.md">crew link</a>
      <a href="https://gezelgilde.com">external link</a>
    </div>
  ),
  DocPlayer: ({ audioMode }: { audioMode?: string }) => (
    <div data-testid="doc-player" data-audio-mode={audioMode ?? ''}>
      player
    </div>
  ),
  MediaContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

const { IntroHandboekArticle } = await import('./IntroHandboekArticle.js');
const { api } = await import('../../api.js');

describe('IntroHandboekArticle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.getHandboekArticle).mockResolvedValue({
      id: 'welcome',
      title: 'What is gezel?',
      area: 'conceptual',
      markdown: '# What is gezel?\n\nA crew of AI companions that works for you.',
      figures: [],
      generated: false,
    } as never);
  });

  it('fetches the welcome article and renders it as a document by default', async () => {
    render(<IntroHandboekArticle />);
    await waitFor(() => {
      expect(screen.getByTestId('linear-doc-view')).toBeInTheDocument();
    });
    expect(api.getHandboekArticle).toHaveBeenCalledWith('welcome');
    expect(screen.queryByTestId('doc-player')).not.toBeInTheDocument();
  });

  it('switches to the synthetic-clock video player and back', async () => {
    const user = userEvent.setup();
    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');

    await user.click(screen.getByRole('radio', { name: 'Video' }));
    expect(screen.getByTestId('doc-player')).toHaveAttribute('data-audio-mode', 'synthetic');

    await user.click(screen.getByRole('radio', { name: 'Document' }));
    expect(screen.getByTestId('linear-doc-view')).toBeInTheDocument();
  });

  it('routes "Open in Handboek" to the handboek view, landing on the article', async () => {
    const user = userEvent.setup();
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:navigate', handler);

    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('button', { name: /Open in Handboek/ }));
    window.removeEventListener('gezel:navigate', handler);

    expect(events.at(-1)?.detail).toEqual({ view: 'handboek' });
    expect(window.localStorage.getItem('gezel:handboek:article')).toBe('welcome');
  });

  it('sends intra-article links to the Handboek on the linked article', async () => {
    const user = userEvent.setup();
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:navigate', handler);

    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByText('crew link'));
    window.removeEventListener('gezel:navigate', handler);

    expect(events.at(-1)?.detail).toEqual({ view: 'handboek' });
    expect(window.localStorage.getItem('gezel:handboek:article')).toBe('the-crew');
  });

  it('falls back to a Handboek link when the article fetch fails', async () => {
    vi.mocked(api.getHandboekArticle).mockRejectedValue(new Error('boom'));
    render(<IntroHandboekArticle />);
    await waitFor(() => {
      expect(screen.getByTestId('home-intro-handboek-fallback')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('linear-doc-view')).not.toBeInTheDocument();
  });
});
