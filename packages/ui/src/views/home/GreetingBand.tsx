import type {
  MeesterStatusReport,
  NightShiftReviewResponse,
  Poppetje as PoppetjeStruct,
  Question,
} from '@bendyline/gezel';
import { type ReactNode, useEffect, useState } from 'react';
import { GezelIcon } from '../../components/GezelIcon.js';
import { useShowPoppetjes } from '../../components/useShowPoppetjes.js';
import { Poppetje } from '../../poppetje/index.js';
import * as Tabs from '../../primitives/Tabs.js';
import { IntroHandboekArticle } from './IntroHandboekArticle.js';
import { MorningPanel } from './MorningPanel.js';
import { NightReviewPanel } from './NightReviewPanel.js';
import { StatusReportPanel } from './StatusReportPanel.js';
import { TipOfDay } from './TipOfDay.js';
import { type HomeChip, type HomeNavView, greetingForHour } from './utils.js';

/** Which panel the greeting band's tab strip is showing. */
export type HomeGreetingTab = 'greeting' | 'night' | 'make' | 'tour';

/** Symmetric SVG chevron for the greeting's collapse / expand toggle.
 *  The Unicode arrowhead glyphs (⌃ ⌄) render asymmetrically and off-center
 *  across fonts — a stroked path lets us pin the apex and keep the
 *  visual weight even between the two directions. */
function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === 'up' ? <path d="M6 15 L12 9 L18 15" /> : <path d="M6 9 L12 15 L18 9" />}
    </svg>
  );
}

function Chips({ chips }: { chips: HomeChip[] }) {
  return (
    <>
      {chips.map((c) =>
        c.onClick ? (
          <button
            key={c.label}
            type="button"
            className="home-workshop-chip home-workshop-chip-action"
            onClick={c.onClick}
            title={c.actionLabel}
            aria-label={c.actionLabel ? `${c.label}: ${c.actionLabel}` : c.label}
          >
            <span className="home-workshop-chip-dot" style={{ background: c.dot }} />
            {c.label}
          </button>
        ) : (
          <span key={c.label} className="home-workshop-chip">
            <span className="home-workshop-chip-dot" style={{ background: c.dot }} />
            {c.label}
          </span>
        ),
      )}
    </>
  );
}

/**
 * The meester-written status headline when a fresh report exists (the
 * parent already applied the staleness decay), falling back to the
 * time-of-day greeting. With a CTA the headline itself is the click
 * target — one big affordance, not a separate link.
 */
function Headline({
  statusReport,
  greeting,
  onCtaClick,
}: {
  statusReport: MeesterStatusReport | null;
  greeting: string;
  onCtaClick?: () => void;
}) {
  if (!statusReport) return <h1 className="home-workshop-headline">{greeting}.</h1>;
  if (statusReport.cta && onCtaClick) {
    return (
      <h1 className="home-workshop-headline">
        <button
          type="button"
          className="home-workshop-headline-cta"
          onClick={onCtaClick}
          title={statusReport.cta.label}
        >
          {statusReport.headline}
        </button>
      </h1>
    );
  }
  return <h1 className="home-workshop-headline">{statusReport.headline}</h1>;
}

/**
 * The intro keeps its destinations visible when collapsed. Selecting a tab
 * opens that panel; the parent owns the persisted collapse preference.
 * There is no stored user name, so the fallback headline is the
 * time-of-day greeting only.
 */
export function GreetingBand({
  chips,
  meesterName,
  meesterPoppetje,
  meesterIcon,
  meesterIconOverride,
  collapsed,
  onToggleCollapse,
  tab,
  onTabChange,
  statusReport,
  statusRunning,
  onRunStatusReport,
  nightReview,
  morning,
  makeSomething,
  onNavigate,
}: {
  chips: HomeChip[];
  meesterName: string;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIcon: string | null;
  meesterIconOverride: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  tab: HomeGreetingTab;
  onTabChange: (tab: HomeGreetingTab) => void;
  statusReport?: MeesterStatusReport | null;
  statusRunning?: boolean;
  onRunStatusReport?: () => void;
  /** Last night's review, when fresh and non-empty (parent applies decay). */
  nightReview?: NightShiftReviewResponse | null;
  /** The unanswered morning card leads the Night shift tab until dismissed. */
  morning?: {
    question: Question;
    review: NightShiftReviewResponse | null;
    onAnswered?: (q: Question) => void;
  } | null;
  makeSomething?: ReactNode;
  onNavigate?: (view: HomeNavView) => void;
}) {
  // Keep the current panel in place while its sheet rolls up. The timeout
  // also releases it when reduced motion suppresses transition events.
  const [contentMounted, setContentMounted] = useState(!collapsed);
  useEffect(() => {
    if (!collapsed) {
      setContentMounted(true);
      return;
    }
    const timeout = window.setTimeout(() => setContentMounted(false), 180);
    return () => window.clearTimeout(timeout);
  }, [collapsed]);
  const showPoppetjes = useShowPoppetjes();
  const now = new Date();
  const hour = now.getHours();
  const greeting = greetingForHour(hour);
  const report = statusReport ?? null;
  const handleCta = () => {
    const target = report?.cta?.target;
    if (!target) return;
    if (target.kind === 'view') {
      onNavigate?.(target.view);
    } else if (target.kind === 'project') {
      window.dispatchEvent(
        new CustomEvent('gezel:open-tab', {
          detail: { kind: 'project', id: target.projectId, activate: true },
        }),
      );
    } else {
      window.dispatchEvent(
        new CustomEvent('gezel:open-tab', {
          detail: { kind: 'task', ref: target.taskRef, activate: true },
        }),
      );
    }
  };
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const time = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateLabel = `${weekday} ${partOfDay} · ${time}`;
  const panels: { value: HomeGreetingTab; label: string }[] = [
    { value: 'greeting', label: 'Good morning' },
  ];
  if (morning || nightReview) panels.push({ value: 'night', label: 'Night shift' });
  if (makeSomething) panels.push({ value: 'make', label: 'Make something' });
  panels.push({ value: 'tour', label: 'Handboek' });
  const activeTab = panels.some((panel) => panel.value === tab) ? tab : 'greeting';

  return (
    <Tabs.Root
      value={activeTab}
      onValueChange={(value) => onTabChange(value as HomeGreetingTab)}
      className={`home-workshop-greeting${collapsed ? ' home-workshop-greeting-collapsed' : ''}`}
      data-testid="greeting-band"
    >
      <div className="home-workshop-greeting-top">
        <Tabs.List className="home-workshop-tabs" aria-label="Meester intro">
          {panels.map(({ value, label }) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="home-workshop-tab"
              aria-expanded={!collapsed && activeTab === value}
              onClick={() => {
                // Radix only changes the value for a different tab. The
                // selected tab must also reopen its collapsed panel.
                if (collapsed && activeTab === value) onTabChange(value);
              }}
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {collapsed && chips.length > 0 && (
          <div className="home-workshop-collapsed-chips">
            <Chips chips={chips} />
          </div>
        )}
        <button
          type="button"
          className="home-workshop-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand the greeting' : 'Collapse the greeting'}
          aria-label={collapsed ? 'Expand the greeting' : 'Collapse the greeting'}
          aria-expanded={!collapsed}
        >
          <Chevron direction={collapsed ? 'down' : 'up'} />
        </button>
      </div>

      <div
        className="home-workshop-intro-sheet"
        aria-hidden={collapsed}
        inert={collapsed}
        onTransitionEnd={(event) => {
          if (
            collapsed &&
            event.target === event.currentTarget &&
            event.propertyName === 'height'
          ) {
            setContentMounted(false);
          }
        }}
      >
        {(!collapsed || contentMounted) && (
          <Tabs.Content value={activeTab} className="home-workshop-greeting-cols">
            <div className="home-workshop-greeting-left">
              {activeTab === 'night' && morning ? (
                <MorningPanel
                  question={morning.question}
                  review={morning.review}
                  {...(morning.onAnswered ? { onAnswered: morning.onAnswered } : {})}
                />
              ) : activeTab === 'night' && nightReview ? (
                <NightReviewPanel review={nightReview} />
              ) : activeTab === 'make' ? (
                makeSomething
              ) : activeTab === 'tour' ? (
                <div className="home-workshop-tour-inline">
                  <IntroHandboekArticle />
                </div>
              ) : (
                <>
                  <div className="home-workshop-eyebrow">{dateLabel}</div>
                  <Headline statusReport={report} greeting={greeting} onCtaClick={handleCta} />
                  {report ? (
                    <StatusReportPanel
                      report={report}
                      running={statusRunning ?? false}
                      {...(onRunStatusReport ? { onRefresh: onRunStatusReport } : {})}
                    />
                  ) : (
                    <TipOfDay onNavigate={onNavigate} />
                  )}
                </>
              )}
              <div className="home-workshop-chips">
                <Chips chips={chips} />
              </div>
            </div>

            {/* The whole standing figure + shelf + label is a poppetje showcase;
            when poppetjes are off (e.g. boring mode) hide it entirely rather
            than fall back to a letter tile on a shelf. */}
            {showPoppetjes && activeTab !== 'make' && (
              <div className="home-workshop-greeting-right">
                <div className="home-workshop-figure">
                  {meesterPoppetje ? (
                    <Poppetje
                      poppetje={meesterPoppetje}
                      variant="full"
                      size={64}
                      title={`${meesterName} poppetje`}
                    />
                  ) : (
                    <GezelIcon
                      poppetje={null}
                      svg={meesterIcon}
                      iconOverride={meesterIconOverride}
                      name={meesterName}
                      size={64}
                      variant="full"
                    />
                  )}
                  <div className="home-workshop-shelf" />
                  <div className="home-workshop-figure-label">
                    {meesterName} <em>- Meester</em>
                  </div>
                </div>
              </div>
            )}
          </Tabs.Content>
        )}
      </div>
    </Tabs.Root>
  );
}
