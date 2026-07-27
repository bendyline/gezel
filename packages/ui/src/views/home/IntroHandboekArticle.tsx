import type { HandboekArticle } from '@bendyline/gezel';
import { DocPlayer, LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from '../../components/chat-theme.js';
import { useEffectiveTheme } from '../../theme.js';
import { createHandboekMediaProvider } from '../handboek/HandboekMediaProvider.js';

const ARTICLE_ID = 'welcome';

/** HandboekView's persisted selection — set before navigating so the
 * Handboek opens on the article the user clicked. */
const HANDBOEK_SELECTED_KEY = 'gezel:handboek:article';

type ViewMode = 'doc' | 'video';

function openHandboek(articleId: string) {
  try {
    window.localStorage.setItem(HANDBOEK_SELECTED_KEY, articleId);
  } catch {
    // localStorage unavailable — the Handboek just opens on its default.
  }
  window.dispatchEvent(new CustomEvent('gezel:navigate', { detail: { view: 'handboek' } }));
}

/**
 * The first-run intro card's body: the "What is gezel?" Handboek article
 * embedded as a live page — readable as a document or playable as a
 * captioned video — instead of prose hardcoded into the Home view. The
 * article is the single source of that copy; this is just a small frame
 * around the same engine HandboekView uses.
 */
export function IntroHandboekArticle() {
  const [article, setArticle] = useState<HandboekArticle | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<ViewMode>('doc');
  // In light mode overlay the shared warm-paper reading surface (the
  // gezellig theme's own pages are dark); in dark mode let the theme's
  // warm-tinted dark background come through — same rule as chat bubbles.
  const effectiveTheme = useEffectiveTheme();
  const surface = effectiveTheme === 'light' ? GEZEL_LIGHT_SURFACE : undefined;

  useEffect(() => {
    let alive = true;
    api
      .getHandboekArticle(ARTICLE_ID)
      .then((a) => {
        if (!alive) return;
        if (a && typeof a.markdown === 'string') setArticle(a);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const mediaProvider = useMemo(
    () => (article ? createHandboekMediaProvider(article.figures ?? []) : null),
    [article],
  );
  const providerRef = useRef(mediaProvider);
  useEffect(() => {
    providerRef.current = mediaProvider;
    return () => providerRef.current?.dispose?.();
  }, [mediaProvider]);

  // Two doc builds from one markdown. The reading doc carries no block
  // durations — durations turn LinearDocView into a timed reader that
  // dims all but the active block, wrong for a static embed. The player
  // doc keeps them so the synthetic clock paces the video. Both drop the
  // article's own `# title`: the gezellig theme renders a level-1
  // heading as a full-height hero page, which is the right move in the
  // Handboek but overwhelms this embed — the card's wordmark header
  // already names the subject.
  const markdown = useMemo(() => article?.markdown.replace(/^#\s+[^\n]*\n/, '') ?? null, [article]);
  const doc = useMemo(() => {
    if (markdown === null) return null;
    try {
      return markdownToDoc(parseMarkdown(markdown));
    } catch {
      return null;
    }
  }, [markdown]);
  const playerDoc = useMemo(() => {
    if (markdown === null || !article) return null;
    try {
      return markdownToDoc(parseMarkdown(markdown), {
        articleId: article.id,
        defaultDuration: article.defaultDuration ?? 6,
      });
    } catch {
      return null;
    }
  }, [markdown, article]);

  // Intra-article links (`the-crew.md`, `projects-and-sessions.md`) can't
  // resolve inside the Home card — send them to the Handboek, landing on
  // the linked article (curated ids equal their file stems; HandboekView
  // falls back to its default when a stem doesn't match the TOC).
  const onDocClickCapture = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const raw = anchor.getAttribute('href');
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const stem = raw
      .split(/[?#]/)[0]!
      .replace(/\.md$/, '')
      .replace(/^(\.\.?\/)+/, '')
      .split('/')
      .pop();
    openHandboek(stem || ARTICLE_ID);
  };

  if (failed) {
    return (
      <p>
        <button
          type="button"
          className="home-link"
          onClick={() => openHandboek(ARTICLE_ID)}
          data-testid="home-intro-handboek-fallback"
        >
          Open the Handboek for an introduction to gezel →
        </button>
      </p>
    );
  }

  if (!doc || !mediaProvider) {
    return (
      <p className="muted" aria-live="polite">
        Loading the Handboek…
      </p>
    );
  }

  return (
    <div className="home-intro-article" data-testid="home-intro-article">
      <div className="home-intro-article-controls">
        <button
          type="button"
          className="home-link"
          onClick={() => openHandboek(ARTICLE_ID)}
          title="Read this article in the Handboek"
        >
          Open in Handboek →
        </button>
        <div className="gz-tray handboek-mode-tray" role="radiogroup" aria-label="View as">
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === 'doc'}
            className={mode === 'doc' ? 'gz-key gz-key-active' : 'gz-key'}
            onClick={() => setMode('doc')}
          >
            Document
          </button>
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === 'video'}
            className={mode === 'video' ? 'gz-key gz-key-active' : 'gz-key'}
            onClick={() => setMode('video')}
          >
            Video
          </button>
        </div>
      </div>
      <div className="home-intro-page">
        <MediaContext.Provider value={mediaProvider}>
          {mode === 'doc' ? (
            <div className="home-intro-doc" onClickCapture={onDocClickCapture}>
              <LinearDocView
                doc={doc}
                theme={gezelChatTheme}
                surface={surface}
                thinMargins
                imageDisplayMode="inline"
              />
            </div>
          ) : (
            <div className="home-intro-player">
              <DocPlayer
                doc={playerDoc ?? doc}
                theme={gezelChatTheme}
                displayMode="video"
                audioMode="synthetic"
                captionsEnabled
                captionStyle="social"
                autoPlay
                showControls
                showScrubber
              />
            </div>
          )}
        </MediaContext.Provider>
      </div>
    </div>
  );
}
