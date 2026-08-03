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
 * A Home surface for the "What is gezel?" Handboek article
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
  // doc keeps them so the synthetic clock paces the video.
  const doc = useMemo(() => {
    if (!article) return null;
    try {
      return markdownToDoc(parseMarkdown(article.markdown));
    } catch {
      return null;
    }
  }, [article]);
  const playerDoc = useMemo(() => {
    if (!article) return null;
    try {
      return markdownToDoc(parseMarkdown(article.markdown), {
        articleId: article.id,
        defaultDuration: article.defaultDuration ?? 6,
      });
    } catch {
      return null;
    }
  }, [article]);

  // Intra-article links (`the-crew.md`, `projects-and-threads.md`) can't
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
            Read
          </button>
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === 'video'}
            className={mode === 'video' ? 'gz-key gz-key-active' : 'gz-key'}
            onClick={() => setMode('video')}
          >
            Watch
          </button>
        </div>
      </div>
      <div className="home-intro-page">
        <MediaContext.Provider value={mediaProvider}>
          {mode === 'doc' ? (
            <div className="home-intro-doc" onClickCapture={onDocClickCapture}>
              {/* No synthesized cover, same call HandboekView makes.
                  LinearDocView's default turns `doc.startBlock` into a
                  full-bleed hero: a page-tall band whose backdrop is the
                  article's leading figure and whose title/subtitle restate
                  the first section verbatim a scroll above the real thing.
                  Without it the article opens on its own heading with the
                  brand mark at editorial size beside the prose. Video mode
                  keeps its cover — a title slide is the right opening
                  frame there. */}
              <LinearDocView
                doc={doc}
                className="gezel-article-view"
                theme={gezelChatTheme}
                surface={surface}
                thinMargins
                imageDisplayMode="inline"
                showCover={false}
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
