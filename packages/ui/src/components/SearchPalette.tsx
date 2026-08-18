import type { UnifiedSearchResult } from '@bendyline/gezel';
import { useEffect, useRef } from 'react';
import type { SearchGroup } from './search-nav.js';

interface SearchPaletteProps {
  groups: SearchGroup[];
  /** Index into the flattened (visual-order) list of the highlighted option. */
  activeIndex: number;
  loading: boolean;
  /**
   * The lookup itself failed (not "matched nothing"). Distinguished because
   * "No results" is a claim about the user's data, and making it while the
   * daemon is unreachable sends them hunting for something that is there.
   */
  failed?: boolean;
  onPick: (result: UnifiedSearchResult) => void;
  onHover: (index: number) => void;
}

/**
 * Presentational results dropdown for the titlebar search. Renders fixed-order
 * groups; each option carries its index in the flattened visual order so
 * keyboard nav (owned by `TitlebarSearch`) and the rendering agree.
 */
export function SearchPalette({
  groups,
  activeIndex,
  loading,
  failed = false,
  onPick,
  onHover,
}: SearchPaletteProps) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex is the intended trigger — the body reads activeRef.current (a ref) to scroll the newly-active row into view.
  useEffect(() => {
    const el = activeRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (loading && total === 0) {
    return (
      <div className="search-palette" data-testid="search-palette">
        <div className="search-palette-empty">Searching…</div>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="search-palette" data-testid="search-palette">
        <div className="search-palette-empty">
          {failed ? "Search isn't responding — try again in a moment" : 'No results'}
        </div>
      </div>
    );
  }

  let flat = -1;
  return (
    <div
      className="search-palette"
      data-testid="search-palette"
      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA combobox listbox; a native <select> can't host the grouped, multi-line, custom-styled rows.
      role="listbox"
      aria-label="Search results"
      tabIndex={-1}
    >
      {groups.map((group) => (
        <div
          key={group.kind}
          className="search-palette-group"
          // biome-ignore lint/a11y/useSemanticElements: grouping rows within the listbox; <fieldset> would break the listbox/option structure.
          role="group"
          aria-label={group.label}
        >
          <div className="search-palette-group-header">{group.label}</div>
          {group.items.map((item) => {
            flat += 1;
            const index = flat;
            const active = index === activeIndex;
            return (
              <button
                key={item.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: ARIA option inside the custom listbox above.
                role="option"
                aria-selected={active}
                data-testid="search-option"
                ref={active ? activeRef : null}
                className={active ? 'search-option active' : 'search-option'}
                // mousedown (not click) + preventDefault so the input keeps
                // focus and doesn't blur-close the palette before the pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(item);
                }}
                onMouseEnter={() => onHover(index)}
              >
                <span className="search-option-title">{item.title}</span>
                {item.subtitle ? (
                  <span className="search-option-subtitle">{item.subtitle}</span>
                ) : null}
                {item.snippet ? (
                  <span className="search-option-snippet">{item.snippet}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {/* Names land first and content follows, so say the list is still
          filling rather than letting it look finished and then jump. */}
      {loading ? (
        <div className="search-palette-more" aria-live="polite">
          Searching your files and memories…
        </div>
      ) : null}
    </div>
  );
}
