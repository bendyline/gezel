import * as monaco from 'monaco-editor/esm/vs/editor/editor.main.js';
import '../squisq-monaco-workers.js';

/**
 * Shared monaco base — the heavy `editor.main.js` import and the gezel
 * paper-palette themes. Every monaco surface (the script
 * editor's `monaco-setup.ts`, the terminal editor's `terminal-monaco-setup.ts`)
 * imports this so they share one monaco instance and one theme registration.
 * Worker routing lives in `squisq-monaco-workers.ts`, shared with Squisq.
 *
 * Like its importers this module is HEAVY (it pulls in monaco's full editor +
 * language services) — it must only ever be reached via `import('…')` from a
 * mount-time effect, never the static graph, so the app bundle and jsdom tests
 * stay monaco-free.
 *
 * `editor.main.js` (not `editor.api.js`) is deliberate: the api entry has zero
 * language contributions, so syntax highlighting would be dead. Same reasoning
 * as squisq's useMonacoLoader.
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
