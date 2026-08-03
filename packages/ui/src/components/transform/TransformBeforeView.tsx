import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useMemo } from 'react';
import { useEffectiveTheme } from '../../theme.js';
import { gezelChatTheme } from '../chat-theme.js';
import { GEZEL_DARK_SURFACE, GEZEL_LIGHT_SURFACE } from './surfaces.js';

/**
 * Read-only Squisq render of the transformation dialog's "before" text
 * (the captured selection) — same markdown pipeline as chat bubbles, so
 * the fragment reads formatted next to the editable WYSIWYG after-pane
 * instead of as raw markdown source.
 */
export function TransformBeforeView({ markdown }: { markdown: string }) {
  const doc = useMemo(() => {
    try {
      return markdownToDoc(parseMarkdown(markdown), { articleId: 'transform-before' });
    } catch {
      return null;
    }
  }, [markdown]);
  const effective = useEffectiveTheme();
  const surface = effective === 'dark' ? GEZEL_DARK_SURFACE : GEZEL_LIGHT_SURFACE;

  return (
    <div className="gz-transform-before-text">
      {doc ? (
        <LinearDocView doc={doc} theme={gezelChatTheme} surface={surface} thinMargins />
      ) : (
        <pre className="gz-transform-before-raw">{markdown}</pre>
      )}
    </div>
  );
}
