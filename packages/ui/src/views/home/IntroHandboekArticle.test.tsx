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
  LinearDocView: ({
    doc,
    showCover,
    className,
  }: {
    doc: unknown;
    showCover?: boolean;
    className?: string;
  }) => (
    <div
      data-testid="linear-doc-view"
      data-show-cover={String(showCover ?? true)}
      data-doc={JSON.stringify(doc)}
      className={className}
    >
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
    vi.mocked(api.readKnowledgeDocument).mockResolvedValue({
      id: 'welcome',
      title: 'What is gezel?',
      markdown: '# What is gezel?\n\nA crew of AI companions that works for you.',
    } as never);
  });

  it('fetches the welcome article and renders it as a document by default', async () => {
    render(<IntroHandboekArticle />);
    await waitFor(() => {
      expect(screen.getByTestId('linear-doc-view')).toBeInTheDocument();
    });
    expect(screen.getByTestId('linear-doc-view')).toHaveClass('gezel-article-view');
    expect(api.readKnowledgeDocument).toHaveBeenCalledWith('handboek', 'welcome');
    expect(screen.queryByTestId('doc-player')).not.toBeInTheDocument();
  });

  // The default cover turns the article's start block into a page-tall hero
  // band whose backdrop is the leading figure — in this card that rendered
  // the brand mark shrunk into the corner of an oversized slide, above a
  // title/subtitle restating the first section.
  it('reads without a synthesized cover page', async () => {
    render(<IntroHandboekArticle />);
    const view = await screen.findByTestId('linear-doc-view');
    expect(view).toHaveAttribute('data-show-cover', 'false');
  });

  // squisq paints an unresolved relative image before the media provider
  // answers, so the catalog path reached the network as /assets/gezel-mark.png
  // and 404ed on every Home load.
  it('points the brand mark at the bundled image before the first paint', async () => {
    vi.mocked(api.readKnowledgeDocument).mockResolvedValue({
      id: 'welcome',
      title: 'What is gezel?',
      markdown: '# What is gezel?\n\n![gezel-mark](assets/gezel-mark.png)\n\nA crew.',
    } as never);
    render(<IntroHandboekArticle />);
    const view = await screen.findByTestId('linear-doc-view');
    const doc = view.getAttribute('data-doc') ?? '';
    expect(doc).toContain('gezel-mark');
    expect(doc).not.toContain('"assets/gezel-mark.png"');
  });

  it('switches to the synthetic-clock video player and back', async () => {
    const user = userEvent.setup();
    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');

    await user.click(screen.getByRole('radio', { name: 'Watch' }));
    expect(screen.getByTestId('doc-player')).toHaveAttribute('data-audio-mode', 'synthetic');

    await user.click(screen.getByRole('radio', { name: 'Read' }));
    expect(screen.getByTestId('linear-doc-view')).toBeInTheDocument();
  });

  it('routes "Open in Handboek" to its Knowledge catalog', async () => {
    const user = userEvent.setup();
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:open-knowledge-document', handler);

    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByRole('button', { name: /Open in Handboek/ }));
    window.removeEventListener('gezel:open-knowledge-document', handler);

    expect(events.at(-1)?.detail).toEqual({ catalogId: 'handboek', documentId: 'welcome' });
  });

  it('sends intra-article links to the Handboek on the linked article', async () => {
    const user = userEvent.setup();
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:open-knowledge-document', handler);

    render(<IntroHandboekArticle />);
    await screen.findByTestId('linear-doc-view');
    await user.click(screen.getByText('crew link'));
    window.removeEventListener('gezel:open-knowledge-document', handler);

    expect(events.at(-1)?.detail).toEqual({ catalogId: 'handboek', documentId: 'the-crew' });
  });

  it('falls back to a Handboek link when the article fetch fails', async () => {
    vi.mocked(api.readKnowledgeDocument).mockRejectedValue(new Error('boom'));
    render(<IntroHandboekArticle />);
    await waitFor(() => {
      expect(screen.getByTestId('home-intro-handboek-fallback')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('linear-doc-view')).not.toBeInTheDocument();
  });
});
