import { JsonEditor, type JsonEditorProps } from '@bendyline/squisq-editor-react';
import { resolveTheme } from '@bendyline/squisq/schemas';

export const GEZEL_JSON_EDITOR_THEME_ID = 'gezellig';

const GEZEL_JSON_EDITOR_THEME = resolveTheme(GEZEL_JSON_EDITOR_THEME_ID);

/**
 * Gezel's shared Squisq custom-form renderer. Keeping the theme choice here
 * and applying the host bridge class here makes every schema-driven form feel
 * native to the app. The class maps Squisq's JSON-form tokens to Gezel's live
 * CSS variables, so light/dark changes do not need a parallel SurfaceScheme.
 */
export function GezelJsonEditor({
  className,
  ...props
}: Omit<JsonEditorProps, 'theme' | 'surface'>) {
  const hostClassName = ['gezel-json-editor', className].filter(Boolean).join(' ');
  return <JsonEditor {...props} className={hostClassName} theme={GEZEL_JSON_EDITOR_THEME} />;
}
