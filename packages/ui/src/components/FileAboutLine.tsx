import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** The first paragraph of a summary, as plain text short enough for one line. */
export function summaryLead(summary: string): string {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // A heading names the file; the prose under it says what it is.
  const first =
    paragraphs.find((p) => !/^#+\s/.test(p)) ?? paragraphs[0]?.replace(/^#+\s+/, '') ?? '';
  const plain = first.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  return plain.length > 280 ? `${plain.slice(0, 277).trimEnd()}…` : plain;
}

/**
 * One muted line above an open file: what the Boekwachter says it is. The
 * summary already exists in the index; this is where a person reading the
 * folder sees it. Nothing renders until the file has been read, and an edited
 * file shows nothing until it is read again.
 */
export function FileAboutLine({ projectId, path }: { projectId: string; path: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    api
      .getFileSummary(projectId, path)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);
  if (!summary) return null;
  const lead = summaryLead(summary);
  if (!lead) return null;
  return (
    <p className="file-about small" title={summary} data-testid="file-about">
      <span className="muted">About this file · </span>
      {lead}
    </p>
  );
}
