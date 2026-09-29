import { parseKnowledgeUri } from '@bendyline/gezel';
import type { KnowledgeDocumentRead } from '@bendyline/gezel-client';
import { DocPlayer, LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from '../../components/chat-theme.js';
import { navigateToTab } from '../../components/nav-actions.js';
import { queueOpenKnowledge } from '../../components/pending-open-knowledge.js';
import { useEffectiveTheme } from '../../theme.js';
import { inlineBundledAssets } from '../handboek/HandboekMediaProvider.js';
import { createKnowledgeMediaProvider } from '../knowledge/KnowledgeMediaProvider.js';

const ARTICLE_ID = 'welcome';

type ViewMode = 'doc' | 'video';

function openHandboek(articleId: string) {
  const intent = { catalogId: 'handboek', documentId: articleId };
  queueOpenKnowledge(intent);
  navigateToTab({ kind: 'area', area: 'knowledge' });
  window.dispatchEvent(new CustomEvent('gezel:open-knowledge-document', { detail: intent }));
}

/**
 * A Home surface for the "What is gezel?" Handboek article
 * embedded as a live page — readable as a document or playable as a
 * captioned video — instead of prose hardcoded into the Home view. The
 * article is the single source of that copy; this is just a small frame
 * around the document exposed by the bundled Knowledge catalog.
 *
 * Two variants:
 *   - `toggle` (default): one page with a Read/Watch key tray — the
 *     workshop greeting's tour tab.
 *   - `stacked`: the video player on top and the readable article
 *     beneath, both always visible — the first-run tutorial column. No
 *     tray (there is nothing to toggle) and no autoplay: an
 *     always-visible player must not start narrating on page load; the
 *     toggle variant may autoplay because reaching it took an explicit
 *     "Watch" click.
 */
export function IntroHandboekArticle({
  variant = 'toggle',
}: {
  variant?: 'toggle' | 'stacked';
} = {}) {
  const stacked = variant === 'stacked';
  const [article, setArticle] = useState<KnowledgeDocumentRead | null>(null);
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
      .readKnowledgeDocument('handboek', ARTICLE_ID)
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
    () => (article ? createKnowledgeMediaProvider({ catalogId: 'handboek' }) : null),
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
  // The brand mark is bundled; pointing at it before the first paint keeps
  // the browser from requesting the catalog-relative path (a 404 on every
  // Home load) while the media provider is still resolving it.
  const markdown = article?.markdown ? inlineBundledAssets(article.markdown) : null;
  const doc = useMemo(() => {
    if (!markdown) return null;
    try {
      return markdownToDoc(parseMarkdown(markdown));
    } catch {
      return null;
    }
  }, [markdown]);
  const playerDoc = useMemo(() => {
    if (!article || !markdown) return null;
    try {
      return markdownToDoc(parseMarkdown(markdown), {
        articleId: article.id,
        defaultDuration: 6,
      });
    } catch {
      return null;
    }
  }, [article, markdown]);

  // Intra-article links can't resolve inside the Home card, so open the
  // linked Handboek document in Knowledge. The relative-link fallback also
  // handles older articles saved before the catalog conversion.
  const onDocClickCapture = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const raw = anchor.getAttribute('href');
    if (!raw || raw.startsWith('//') || raw.startsWith('#')) {
      return;
    }
    const knowledge = parseKnowledgeUri(raw);
    if (knowledge?.catalogId === 'handboek') {
      e.preventDefault();
      e.stopPropagation();
      openHandboek(knowledge.documentId);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
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
          className="gz-link-button"
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
          className="gz-link-button"
          onClick={() => openHandboek(ARTICLE_ID)}
          title="Read this article in the Handboek"
        >
          Open in Handboek →
        </button>
        {!stacked && (
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
        )}
      </div>
      <MediaContext.Provider value={mediaProvider}>
        {(stacked || mode === 'video') && (
          <div className="home-intro-page home-intro-page-player">
            <div className="home-intro-player">
              <DocPlayer
                doc={playerDoc ?? doc}
                theme={gezelChatTheme}
                displayMode="video"
                audioMode="synthetic"
                captionsEnabled
                captionStyle="social"
                autoPlay={!stacked}
                showControls
                showScrubber
              />
            </div>
          </div>
        )}
        {(stacked || mode === 'doc') && (
          <div className="home-intro-page">
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
                linkSchemes={['knowledge']}
              />
            </div>
          </div>
        )}
      </MediaContext.Provider>
    </div>
  );
}
