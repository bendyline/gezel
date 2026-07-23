import type { MeesterStatusReport, Poppetje as PoppetjeStruct } from '@bendyline/gezel';
import type { ReactNode } from 'react';
import { GezelIcon } from '../../components/GezelIcon.js';
import { useShowPoppetjes } from '../../components/useShowPoppetjes.js';
import { Poppetje } from '../../poppetje/index.js';
import { StatusReportPanel } from './StatusReportPanel.js';
import { TipOfDay } from './TipOfDay.js';
import { type HomeChip, type HomeNavView, greetingForHour } from './utils.js';

/** Which panel the greeting band's tab strip is showing. */
export type HomeGreetingTab = 'greeting' | 'status' | 'tour';

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
      {chips.map((c) => (
        <span key={c.label} className="home-workshop-chip">
          <span className="home-workshop-chip-dot" style={{ background: c.dot }} />
          {c.label}
        </span>
      ))}
    </>
  );
}

function HowColumn({ tag, title, children }: { tag: string; title: string; children: ReactNode }) {
  return (
    <div className="home-workshop-how">
      <div className="home-workshop-how-head">
        <span className="home-workshop-how-tag">{tag}</span>
        <span className="home-workshop-how-title">{title}</span>
      </div>
      <div className="home-workshop-how-body">{children}</div>
    </div>
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
 * The full-width hero. Three states: full (default), collapsed (single
 * status row), and a tab strip that swaps the left column between the
 * greeting, the meester's status report, and the "what is gezel" tour.
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
  onNavigate?: (view: HomeNavView) => void;
}) {
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

  if (collapsed) {
    return (
      <div className="home-workshop-greeting-collapsed">
        <Headline statusReport={report} greeting={greeting} onCtaClick={handleCta} />
        <div className="home-workshop-vrule" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <Chips chips={chips} />
        </div>
        <button
          type="button"
          className="home-workshop-collapse-btn"
          onClick={onToggleCollapse}
          title="Expand the greeting"
          aria-label="Expand the greeting"
        >
          <Chevron direction="down" />
        </button>
      </div>
    );
  }

  return (
    <div className="home-workshop-greeting" data-testid="greeting-band">
      <div className="home-workshop-greeting-top">
        {/* The date label and the tour share a tab strip — the tour reads
            as a second tab beside the greeting rather than a panel that
            adds height below. */}
        <div className="home-workshop-tabs" role="tablist" aria-label="Home view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'greeting'}
            className={`home-workshop-tab${tab === 'greeting' ? ' is-active' : ''}`}
            onClick={() => onTabChange('greeting')}
          >
            {dateLabel}
          </button>
          {report && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'status'}
              className={`home-workshop-tab${tab === 'status' ? ' is-active' : ''}`}
              onClick={() => onTabChange('status')}
            >
              Status report
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tour'}
            className={`home-workshop-tab${tab === 'tour' ? ' is-active' : ''}`}
            onClick={() => onTabChange('tour')}
          >
            New here? What is gezel
          </button>
        </div>
        <button
          type="button"
          className="home-workshop-collapse-btn"
          onClick={onToggleCollapse}
          title="Collapse to a single row"
          aria-label="Collapse the greeting"
        >
          <Chevron direction="up" />
        </button>
      </div>

      <div className="home-workshop-greeting-cols">
        <div className="home-workshop-greeting-left">
          {tab === 'status' && report ? (
            <StatusReportPanel
              report={report}
              running={statusRunning ?? false}
              {...(onRunStatusReport ? { onRefresh: onRunStatusReport } : {})}
            />
          ) : tab === 'tour' ? (
            <div className="home-workshop-tour-inline" role="tabpanel">
              <div className="home-workshop-tour-rows">
                <HowColumn tag="01" title="What gezel is">
                  A workshop that lives <em className="home-workshop-italic">on this machine</em> —
                  a small crew of AI craftspeople you assemble yourself. Free, open source, no
                  account. Nothing leaves the machine unless you say so.
                </HowColumn>
                <HowColumn tag="02" title="What a meester is">
                  <em className="home-workshop-italic">{meesterName}</em> greets you at the door.
                  Tell them what you want and they route it to the right gezel, hire a new one, or
                  spin up a job. Start here when you&rsquo;re not sure where to go.
                </HowColumn>
                <HowColumn tag="03" title="The rules of the game">
                  <strong>People, not agents.</strong> Local models first — cloud and the web are
                  opt-in and <em className="home-workshop-italic">always marked</em>. Calm by
                  default; one thing lights up when a gezel is working. Everything is yours, on your
                  disk.
                </HowColumn>
              </div>
              <div className="home-workshop-stamps">
                <span className="home-workshop-stamp sage">★ on this disk</span>
                <span className="home-workshop-stamp" style={{ opacity: 0.6 }}>
                  ↗ off-disk · off
                </span>
                <span
                  className="home-workshop-italic"
                  style={{ fontSize: 12, color: 'var(--ink-3)' }}
                >
                  free · open source · yours
                </span>
              </div>
            </div>
          ) : (
            <>
              <Headline statusReport={report} greeting={greeting} onCtaClick={handleCta} />
              <TipOfDay onNavigate={onNavigate} />
            </>
          )}
          <div className="home-workshop-chips">
            <Chips chips={chips} />
          </div>
        </div>

        {/* The whole standing figure + shelf + label is a poppetje showcase;
            when poppetjes are off (e.g. boring mode) hide it entirely rather
            than fall back to a letter tile on a shelf. */}
        {showPoppetjes && (
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
      </div>
    </div>
  );
}
