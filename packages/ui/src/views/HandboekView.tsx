import type {
  HandboekArticle,
  HandboekToc,
  HandboekTocArea,
  HandboekTocEntry,
} from '@bendyline/gezel';
import { DocPlayer, LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { getDocPlaybackDuration } from '@bendyline/squisq/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AreaIcon } from '../components/AreaIcon.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from '../components/chat-theme.js';
import { consumeOpenHandboek } from '../components/pending-open-handboek.js';
import { useEffectiveTheme } from '../theme.js';
import '../styles/16-handbook.css';
import {
  createHandboekMediaProvider,
  inlineBundledAssets,
} from './handboek/HandboekMediaProvider.js';

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
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(() => new Set());
  const [expandedSubcategories, setExpandedSubcategories] = useState<Set<string>>(() => new Set());
  // TOC filter: the manual was the least findable content in the app — the
  // titlebar search now lists articles too, and this covers "I'm already
  // here, just find it" without leaving the view.
  const [tocFilter, setTocFilter] = useState('');
  const filteredEntries = useMemo(() => {
    const q = tocFilter.trim().toLowerCase();
    if (!q || !toc) return [];
    return toc.areas
      .flatMap((area) => area.entries)
      .filter(
        (entry) =>
          entry.title.toLowerCase().includes(q) || (entry.summary ?? '').toLowerCase().includes(q),
      );
  }, [toc, tocFilter]);
  // The gezellig theme's native pages are dark. Overlay the shared warm-paper
  // surface in light mode, matching the Home screen's embedded Handboek article.
  const effectiveTheme = useEffectiveTheme();
  const surface = effectiveTheme === 'light' ? GEZEL_LIGHT_SURFACE : undefined;

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
    // A titlebar search pick queued before this view mounted wins the
    // initial selection (same mailbox contract as pending-open-file).
    const intent = consumeOpenHandboek();
    if (intent) setSelectedId(intent.articleId);
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

  // Live path — the Handboek area is already open when a search result asks
  // for one of its articles.
  useEffect(() => {
    const onOpenArticle = (e: Event) => {
      const detail = (e as CustomEvent<{ articleId?: string }>).detail;
      if (detail?.articleId) setSelectedId(detail.articleId);
    };
    window.addEventListener('gezel:open-handboek-article', onOpenArticle);
    return () => window.removeEventListener('gezel:open-handboek-article', onOpenArticle);
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

  // A restored selection or an article link can point inside a closed shelf.
  // Reveal that destination without preventing the user from closing the
  // currently selected area or shelf again afterward.
  useEffect(() => {
    if (!toc || !selectedId) return;
    const area = toc.areas.find((candidate) =>
      candidate.entries.some((entry) => entry.id === selectedId),
    );
    const entry = area?.entries.find((candidate) => candidate.id === selectedId);
    if (!area || !entry) return;
    setCollapsedAreas((current) => {
      if (!current.has(area.area)) return current;
      const next = new Set(current);
      next.delete(area.area);
      return next;
    });
    if (entry.subcategory) {
      const key = subcategoryKey(area.area, entry.subcategory.id);
      setExpandedSubcategories((current) => {
        if (current.has(key)) return current;
        return new Set(current).add(key);
      });
    }
  }, [toc, selectedId]);

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
      return markdownToDoc(parseMarkdown(inlineBundledAssets(article.markdown)), {
        articleId: article.id,
        defaultDuration: article.defaultDuration ?? 6,
      });
    } catch {
      return null;
    }
  }, [article]);

  // Every timing path in squisq 2.5.0's DocPlayer — `totalDuration`, the
  // synthetic timer's arming condition, the scrubber — reads the audio
  // segment list, which an unnarrated article doesn't have. The clock length
  // comes out 0 and playback freezes at 0:00 / 0:00 on the first slide.
  // Standing in one srcless segment spanning the document's own timeline
  // restores it; in `synthetic` audio mode every media path in the player
  // returns early, so the segment is never fetched. Local shim — drop it once
  // a squisq release derives the synthetic clock from the doc itself.
  const syntheticDoc = useMemo(() => {
    if (!doc || doc.audio.segments.length > 0) return doc;
    const duration = getDocPlaybackDuration(doc);
    if (duration <= 0) return doc;
    return {
      ...doc,
      audio: { segments: [{ src: '', name: 'synthetic', duration, startTime: 0 }] },
    };
  }, [doc]);

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

  const toggleArea = (area: string) => {
    setCollapsedAreas((current) => {
      const next = new Set(current);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  };

  const toggleSubcategory = (key: string) => {
    setExpandedSubcategories((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderEntries = (entries: HandboekTocEntry[], nested = false) => (
    <ul className={nested ? 'handboek-toc-subcategory-entries' : undefined}>
      {entries.map((entry) => (
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
  );

  return (
    <div className="handboek-view" data-testid="handboek-view">
      <nav className="handboek-toc" aria-label="Handboek contents">
        <div className="handboek-toc-brand">
          <AreaIcon area="handboek" size={16} />
          <span>Handboek</span>
        </div>
        <input
          type="search"
          className="handboek-toc-filter"
          placeholder="Find an article…"
          aria-label="Filter Handboek articles"
          value={tocFilter}
          onChange={(e) => setTocFilter(e.target.value)}
        />
        {!toc && !error && <div className="handboek-toc-loading">Loading contents…</div>}
        {tocFilter.trim() ? (
          <section className="handboek-toc-area">
            {filteredEntries.length > 0 ? (
              renderEntries(filteredEntries)
            ) : (
              <div className="handboek-toc-loading">No articles match.</div>
            )}
          </section>
        ) : null}
        {!tocFilter.trim() &&
          toc?.areas.map((area) => {
            const collapsed = collapsedAreas.has(area.area);
            const panelId = `handboek-area-${area.area}`;
            const { ungrouped, subcategories } = organizeTocArea(area);
            return (
              <section key={area.area} className="handboek-toc-area">
                <h3 className="handboek-toc-area-title">
                  <button
                    type="button"
                    className="handboek-toc-disclosure handboek-toc-area-toggle"
                    aria-expanded={!collapsed}
                    aria-controls={panelId}
                    onClick={() => toggleArea(area.area)}
                  >
                    <span className="handboek-toc-caret" aria-hidden="true">
                      &rsaquo;
                    </span>
                    <span>{area.title}</span>
                  </button>
                </h3>
                {!collapsed && (
                  <div id={panelId} className="handboek-toc-area-contents">
                    {ungrouped.length > 0 && renderEntries(ungrouped)}
                    {subcategories.map((subcategory) => {
                      const key = subcategoryKey(area.area, subcategory.id);
                      const expanded = expandedSubcategories.has(key);
                      const subcategoryPanelId = `handboek-subcategory-${area.area}-${subcategory.id}`;
                      return (
                        <section key={subcategory.id} className="handboek-toc-subcategory">
                          <h4 className="handboek-toc-subcategory-title">
                            <button
                              type="button"
                              className="handboek-toc-disclosure handboek-toc-subcategory-toggle"
                              aria-expanded={expanded}
                              aria-controls={subcategoryPanelId}
                              onClick={() => toggleSubcategory(key)}
                            >
                              <span className="handboek-toc-caret" aria-hidden="true">
                                &rsaquo;
                              </span>
                              <span>{subcategory.title}</span>
                            </button>
                          </h4>
                          {expanded && (
                            <div id={subcategoryPanelId}>
                              {renderEntries(subcategory.entries, true)}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
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
                {/* No synthesized cover. LinearDocView's default builds a
                    full-bleed hero out of `doc.startBlock`, which for these
                    articles means the pane restates the title the header
                    right above it already shows, and — because the leading
                    figure lives in that block's contents — renders the
                    article's image once stranded in the hero band and again
                    in the body. `.handboek-pane-header` is this view's
                    title treatment; the body starts at the prose.
                    Video mode keeps its cover — a title slide is the
                    right opening frame there. */}
                <LinearDocView
                  doc={doc}
                  className="gezel-article-view"
                  theme={gezelChatTheme}
                  surface={surface}
                  imageDisplayMode="inline"
                  showCover={false}
                />
              </div>
            ) : (
              <div className="handboek-player" data-testid="handboek-player">
                <DocPlayer
                  key={narratedDoc ? 'narrated' : 'synthetic'}
                  doc={narratedDoc ?? syntheticDoc ?? doc}
                  theme={gezelChatTheme}
                  surface={surface}
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

interface TocSubcategoryGroup {
  id: string;
  title: string;
  order: number;
  entries: HandboekTocEntry[];
}

function organizeTocArea(area: HandboekTocArea): {
  ungrouped: HandboekTocEntry[];
  subcategories: TocSubcategoryGroup[];
} {
  const ungrouped: HandboekTocEntry[] = [];
  const byId = new Map<string, TocSubcategoryGroup>();
  for (const entry of area.entries) {
    if (!entry.subcategory) {
      ungrouped.push(entry);
      continue;
    }
    const existing = byId.get(entry.subcategory.id);
    if (existing) {
      existing.entries.push(entry);
    } else {
      byId.set(entry.subcategory.id, { ...entry.subcategory, entries: [entry] });
    }
  }
  return {
    ungrouped,
    subcategories: [...byId.values()].sort(
      (a, b) => a.order - b.order || a.title.localeCompare(b.title),
    ),
  };
}

function subcategoryKey(area: string, subcategory: string): string {
  return `${area}:${subcategory}`;
}
