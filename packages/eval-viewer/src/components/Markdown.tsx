import { useEffect, useState } from 'react';
import { renderSafeMarkdown } from '../markdown.js';

interface Props {
  url: string;
}

// Fetch + render a markdown file from /runs/*. Eval reports contain model-
// generated text, so renderSafeMarkdown treats them as untrusted even though
// the files live locally.
export function MarkdownView({ url }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setErr(null);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        setHtml(renderSafeMarkdown(text));
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (err) return <div className="empty">Failed to load: {err}</div>;
  if (html == null) return <div className="empty">Loading…</div>;
  // biome-ignore lint/security/noDangerouslySetInnerHtml: renderSafeMarkdown sanitizes model-authored input with DOMPurify before it reaches this sink
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
