import type { MeesterStatusReport } from '@bendyline/gezel';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useMemo } from 'react';
import { gezelChatTheme } from '../../components/chat-theme.js';
import { formatAbsoluteTime } from '../../relative-time.js';
import { timeAgo } from './utils.js';

/**
 * The meester's dashboard report — the markdown body of the current
 * status report, rendered with squisq like chat bubbles. Shown as a tab
 * panel inside the greeting band, with a refresh affordance that kicks
 * a manual run (completion arrives over SSE; the parent flips
 * `running` while the meester writes).
 */
export function StatusReportPanel({
  report,
  running,
  onRefresh,
}: {
  report: MeesterStatusReport;
  running: boolean;
  onRefresh?: () => void;
}) {
  const doc = useMemo(() => {
    try {
      return markdownToDoc(parseMarkdown(report.report), { articleId: 'meester-status' });
    } catch {
      return null;
    }
  }, [report.report]);

  return (
    <div className="home-workshop-status-report" role="tabpanel" data-testid="status-report-panel">
      <div className="home-workshop-status-body">
        {doc ? (
          <LinearDocView
            doc={doc}
            theme={gezelChatTheme}
            thinMargins
            imageDisplayMode="thumbnail"
          />
        ) : (
          <p>{report.report}</p>
        )}
      </div>
      <div className="home-workshop-status-foot">
        <span className="home-workshop-status-meta" title={formatAbsoluteTime(report.generatedAt)}>
          Written {timeAgo(report.generatedAt)}
        </span>
        {onRefresh && (
          <button
            type="button"
            className="home-workshop-tip-action"
            onClick={onRefresh}
            disabled={running}
          >
            {running ? 'Meester is writing…' : 'Write a fresh report'}
          </button>
        )}
      </div>
    </div>
  );
}
