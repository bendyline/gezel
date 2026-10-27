import type { StartupHomeSnapshot, StartupHomeView } from '@bendyline/gezel';
import { Component, type ReactNode, Suspense, lazy } from 'react';
import { Poppetje } from '../poppetje/Poppetje.js';
import { HomeHeadline, HomeIntroDate } from '../views/home/HomeIntroHeading.js';
import { MeesterFigureFrame } from '../views/home/MeesterFigureFrame.js';
import { TipOfDayPresentation } from '../views/home/TipOfDayPresentation.js';
import { greetingForHour, isFreshStatus } from '../views/home/greeting.js';

const Documents = lazy(() =>
  import('./documents.js').then((module) => ({ default: module.StartupDocuments })),
);
class ReadingError extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <output>This page will be available when your workshop is ready.</output>
    ) : (
      this.props.children
    );
  }
}
export function StartupReading({
  snapshot,
  view,
  onReportChange,
}: {
  snapshot: StartupHomeSnapshot | null;
  view: StartupHomeView;
  onReportChange?: (index: number) => void;
}) {
  const tab = view.tab === 'chat' ? 'greeting' : view.tab;
  const hour = new Date().getHours();
  const greeting = greetingForHour(hour);
  const status = snapshot?.status && isFreshStatus(snapshot.status.at) ? snapshot.status : null;
  const meester = snapshot?.meester;
  return (
    <>
      <div className="home-workshop-greeting-left">
        {tab === 'greeting' && (
          <>
            <HomeIntroDate />
            <HomeHeadline
              greeting={greeting}
              statusReport={
                status
                  ? {
                      headline: status.headline,
                      report: status.content,
                      generatedAt: status.at,
                      trigger: 'auto',
                      actions: [],
                    }
                  : null
              }
            />
          </>
        )}
        {tab === 'greeting' && !status ? (
          <TipOfDayPresentation />
        ) : (
          <ReadingError key={tab}>
            <Suspense
              fallback={
                <output className="home-loading-placeholder">
                  <span className="home-loading-spinner" />
                  Loading
                </output>
              }
            >
              <Documents
                snapshot={snapshot}
                tab={tab}
                scroll={view.scroll}
                reportIndex={view.article}
                onReportChange={onReportChange}
              />
            </Suspense>
          </ReadingError>
        )}
      </div>
      {tab !== 'tour' && meester?.poppetje && snapshot?.showPoppetjes !== false && (
        <div className="home-workshop-greeting-right">
          <MeesterFigureFrame name={meester.name}>
            <Poppetje
              poppetje={meester.poppetje}
              variant="full"
              size={64}
              title={`${meester.name} poppetje`}
            />
          </MeesterFigureFrame>
        </div>
      )}
    </>
  );
}
