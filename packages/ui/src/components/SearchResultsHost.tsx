import { Suspense, lazy, useEffect, useState } from 'react';
import { OPEN_SEARCH_RESULTS_EVENT } from './search-results-open.js';

const SearchResultsOverlay = lazy(() =>
  import('./SearchResultsOverlay.js').then((module) => ({ default: module.SearchResultsOverlay })),
);

/**
 * Mounts the search results overlay the first time it is opened. From then on
 * the overlay stays mounted (rendering nothing while closed) and hears later
 * opens itself; the first query is handed to it as it mounts.
 */
export function SearchResultsHost() {
  const [firstQuery, setFirstQuery] = useState<string | null>(null);
  useEffect(() => {
    if (firstQuery !== null) return;
    const onOpen = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query?.trim();
      if (query) setFirstQuery(query);
    };
    window.addEventListener(OPEN_SEARCH_RESULTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_RESULTS_EVENT, onOpen);
  }, [firstQuery]);
  if (firstQuery === null) return null;
  // An overlay opening, not a pane: nothing to hold in place while it loads.
  return (
    <Suspense fallback={null}>
      <SearchResultsOverlay initialQuery={firstQuery} />
    </Suspense>
  );
}
