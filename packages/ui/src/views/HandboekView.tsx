import type { HandboekArticle, HandboekToc } from '@bendyline/gezel';
import { DocPlayer, LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AreaIcon } from '../components/AreaIcon.js';
import { gezelChatTheme } from '../components/chat-theme.js';
import { createHandboekMediaProvider } from './handboek/HandboekMediaProvider.js';

const SELECTED_KEY = 'gezel:handboek:article';

type ViewMode = 'doc' | 'video';

interface NarrationAudio {
  articleId: string;
  /** One blob URL per doc block, positionally aligned. */
  urls: string[];
  durationsMs: number[];
}

/**
 * The Handboek — gezel's built-in documentation. A TOC rail on the
 * left; the selected article on the right, readable as a document
 * (LinearDocView) or played back as a video with social captions
 * (DocPlayer on a synthetic clock — no audio required).
 */
export function HandboekView() {
  const [toc, setToc] = useState<HandboekToc | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  });
  const [article, setArticle] = useState<HandboekArticle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ViewMode>('doc');
  const [ttsReady, setTtsReady] = useState(false);
  const [listening, setListening] = useState(false);
  const [narration, setNarration] = useState<NarrationAudio | null>(null);
  const [narrationLoading, setNarrationLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getAudioEngineStatus()
      .then((s) => alive && setTtsReady(s.tts.status === 'ok'))
      .catch(() => alive && setTtsReady(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getHandboekToc()
      .then((t) => {
        if (!alive) return;
        setToc(t);
        setSelectedId((prev) => {
          const ids = new Set(t.areas.flatMap((a) => a.entries.map((e) => e.id)));
          if (prev && ids.has(prev)) return prev;
          return t.areas[0]?.entries[0]?.id ?? null;
        });
      })
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    try {
      window.localStorage.setItem(SELECTED_KEY, selectedId);
    } catch {
      // localStorage unavailable (private mode) — selection just won't persist.
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getHandboekArticle(selectedId)
      .then((a) => {
        if (!alive) return;
        setArticle(a);
        // Reading position, playback, and narration don't carry
        // between articles.
        setMode('doc');
        setListening(false);
        setNarration((prev) => {
          for (const url of prev?.urls ?? []) URL.revokeObjectURL(url);
          return null;
        });
      })
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const mediaProvider = useMemo(
    () => (article ? createHandboekMediaProvider(article.figures) : null),
    [article],
  );
  const providerRef = useRef(mediaProvider);
  useEffect(() => {
    providerRef.current = mediaProvider;
    return () => providerRef.current?.dispose?.();
  }, [mediaProvider]);

  const doc = useMemo(() => {
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

  // Kokoro narration: fetch the per-block segment manifest + WAVs on
  // first Listen. Segments are positionally aligned with doc blocks
  // (the service pads text-less blocks with silence), so a mismatch
  // means the client and service parsed different markdown — fall back
  // to the synthetic clock rather than playing out-of-sync audio.
  const toggleListening = useCallback(() => {
    if (listening) {
      setListening(false);
      return;
    }
    if (narration && narration.articleId === article?.id) {
      setListening(true);
      return;
    }
    if (!article || narrationLoading) return;
    setNarrationLoading(true);
    (async () => {
      const manifest = await api.getHandboekNarration(article.id);
      const blobs = await Promise.all(
        manifest.segments.map((s) => api.fetchHandboekNarrationAudio(s.hash)),
      );
      return {
        articleId: article.id,
        urls: blobs.map((b) => URL.createObjectURL(b)),
        durationsMs: manifest.segments.map((s) => s.durationMs),
      };
    })()
      .then((audio) => {
        setNarration(audio);
        setListening(true);
      })
      .catch((err) => setError(`Narration unavailable: ${String(err)}`))
      .finally(() => setNarrationLoading(false));
  }, [listening, narration, article, narrationLoading]);

  const narratedDoc = useMemo(() => {
    if (!doc || !listening || !narration || narration.articleId !== article?.id) return null;
    if (narration.urls.length !== doc.blocks.length) return null;
    let startTime = 0;
    const segments = narration.urls.map((url, i) => {
      const duration = narration.durationsMs[i]! / 1000;
      const seg = {
        src: url,
        name: doc.blocks[i]!.id,
        duration,
        startTime,
      };
      startTime += duration;
      return seg;
    });
    return {
      ...doc,
      audio: { segments },
      blocks: doc.blocks.map((b, i) => ({ ...b, audioSegment: i })),
    };
  }, [doc, listening, narration, article]);

  // Intra-handboek links: curated articles use relative `.md` paths
  // (`the-crew.md`, `../technical/where-files-live.md`) so the files
  // read naturally on GitHub and pass the repo link checker; generated
  // tables link by article id (`craftbook/research-report`). Both
  // resolve against the TOC here instead of navigating the window.
  const articleIds = useMemo(() => {
    const ids = new Set<string>();
    const byStem = new Map<string, string>();
    for (const area of toc?.areas ?? []) {
      for (const entry of area.entries) {
        ids.add(entry.id);
        const stem = entry.id.split('/').pop();
        if (stem && !byStem.has(stem)) byStem.set(stem, entry.id);
      }
    }
    return { ids, byStem };
  }, [toc]);

  const onDocClickCapture = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const raw = anchor.getAttribute('href');
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const path = raw.split(/[?#]/)[0]!;
    const candidate = path.replace(/\.md$/, '').replace(/^(\.\.?\/)+/, '');
    const target =
      (articleIds.ids.has(candidate) ? candidate : undefined) ??
      articleIds.byStem.get(candidate.split('/').pop() ?? '');
    if (target) setSelectedId(target);
  };

  return (
    <div className="handboek-view" data-testid="handboek-view">
      <nav className="handboek-toc" aria-label="Handboek contents">
        <div className="handboek-toc-brand">
          <AreaIcon area="handboek" size={16} />
          <span>Handboek</span>
        </div>
        {!toc && !error && <div className="handboek-toc-loading">Loading contents…</div>}
        {toc?.areas.map((area) => (
          <section key={area.area} className="handboek-toc-area">
            <h3 className="handboek-toc-area-title">{area.title}</h3>
            <ul>
              {area.entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={
                      entry.id === selectedId
                        ? 'handboek-toc-entry handboek-toc-entry-active'
                        : 'handboek-toc-entry'
                    }
                    aria-current={entry.id === selectedId ? 'page' : undefined}
                    title={entry.summary}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="handboek-pane">
        <header className="handboek-pane-header">
          <div className="handboek-pane-titles">
            <h2>{article?.title ?? 'Handboek'}</h2>
            {article?.summary && <p className="handboek-pane-summary">{article.summary}</p>}
          </div>
          <div className="handboek-header-controls">
            {mode === 'video' && ttsReady && (
              <button
                type="button"
                className={
                  listening
                    ? 'gz-key gz-key-active handboek-listen-key'
                    : 'gz-key handboek-listen-key'
                }
                aria-pressed={listening}
                disabled={narrationLoading}
                onClick={toggleListening}
                title="Narrate this article with the on-device voice"
              >
                {narrationLoading ? 'Preparing voice…' : 'Listen'}
              </button>
            )}
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
        </header>
        {error && <div className="handboek-error">{error}</div>}
        {loading && !article && <div className="handboek-loading">Loading article…</div>}
        {doc && mediaProvider && (
          <MediaContext.Provider value={mediaProvider}>
            {mode === 'doc' ? (
              <div
                className="handboek-doc"
                data-testid="handboek-doc"
                onClickCapture={onDocClickCapture}
              >
                <LinearDocView doc={doc} theme={gezelChatTheme} imageDisplayMode="inline" />
              </div>
            ) : (
              <div className="handboek-player" data-testid="handboek-player">
                <DocPlayer
                  key={narratedDoc ? 'narrated' : 'synthetic'}
                  doc={narratedDoc ?? doc}
                  theme={gezelChatTheme}
                  displayMode="video"
                  audioMode={narratedDoc ? 'media' : 'synthetic'}
                  captionsEnabled
                  captionStyle="social"
                  autoPlay
                  showControls
                  showScrubber
                />
              </div>
            )}
          </MediaContext.Provider>
        )}
      </div>
    </div>
  );
}
