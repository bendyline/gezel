import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { useEffectiveTheme } from '../../theme.js';
import { gezelChatTheme } from '../chat-theme.js';
import { GEZEL_DARK_SURFACE, GEZEL_LIGHT_SURFACE } from './surfaces.js';

/**
 * Live metacommentary feed for the transformation dialog: the Klerk's
 * streamed thinking rendered through Squisq's markdown pipeline (same
 * parseMarkdown → markdownToDoc → LinearDocView path as chat bubbles
 * and the reference-rail preview) so numbered lists and bold headers
 * read formatted instead of raw. Reparsing per delta is deferred so
 * fast token streams don't jank the dialog; the container pins its
 * scroll to the newest line.
 */

export function TransformThinkingFeed({ markdown }: { markdown: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deferred = useDeferredValue(markdown);
  const doc = useMemo(() => {
    try {
      return markdownToDoc(parseMarkdown(deferred), { articleId: 'transform-thinking' });
    } catch {
      return null;
    }
  }, [deferred]);
  const effective = useEffectiveTheme();
  const surface = effective === 'dark' ? GEZEL_DARK_SURFACE : GEZEL_LIGHT_SURFACE;

  // biome-ignore lint/correctness/useExhaustiveDependencies: deferred is the scroll-pin trigger — each rendered delta re-pins the feed to its newest line.
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [deferred]);

  return (
    <div ref={containerRef} className="gz-transform-thinking" aria-live="polite">
      {doc ? (
        <LinearDocView doc={doc} theme={gezelChatTheme} surface={surface} thinMargins />
      ) : (
        <pre className="gz-transform-thinking-raw">{markdown}</pre>
      )}
    </div>
  );
}
