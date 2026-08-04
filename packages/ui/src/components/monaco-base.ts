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
 * surface before it creates an editor. Themes are also registered explicitly
 * after those contributions load: `defineTheme()` initializes Monaco's
 * one-shot standalone service collection, so doing it at module evaluation
 * time would freeze that collection before a lazy contribution can register
 * its services.
 */

export { monaco };

/**
 * Editor themes matching the app's paper palette — stock syntax colors
 * (familiarity beats branding inside the code surface), with the editor
 * chrome pulled to the surrounding `--panel` tones so the editor doesn't
 * sit like a foreign rectangle. Call after the surface's lazy Monaco
 * contributions load and before creating its editor.
 */
let themesRegistered = false;
let baseRegistration: Promise<void> | null = null;

/** Load singleton-backed contributions before any Monaco API initializes services. */
export function ensureGezelMonacoBase(): Promise<void> {
  if (baseRegistration) return baseRegistration;
  baseRegistration = monaco
    .loadMonacoSuggestions()
    .then(registerGezelMonacoThemes)
    .catch((error) => {
      baseRegistration = null;
      throw error;
    });
  return baseRegistration;
}

export function registerGezelMonacoThemes(): void {
  if (themesRegistered) return;
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
  themesRegistered = true;
}
