/**
 * `@bendyline/gezel-knowledge/browser`: the pure part of the package, safe
 * in a browser, a Web Worker or a mobile WebView. Nothing reachable from
 * here imports a `node:` module; `browser.test.ts` walks the import graph to
 * keep it that way.
 *
 * The root entry is Node-only: it loads `node:sqlite` as soon as it is
 * imported.
 */
export * from './chunking/markdown-chunker.js';
export * from './profiles/registry.js';
export { compareScores, contentFtsQuery, selectiveFtsQuery } from './reader/fts-query.js';
export { QUERY_STOP_WORDS } from './query-stopwords.js';
