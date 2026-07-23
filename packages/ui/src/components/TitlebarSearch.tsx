import type { UnifiedSearchResult } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Popover } from '../primitives/index.js';
import { SearchPalette } from './SearchPalette.js';
import { queueOpenFile } from './pending-open-file.js';
import { queueOpenSession } from './pending-open-session.js';
import { type SearchGroup, flattenGroups, groupResults, resultToActions } from './search-nav.js';

type SearchMode = 'search' | 'quick-open';

const DEBOUNCE_MS = 150;

/**
 * Unified search box that lives in the center of the titlebar. Searches across
 * projects (names, files, content), gezels, documents, code symbols, and
 * memories; selecting a result navigates there. ⌘P focuses it in quick-open
 * (name/file) mode, ⌘K in full-search mode — both via the `gezel:focus-search`
 * event dispatched from `App`.
 */
export function TitlebarSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<SearchMode>('search');

  const groups: SearchGroup[] = useMemo(() => groupResults(results), [results]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);

  // Debounced fetch; abort the previous in-flight request on each keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res =
          modeRef.current === 'quick-open'
            ? await api.quickOpen(q, { signal: ctrl.signal })
            : await api.search(q, { mode: 'full', signal: ctrl.signal });
        setResults(res.results);
        setActiveIndex(0);
        setOpen(true);
      } catch {
        /* aborted or failed — leave prior results in place */
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // Focus shortcut from App (⌘P / ⌘K). Stores the mode and focuses the input.
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
      for (const action of resultToActions(result)) {
        if (action.kind === 'open-file') {
          queueOpenFile(action.intent);
        } else if (action.kind === 'open-session') {
          queueOpenSession(action.intent);
        } else {
          window.dispatchEvent(new CustomEvent(action.type, { detail: action.detail }));
        }
      }
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
            placeholder="Search projects, files, docs…  ⌘P"
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
