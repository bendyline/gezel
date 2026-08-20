import type { UnifiedSearchResult } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
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

/** Wrap query-token matches in <mark> — client-side so the service snippets
 *  (which also feed model prompts) stay clean text. */
export function highlightTokens(text: string, query: string): React.ReactNode {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])];
  if (tokens.length === 0) return text;
  const pattern = new RegExp(
    `(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    pattern.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string; order never changes
      <mark key={i}>{part}</mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: see above
      <span key={i}>{part}</span>
    ),
  );
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

  useEffect(() => {
    if (query !== null) inputRef.current?.focus();
  }, [query]);

  const close = useCallback(() => setQuery(null), []);

  useEffect(() => {
    if (query === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query, close]);

  if (query === null) return null;

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const pick = (result: UnifiedSearchResult) => {
    runNavActions(resultToActions(result));
    close();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <dialog> demands showModal() plumbing this event-opened overlay doesn't have; Escape/backdrop close and focus land in the input.
    <div className="search-results-overlay" role="dialog" aria-label="Search results">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; Escape handles keyboard */}
      <div className="search-results-backdrop" onClick={close} />
      <div className="search-results-panel">
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
          <button type="button" className="search-results-close" onClick={close} aria-label="Close">
            ✕
          </button>
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
                    <button type="button" className="search-results-row" onClick={() => pick(item)}>
                      <span className="search-results-title">
                        {highlightTokens(item.title, query)}
                      </span>
                      {item.subtitle && (
                        <span className="search-results-subtitle muted">{item.subtitle}</span>
                      )}
                      {item.snippet && (
                        <span className="search-results-snippet">
                          {highlightTokens(item.snippet, query)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
