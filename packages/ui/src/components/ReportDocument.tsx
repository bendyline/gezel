import { parseGezelHref } from '@bendyline/gezel';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { gezelChatTheme } from './chat-theme.js';
import { makeReportActionFenceRenderers } from './report-actions/ReportActionFence.js';

/** Inline code that names a file: a path with an extension and no spaces or scheme. */
export function looksLikeFilePath(text: string): boolean {
  return text.length < 300 && !text.includes('://') && /^[^\s`'"]+\.[A-Za-z0-9]{1,10}$/.test(text);
}

/** A link to a project file: `gezel-nav:` or a plain relative path. */
function fileFromHref(href: string): { path: string; line?: number } | null {
  const parsed = parseGezelHref(href);
  if (parsed?.kind === 'file') return { path: parsed.path, line: parsed.line };
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return null;
  }
  try {
    return { path: decodeURIComponent(href.replace(/^\.\//, '')) };
  } catch {
    return null;
  }
}

/**
 * A report from a project's artifacts drawer, read in place: rendered with
 * the chat theme, its suggested actions live, and — given `onOpenPath` —
 * every file it names (a `gezel-nav:` link, a relative link, or a path in
 * inline code) opening that file instead of navigating away.
 */
export function ReportDocument({
  projectId,
  path,
  onOpenPath,
  className,
}: {
  projectId: string;
  path: string;
  onOpenPath?: (path: string, line?: number) => void;
  className?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    let cancelled = false;
    api
      .readProjectArtifact(projectId, path)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  const doc = useMemo(() => {
    if (content === null) return null;
    try {
      return markdownToDoc(parseMarkdown(content), { articleId: `report:${path}` });
    } catch {
      return null;
    }
  }, [content, path]);

  const fenceRenderers = useMemo(
    () => makeReportActionFenceRenderers({ projectId, reportPath: path }),
    [projectId, path],
  );

  // Paths in inline code become keyboard-reachable links. The document
  // renders its blocks after this component commits, so watch for them.
  useEffect(() => {
    const root = body.current;
    if (!onOpenPath || !root) return;
    const mark = () => {
      for (const code of root.querySelectorAll('code:not(.report-document-path)')) {
        if (code.closest('pre') || !looksLikeFilePath(code.textContent?.trim() ?? '')) continue;
        code.classList.add('report-document-path');
        code.setAttribute('role', 'link');
        code.setAttribute('tabindex', '0');
      }
    };
    mark();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [onOpenPath]);

  const open = (target: EventTarget, event: MouseEvent | KeyboardEvent): void => {
    if (!onOpenPath || !(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (anchor) {
      const file = fileFromHref(anchor.getAttribute('href') ?? '');
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenPath(file.path, file.line);
      return;
    }
    const code = target.closest('code');
    const text = code?.textContent?.trim() ?? '';
    if (code && !code.closest('pre') && looksLikeFilePath(text)) {
      event.preventDefault();
      onOpenPath(text);
    }
  };

  return (
    <div
      ref={body}
      className={className ? `report-document ${className}` : 'report-document'}
      onClickCapture={(e) => open(e.target, e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(e.target, e);
      }}
    >
      {doc ? (
        <LinearDocView
          doc={doc}
          theme={gezelChatTheme}
          thinMargins
          imageDisplayMode="thumbnail"
          fenceRenderers={fenceRenderers}
        />
      ) : error ? (
        <p className="error small">{error}</p>
      ) : null}
    </div>
  );
}
