import type { UnifiedSearchResult } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Popover } from '../primitives/index.js';
import { SearchPalette } from './SearchPalette.js';
import { runNavActions } from './nav-actions.js';
import { type SearchGroup, flattenGroups, groupResults, resultToActions } from './search-nav.js';

type SearchMode = 'search' | 'quick-open';

const DEBOUNCE_MS = 150;

function quickOpenShortcutLabel(): string {
  const platform =
    window.__GEZEL__?.platform ??
    (typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);
  return platform === 'darwin' || /Mac/i.test(platform) ? '⌘P' : 'Ctrl+P';
}

/**
 * Unified search box that lives in the center of the titlebar. Searches across
 * projects (names, files, content), gezels, documents, code symbols, and
 * memories; selecting a result navigates there. Command/Ctrl+P focuses it in
 * quick-open (name/file) mode, Command/Ctrl+K in full-search mode — both via
 * the `gezel:focus-search` event dispatched from `App`.
 */
export function TitlebarSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sourcesIncomplete, setSourcesIncomplete] = useState(false);
  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<SearchMode>('search');
  const quickOpenShortcut = quickOpenShortcutLabel();

  const groups: SearchGroup[] = useMemo(() => groupResults(results), [results]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);

  // Debounced fetch; abort the previous in-flight request on each keystroke.
  //
  // Two phases, because they have wildly different costs. The name catalog
  // answers in milliseconds, while the full search waits on the content
  // fan-out — whose first call also pays the embedding model's cold load
  // (measured at ~41s on a fresh install). Showing phase one immediately is
  // what keeps the box from looking dead while phase two runs.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      setFailed(false);
      setSourcesIncomplete(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      // Mount the palette BEFORE the first request. The popover only exists
      // while `open`, so opening it on the response made "Searching…"
      // unreachable on the very first query — the box silently ignored the
      // user for as long as the request took.
      setLoading(true);
      setFailed(false);
      setSourcesIncomplete(false);
      setOpen(true);
      let namesShown = false;
      try {
        const quick = await api.quickOpen(q, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setResults(quick.results);
        setActiveIndex(0);
        namesShown = true;
        if (modeRef.current === 'quick-open') return;
        const full = await api.search(q, { mode: 'full', signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setResults(full.results);
        setSourcesIncomplete(full.sourcesIncomplete === true);
        setActiveIndex(0);
      } catch {
        // An abort is the ordinary keystroke path, not a failure. A genuine
        // failure with nothing on screen has to say so — silently leaving an
        // empty palette reads as "no matches", which is a different claim.
        if (!ctrl.signal.aborted && !namesShown) setFailed(true);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // Focus shortcut from App (Command/Ctrl+P or K). Stores the mode and focuses the input.
  useEffect(() => {
    const onFocusSearch = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: SearchMode }>).detail;
      modeRef.current = detail?.mode ?? 'search';
      window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
      if (query.trim()) setOpen(true);
    };
    window.addEventListener('gezel:focus-search', onFocusSearch);
    return () => window.removeEventListener('gezel:focus-search', onFocusSearch);
  }, [query]);

  // Cooperative dismissal: close our palette when another header popover opens.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, []);

  const reset = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    inputRef.current?.blur();
  }, []);

  const pick = useCallback(
    (result: UnifiedSearchResult) => {
      runNavActions(resultToActions(result));
      reset();
    },
    [reset],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (flat.length > 0) {
          setOpen(true);
          setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        const target = flat[activeIndex];
        if (target) {
          e.preventDefault();
          pick(target);
        }
      } else if (e.key === 'Escape') {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        } else {
          inputRef.current?.blur();
        }
      }
    },
    [flat, activeIndex, open, pick],
  );

  return (
    <Popover.Root open={open && query.trim().length > 0} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="titlebar-search" data-testid="titlebar-search">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            className="titlebar-search-input"
            data-testid="titlebar-search-input"
            placeholder={`Search projects, files, docs…  ${quickOpenShortcut}`}
            aria-label="Search"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            onFocus={() => {
              window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
              if (query.trim() && results.length > 0) setOpen(true);
            }}
          />
        </div>
      </Popover.Anchor>
      {query.trim().length > 0 ? (
        <Popover.Content
          className="search-palette-popover"
          align="center"
          sideOffset={6}
          // Keep keyboard focus in the input while the user arrows the list.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SearchPalette
            groups={groups}
            activeIndex={activeIndex}
            loading={loading}
            failed={failed}
            sourcesIncomplete={sourcesIncomplete}
            onPick={pick}
            onHover={setActiveIndex}
          />
        </Popover.Content>
      ) : null}
    </Popover.Root>
  );
}

function SearchIcon() {
  return (
    <svg className="titlebar-search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 7 1.8zm3.8 8.9 3.4 3.4"
      />
    </svg>
  );
}
