import type { MeesterStatusReport, StartupHomeSnapshot } from '@bendyline/gezel';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HomeGreetingTab } from './GreetingBand.js';

/**
 * How the startup screen's reading copy gives way to the live panel: not
 * yet (`wait`), at once because the person would see the same thing
 * (`same`), or with a short fade because the live panel has news (`changed`).
 */
export type StartupHandover = 'wait' | 'same' | 'changed';

/** A live panel that never settles still beats a copy whose controls are dead. */
const MAX_WAIT_MS = 8_000;
/** Scrolling this recently means the person is mid-read. */
const SCROLL_IDLE_MS = 400;
const FADE_MS = 240;

export function startupHandover({
  tab,
  savedStatus,
  liveStatus,
  statusSettled,
  nightSettled,
}: {
  tab: HomeGreetingTab;
  /** The fresh report the copy shows, or null when it shows the tip. */
  savedStatus: StartupHomeSnapshot['status'];
  liveStatus: MeesterStatusReport | null;
  statusSettled: boolean;
  nightSettled: boolean;
}): StartupHandover {
  switch (tab) {
    // The bundled introduction is the article the live tab loads.
    case 'tour':
      return 'same';
    // The copy leaves out proposals, the morning card and live report
    // actions, so the live panel always looks different.
    case 'night':
      return nightSettled ? 'changed' : 'wait';
    case 'greeting':
      if (!statusSettled) return 'wait';
      if (!savedStatus || !liveStatus) return !savedStatus && !liveStatus ? 'same' : 'changed';
      return savedStatus.headline === liveStatus.headline &&
        savedStatus.content === liveStatus.report &&
        savedStatus.at === liveStatus.generatedAt
        ? 'same'
        : 'changed';
    default:
      return 'changed';
  }
}

function readerOf(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.home-intro-doc') ?? root;
}

function leave(overlay: HTMLElement | null, panel: HTMLElement | null, onDone: () => void) {
  const focused = !!overlay?.contains(document.activeElement);
  onDone();
  // The live panel stays inert until the overlay is gone.
  if (focused && panel) requestAnimationFrame(() => panel.focus({ preventScroll: true }));
}

/**
 * Holds the startup screen's reading copy over the live panel while the live
 * one loads beneath it, then steps aside on its own. The copy is not React's:
 * the startup screen rendered it into its own root.
 */
export function StartupReadingOverlay({
  node,
  handover,
  live,
  onDone,
}: {
  node: HTMLElement;
  handover: StartupHandover;
  live: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const deadline = useRef(Date.now() + MAX_WAIT_MS);
  const leaving = useRef(false);
  // Outlive the effect below, which restarts whenever the verdict changes.
  const pressed = useRef(false);
  const scrolledAt = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const [fading, setFading] = useState(false);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el || node.parentElement === el) return;
    el.append(node);
    readerOf(node).scrollTop = Number(node.dataset.startupScroll || 0);
  }, [node]);

  useEffect(() => {
    const el = host.current;
    const panel = live.current;
    if (!el) return;
    const busy = () => !panel || panel.querySelector('[aria-busy="true"]') !== null;
    const reading = () => {
      const selection = document.getSelection();
      return (
        pressed.current ||
        Date.now() - scrolledAt.current < SCROLL_IDLE_MS ||
        (!!selection && !selection.isCollapsed && el.contains(selection.anchorNode))
      );
    };
    const attempt = () => {
      if (leaving.current || reading()) return;
      const late = Date.now() >= deadline.current;
      if (!late && (handover === 'wait' || busy())) return;
      leaving.current = true;
      if (handover === 'same' && panel && !busy()) {
        readerOf(panel).scrollTop = readerOf(node).scrollTop;
        leave(el, panel, done.current);
      } else if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        leave(el, panel, done.current);
      } else {
        setFading(true);
      }
    };

    const press = () => {
      pressed.current = true;
    };
    const release = () => {
      pressed.current = false;
      attempt();
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const scrolled = () => {
      scrolledAt.current = Date.now();
      clearTimeout(idle);
      idle = setTimeout(attempt, SCROLL_IDLE_MS);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('scroll', scrolled, { capture: true, passive: true });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    document.addEventListener('selectionchange', attempt);
    const observer = new MutationObserver(attempt);
    if (panel) {
      observer.observe(panel, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-busy'],
      });
    }
    const late = setTimeout(attempt, Math.max(0, deadline.current - Date.now()));
    attempt();
    return () => {
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('scroll', scrolled, { capture: true });
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      document.removeEventListener('selectionchange', attempt);
      observer.disconnect();
      clearTimeout(idle);
      clearTimeout(late);
    };
  }, [handover, live, node]);

  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => leave(host.current, live.current, done.current), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, live]);

  return (
    <div
      ref={host}
      className={`startup-reading-overlay${fading ? ' startup-reading-overlay-leaving' : ''}`}
    />
  );
}
