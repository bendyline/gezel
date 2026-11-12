/**
 * Opening the full search results, without loading them. The overlay pulls in
 * the markdown renderer for its snippets (about 226 KB gzip with its icon
 * catalog), so the shell holds only this event and loads the overlay on first
 * use (SearchResultsHost).
 */
export const OPEN_SEARCH_RESULTS_EVENT = 'gezel:open-search-results';

export function openSearchResults(query: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_RESULTS_EVENT, { detail: { query } }));
}

/**
 * Start loading what results render with before they are needed (the search
 * box took focus): the snippet parser the palette uses, and the overlay.
 */
export function preloadSearchResults(): void {
  void import('./SearchMarkdownSnippet.js')
    .then((module) => module.loadSearchSnippetMarkdown())
    .catch(() => {});
  void import('./SearchResultsOverlay.js').catch(() => {});
}
