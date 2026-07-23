import { useEffect, useState } from 'react';

interface Props {
  url: string;
  lines?: number;
}

export function LogTail({ url, lines = 200 }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setErr(null);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (cancelled) return;
        const all = t.split('\n');
        setText(all.slice(-lines).join('\n'));
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [url, lines]);

  if (err) return <div className="empty">Failed to load log: {err}</div>;
  if (text == null) return <div className="empty">Loading log…</div>;
  return <pre className="logtail">{text}</pre>;
}
