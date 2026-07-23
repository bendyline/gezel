/**
 * `editor.main.js` ships without a sibling `.d.ts` (only `editor.api.d.ts`
 * is published). At runtime it re-exports the entire api surface plus the
 * language contributions, so re-exporting the package types is sound.
 */
declare module 'monaco-editor/esm/vs/editor/editor.main.js' {
  export * from 'monaco-editor';
}
