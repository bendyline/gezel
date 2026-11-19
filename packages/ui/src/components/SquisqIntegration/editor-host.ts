import type { EditorShellProps } from '@bendyline/squisq-editor-react';

const NATIVE_APP_PLATFORMS = new Set(['mobile', 'ios', 'android']);

/**
 * What the host can do for every Squisq editor, spread onto each
 * `EditorShell` beside `GEZEL_WRITE_CANVAS`. Read at render, not import, so it
 * never depends on when a host installed `window.__GEZEL__`.
 *
 * Narrate's Pop out floats the prompter in a picture-in-picture or popup
 * window. The phone app's WebView opens no popups and stops drawing once the
 * app is in the background, so there the button could only fail. The phone's
 * browser build (`platform: 'browser'`) can still float one.
 */
export function gezelEditorHost(): Pick<EditorShellProps, 'allowNarratePopOut'> {
  return { allowNarratePopOut: !NATIVE_APP_PLATFORMS.has(window.__GEZEL__?.platform ?? '') };
}
