import { type UnifiedSearchResult, mediaSpanLabel } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { PhotoThumb } from './PhotoThumb.js';
import { SearchMarkdownSnippet, searchSnippetIsMarkdown } from './SearchMarkdownSnippet.js';
import { highlightTokens } from './highlight-tokens.js';
import { runNavActions } from './nav-actions.js';
import { type SearchGroup, groupResults, resultToActions } from './search-nav.js';

/**
 * The full search surface behind the titlebar palette's "See all results".
 * The palette is a navigation shortcut — capped, transient, single-column;
 * this overlay is the research view: every result the merged search returns
 * (up to the API's 100 cap), grouped by kind, with query-term highlighting
 * and the same pick-to-navigate contract as the palette.
 *
 * Opened via `gezel:open-search-results { query }`; owns its own fetch so it
 * can request the full cap instead of inheriting the palette's 30.
 */

const OPEN_EVENT = 'gezel:open-search-results';

export function openSearchResults(query: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }));
}

export function SearchResultsOverlay() {
  const [query, setQuery] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await api.search(q, { mode: 'full', maxResults: 100 });
      setGroups(groupResults(res.results));
      setIncomplete(res.sourcesIncomplete === true);
    } catch {
      setGroups([]);
      setIncomplete(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query?.trim();
      if (!q) return;
      setQuery(q);
      setDraft(q);
      void runSearch(q);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [runSearch]);

  const close = useCallback(() => setQuery(null), []);

  if (query === null) return null;

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const pick = (result: UnifiedSearchResult) => {
    runNavActions(resultToActions(result));
    close();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-results-backdrop" />
        <Dialog.Content
          className="search-results-panel"
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Search results</Dialog.Title>
          <header className="search-results-header">
            <input
              ref={inputRef}
              type="search"
              value={draft}
              aria-label="Search everything"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  setQuery(draft.trim());
                  void runSearch(draft.trim());
                }
              }}
            />
            <span className="search-results-count muted">
              {loading ? 'Searching…' : `${total} result${total === 1 ? '' : 's'}`}
            </span>
            <Dialog.Close asChild>
              <button type="button" className="search-results-close" aria-label="Close">
                ✕
              </button>
            </Dialog.Close>
          </header>
          {incomplete && !loading && (
            <p className="search-results-note muted">
              Some sources didn't answer in time — results may be partial.
            </p>
          )}
          <div className="search-results-body">
            {!loading && total === 0 && <p className="placeholder">No results.</p>}
            {groups.map((group) => (
              <section key={group.kind} className="search-results-group">
                <h3 className="search-results-group-title">
                  {group.label} <span className="muted">({group.items.length})</span>
                </h3>
                <ul className="search-results-list">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`search-results-row${photoHit(item) ? ' with-thumb' : ''}`}
                        onClick={() => pick(item)}
                      >
                        {photoHit(item) && item.projectId && item.path && (
                          <PhotoThumb
                            projectId={item.projectId}
                            path={item.path}
                            width={160}
                            alt={item.title}
                            className="search-results-thumb"
                          />
                        )}
                        <span className="search-results-title">
                          {highlightTokens(item.title, query)}
                        </span>
                        {item.subtitle && (
                          <span className="search-results-subtitle muted">
                            {item.media
                              ? `${mediaSpanLabel(item.media)} · ${item.subtitle}`
                              : item.subtitle}
                          </span>
                        )}
                        {item.snippet && (
                          <span className="search-results-snippet">
                            <SearchMarkdownSnippet
                              markdown={item.snippet}
                              query={query}
                              formatMarkdown={searchSnippetIsMarkdown(
                                item.kind,
                                item.path ?? item.title,
                              )}
                            />
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A workspace photo the thumbnail route can draw: a 3rem tile beside the text. */
function photoHit(item: UnifiedSearchResult): boolean {
  return (
    item.media?.modality === 'image' &&
    item.source === 'workspace' &&
    Boolean(item.projectId) &&
    Boolean(item.path)
  );
}
