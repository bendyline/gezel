import type { StartupHomeSnapshot } from '@bendyline/gezel';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useLayoutEffect, useMemo, useRef } from 'react';
import welcome from '../../../../docs/handboek/conceptual/welcome.md?raw';
import mark from '../assets/gezel-mark.png';
import { gezelChatTheme } from '../components/chat-theme.js';
import { IntroArticleControls } from '../views/home/IntroArticleControls.js';
import { IntroArticleDocument } from '../views/home/IntroArticleDocument.js';
import { NightReviewSummary } from '../views/home/NightReviewSummary.js';
import { StatusReportPanel } from '../views/home/StatusReportPanel.js';
import { timeAgo } from '../views/home/utils.js';

// Squisq accepts relative media, but deliberately rejects absolute file: URLs.
const markSource = mark.startsWith('file:') ? `./assets/${mark.split('/').pop()}` : mark;

/** Loaded only for a saved report or after choosing Night shift/Handboek. */
export function StartupDocuments({
  snapshot,
  tab,
  scroll = 0,
  reportIndex = 0,
  onReportChange,
}: {
  snapshot: StartupHomeSnapshot | null;
  tab: 'greeting' | 'night' | 'tour';
  scroll?: number;
  reportIndex?: number;
  onReportChange?: (index: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const reports = snapshot?.night?.reports ?? [];
  const markdown =
    tab === 'tour'
      ? welcome.replace('../assets/gezel-mark.png', markSource)
      : (reports[Math.min(reportIndex, reports.length - 1)]?.content ?? '');
  const doc = useMemo(
    () =>
      markdownToDoc(
        parseMarkdown(markdown),
        tab === 'tour' ? undefined : { articleId: 'night-review' },
      ),
    [markdown, tab],
  );
  useLayoutEffect(() => {
    const reader = host.current?.querySelector('.home-intro-doc');
    if (reader) reader.scrollTop = scroll;
  }, [scroll]);
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <div
      ref={host}
      className={tab === 'tour' ? 'home-workshop-tour-inline' : undefined}
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
      }}
    >
      {tab === 'greeting' && snapshot?.status ? (
        <StatusReportPanel
          running={false}
          report={{
            headline: snapshot.status.headline,
            report: snapshot.status.content,
            generatedAt: snapshot.status.at,
            trigger: 'auto',
            actions: [],
          }}
        />
      ) : tab === 'tour' ? (
        <div className="home-intro-article">
          <IntroArticleControls mode="doc" />
          <IntroArticleDocument doc={doc} mode={dark ? 'dark' : 'light'} />
        </div>
      ) : (
        <div className="home-workshop-status-report" data-testid="night-review-panel">
          {snapshot?.night ? (
            <NightReviewSummary
              completed={snapshot.night.completed}
              reports={snapshot.night.reportCount ?? reports.length}
              proposals={snapshot.night.proposals}
              actions={snapshot.night.actions}
            />
          ) : (
            <p className="home-workshop-night-summary">
              Your night shift reports will appear when your workshop is ready.
            </p>
          )}
          {reports.length > 0 && (
            <div className="home-workshop-status-body">
              <LinearDocView
                doc={doc}
                theme={gezelChatTheme}
                thinMargins
                imageDisplayMode="thumbnail"
              />
            </div>
          )}
          {reports.length > 1 && (
            <div className="home-workshop-night-reports">
              {reports.map((report, index) => (
                <button
                  type="button"
                  className="home-workshop-night-report-row"
                  key={`${report.title}-${index}`}
                  onClick={() => onReportChange?.(index)}
                  aria-pressed={index === reportIndex}
                >
                  <span className="home-workshop-night-report-title">{report.title}</span>
                  <span className="muted small">{report.project}</span>
                </button>
              ))}
            </div>
          )}
          {snapshot?.night && (
            <div className="home-workshop-status-foot">
              <span className="home-workshop-status-meta">
                Night window ended {timeAgo(snapshot.night.windowEnd)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import '@bendyline/squisq-react/styles';

import '../styles/file-browser.css';
import '../styles/home.css';
import '../styles/squisq-theme.css';
