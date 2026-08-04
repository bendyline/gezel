import * as monaco from '@bendyline/squisq-editor-react/monaco';
import '../squisq-monaco-workers.js';

/**
 * Shared Monaco base — Squisq's canonical compact editor profile and the
 * gezel paper-palette themes. Every Monaco surface (the script
 * editor's `monaco-setup.ts`, the terminal editor's `terminal-monaco-setup.ts`)
 * imports this so they share one monaco instance and one theme registration.
 * Worker routing lives in `squisq-monaco-workers.ts`, shared with Squisq.
 *
 * Do not import Monaco's `editor.main.js` alongside this entry. Squisq can
 * initialize the standalone service collection before one of Gezel's lazy
 * editors mounts; contributions registered later by `editor.main.js` then
 * depend on services absent from that already-frozen collection (the
 * `UNKNOWN service IInlayHintsCache` family of failures). Language grammars,
 * worker-backed services, and suggestions are requested explicitly by each
 * surface before it creates an editor.
 */

export { monaco };

/**
 * Editor themes matching the app's paper palette — stock syntax colors
 * (familiarity beats branding inside the code surface), with the editor
 * chrome pulled to the surrounding `--panel` tones so the editor doesn't
 * sit like a foreign rectangle. Registered once at module load; any surface
 * can then `monaco.editor.setTheme('gezel-light'|'gezel-dark')`.
 */
monaco.editor.defineTheme('gezel-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#f3eddf',
    'editorGutter.background': '#ece5d4',
    'editorLineNumber.foreground': '#a39a85',
    'minimap.background': '#ece5d4',
  },
});
monaco.editor.defineTheme('gezel-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1c1d20',
    'editorGutter.background': '#191a1d',
    'editorLineNumber.foreground': '#5d5f66',
    'minimap.background': '#191a1d',
  },
});
