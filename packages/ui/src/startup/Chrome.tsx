import type { StartupHomeSnapshot } from '@bendyline/gezel';
import { AppBrand } from '../components/AppBrand.js';
import { WorkshopIcon } from '../components/AreaIcon.js';
import {
  NAVIGATION_MORE_LABEL,
  NavigationArea,
  NavigationGroup,
  NavigationHome,
} from '../components/PrimaryNavigation.js';
import { Poppetje } from '../poppetje/Poppetje.js';
import { MeesterFigureFrame } from '../views/home/MeesterFigureFrame.js';

/**
 * The window's frame while the workshop starts, drawn with the live app's
 * own classes so nothing moves when the app takes over: the same keys in the
 * title bar and the same rows in the navigation. The start screen used to
 * show a brand, a status pill and a lone Home row, then the real bar and
 * rail arrived with back and forward keys, search and five more rows, about
 * ten seconds in (2026-11-09 review, item 8).
 *
 * Nothing here works yet, so the keys are disabled and the navigation below
 * Home is inert: they are there to hold their places.
 */

function Arrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={direction === 'back' ? '15 6 9 12 15 18' : '9 6 15 12 9 18'} />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="gz-dropdown-chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m2.25 4.25 3.75 3.5 3.75-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg className="titlebar-search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 7 1.8zm3.8 8.9 3.4 3.4"
      />
    </svg>
  );
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Back, Forward and the trail; the brand; the search well. */
export function StartupTitlebar({ onHome }: { onHome: () => void }) {
  return (
    <>
      <div className="app-header-history" role="toolbar" aria-label="Back and forward">
        <button type="button" className="app-history-key" disabled aria-label="Back">
          <Arrow direction="back" />
        </button>
        <button type="button" className="app-history-key" disabled aria-label="Forward">
          <Arrow direction="forward" />
        </button>
        <button
          type="button"
          className="app-history-key app-history-trail"
          disabled
          aria-label="Views you have visited"
        >
          <Chevron />
        </button>
      </div>
      <AppBrand active onClick={onHome} />
      <div className="titlebar-search startup-titlebar-search" aria-hidden="true">
        <SearchGlyph />
        <input
          type="text"
          className="titlebar-search-input"
          placeholder="Search projects, files, docs…"
          disabled
          tabIndex={-1}
        />
        <span className="titlebar-search-shortcut">{isMac() ? '⌘P' : 'Ctrl+P'}</span>
      </div>
    </>
  );
}

const noop = () => {};

/** The navigation rail's rows, in the live rail's order. */
export function StartupNavigation({
  meesterName,
  onHome,
}: {
  meesterName: string;
  onHome: () => void;
}) {
  return (
    <>
      <NavigationHome
        active
        onOpen={onHome}
        label={
          <span>
            Home{' '}
            {meesterName ? <span className="app-sidebar-home-meester">· {meesterName}</span> : null}
          </span>
        }
      />
      <div className="startup-navigation-rest" inert>
        <NavigationGroup id="projects" area="projects" expanded={false} onToggle={noop} />
        <NavigationGroup id="documents" area="documents" expanded={false} onToggle={noop} />
        <NavigationGroup id="gezels" area="gezels" label="Crew" expanded={false} onToggle={noop} />
        <NavigationGroup
          id="workshop"
          label={NAVIGATION_MORE_LABEL}
          icon={<WorkshopIcon size={18} />}
          expanded={false}
          onToggle={noop}
        />
        <div className="app-sidebar-links">
          <NavigationArea area="knowledge" />
          <NavigationArea area="settings" />
        </div>
      </div>
    </>
  );
}

/** Placeholder lines that say, in motion, that text is on its way. */
export function StartupPlaceholder({ lines = [92, 78, 85, 40] }: { lines?: number[] }) {
  return (
    <div className="startup-placeholder" aria-hidden="true">
      {lines.map((width, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of decorative lines
          key={index}
          className="startup-placeholder-line"
          style={{ width: `${width}%`, animationDelay: `${index * 140}ms` }}
        />
      ))}
    </div>
  );
}

/** "Opening Gezel…", with its dots in motion. */
export function StartupLoadingLine() {
  return (
    <output className="startup-loading-line">
      Opening Gezel
      <span className="startup-loading-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </output>
  );
}

/**
 * What a home nobody has used yet opens on: the Meester's welcome. Drawn in
 * its shape (the figure, the greeting, the cards to come) so the welcome
 * fills it in rather than replacing a different page.
 */
export function StartupWelcome({
  snapshot,
  greeting,
}: {
  snapshot: StartupHomeSnapshot | null;
  greeting: string;
}) {
  const meester = snapshot?.meester;
  return (
    <div className="meester-welcome startup-welcome">
      {meester?.poppetje && snapshot?.showPoppetjes !== false && (
        <div className="meester-welcome-figure">
          <MeesterFigureFrame name={meester.name}>
            <Poppetje
              poppetje={meester.poppetje}
              variant="full"
              size={88}
              title={`${meester.name} poppetje`}
            />
          </MeesterFigureFrame>
        </div>
      )}
      <div className="meester-welcome-body">
        <h2 className="meester-welcome-title">
          {greeting}.{meester?.name ? ` I'm ${meester.name} — I run things here.` : ''}
        </h2>
        <StartupPlaceholder lines={[96, 88, 60]} />
        <div className="startup-placeholder-cards" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

/**
 * The composer's frame, where the composer will stand. Its draft area says
 * the workshop is opening, where the live composer's hint will appear: the
 * one part of the page an open greeting sheet never covers.
 */
export function StartupComposerFrame() {
  return (
    <div className="startup-composer">
      <div className="startup-composer-band" aria-hidden="true" />
      <div className="startup-composer-draft">
        <StartupLoadingLine />
      </div>
    </div>
  );
}
