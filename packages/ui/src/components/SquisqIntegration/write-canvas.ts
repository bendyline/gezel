import type { EditorShellProps } from '@bendyline/squisq-editor-react';

/**
 * Typography for every Squisq editor's Write view, spread onto each
 * `EditorShell`: the app's own sans, headings included. Squisq's default
 * mirrors the document's theme fonts into Write, and a document that names no
 * theme falls back to `standard`, whose headings are a system serif — so the
 * library's own notes were edited in a serif nobody chose. Write is for
 * writing: the theme still governs Play, previews and exports, and View →
 * "Editor styling from theme" brings it back for one editor.
 */
export const GEZEL_WRITE_CANVAS = {
  themeInheritance: 'none',
  writeCanvasSettings: { headerFont: 'var(--font-ui)', bodyFont: 'var(--font-ui)' },
} as const satisfies Pick<EditorShellProps, 'themeInheritance' | 'writeCanvasSettings'>;
