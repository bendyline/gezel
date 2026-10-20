import { summaryLead as coreSummaryLead } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** A file summary's opening, short enough for one line above the file. */
export function summaryLead(summary: string): string {
  return coreSummaryLead(summary, 280);
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
