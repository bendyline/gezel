import type { StartupHomeView } from '@bendyline/gezel';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { type Root, createRoot } from 'react-dom/client';
import { greetingForHour } from '../views/home/greeting.js';
import { RAIL_DRAG_SLOP_PX, railDragHeight, railRollsUp } from '../views/home/sheet-rail.js';
import {
  StartupComposerFrame,
  StartupNavigation,
  StartupPlaceholder,
  StartupTitlebar,
  StartupWelcome,
} from './Chrome.js';
import { StartupReading } from './Reading.js';
import type { StartupHomeBridge } from './types.js';
import './startup.css';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Draws the start screen and returns a function that tears it down, which
 * only tests call: the handoff removes it in production. Every React root must
 * be unmounted, or a lazy reader chunk that lands after jsdom is gone commits
 * and React's deferred effect flush reads `window`.
 */
export function mountStartup(bridge: StartupHomeBridge): (() => void) | undefined {
  if (!bridge.active || document.getElementById('startup-home')) return undefined;
  const snapshot = bridge.snapshot;
  const name = snapshot?.meester?.name || '';
  const root = element('div', 'startup-home');
  root.id = 'startup-home';
  root.dataset.platform = window.__GEZEL__?.platform || '';
  document.documentElement.dataset.platform = root.dataset.platform;
  // With no snapshot, the side theme-init.js applied from the cache stands.
  if (snapshot?.sidebar) document.documentElement.dataset.sidebarSide = snapshot.sidebar;
  if (snapshot?.theme && snapshot.theme !== 'system')
    document.documentElement.dataset.theme = snapshot.theme;
  // This screen draws the title bar before the app does, so main has to hear
  // the theme from here too: at night the bar is a deeper sage, and the
  // window controls main paints beside it must match from the first frame.
  window.__GEZEL__?.setNativeTheme?.(snapshot?.theme ?? 'system');
  const view: StartupHomeView = {
    ...bridge.state,
    tab: bridge.state.tab === 'chat' ? ('greeting' as const) : bridge.state.tab,
    focused: false,
  };
  let busy = false;
  let accept: ((state: StartupHomeView) => Promise<void>) | undefined;
  const hour = new Date().getHours();
  const greeting = greetingForHour(hour);
  const header = element('header', 'app-header startup-header');
  const brand = element('div', 'startup-brand-host');
  const brandRoot = createRoot(brand);
  header.append(brand);
  const right = element('div', 'app-header-right');
  const pill = element('div', 'activity-control startup-status');
  pill.append(element('span', 'activity-control-dot'));
  const status = element('span', 'activity-control-label startup-status-label', 'Starting…');
  status.id = 'gezel-splash-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  pill.append(status);
  right.append(pill);
  header.append(right);
  root.append(header);

  // A home nobody has used yet opens on the Meester's welcome, with no
  // greeting tabs or sheet above it, so this screen draws that shape instead.
  const welcome = snapshot?.welcome === true;
  root.dataset.shape = welcome ? 'welcome' : 'workshop';
  const layout = element('div', 'app-body');
  const pane = element('main', 'app-main');
  const main = element('div', 'home-workshop');
  const stage = element('div', 'home-workshop-stage');
  const band = element('div', 'home-workshop-greeting');
  const top = element('div', 'home-workshop-greeting-top');
  const tabs = element('div', 'home-workshop-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Meester intro');
  top.append(tabs);
  const sheet = element('div', 'home-workshop-intro-sheet');
  const content = element('section', 'home-workshop-greeting-cols startup-reading');
  content.id = 'startup-reading';
  content.setAttribute('role', 'tabpanel');
  content.tabIndex = 0;
  const rail = element('button', 'home-workshop-sheet-rail');
  rail.type = 'button';
  rail.title = 'Roll up';
  rail.setAttribute('aria-label', 'Roll up the greeting');
  sheet.append(content, rail);
  band.append(top, sheet);
  // Where the conversation and the composer will stand: what is coming, in
  // motion, and the composer's frame. A faint spinner and "Loading" at 40%
  // ink sat here, easy to miss under a page that was about to change.
  const loading = element('div', 'startup-loading');
  const loadingRoot = createRoot(loading);
  if (welcome) band.hidden = true;
  stage.append(band, loading);
  main.append(stage);
  pane.append(main);
  const sidebar = element('aside', 'app-sidebar startup-sidebar');
  sidebar.setAttribute('aria-label', 'Navigation');
  const nav = element('nav', 'app-sidebar-scroll');
  const homeRoot = createRoot(nav);
  const contentRoot = createRoot(content);
  const readingRoots = new Map<HTMLElement, Root>([[content, contentRoot]]);
  sidebar.append(nav);
  layout.append(sidebar, pane);
  root.append(layout);

  // A rolled-up sheet is handed over as the conversation tab, which the live
  // Home opens rolled up. Each launch still opens the sheet.
  let collapsed = false;
  function current(): StartupHomeView {
    return collapsed ? { ...view, tab: 'chat' } : { ...view };
  }
  // Navigation uses a synchronous, bounded IPC copy. Disk writes stay asynchronous.
  const save = () => {
    bridge.save(current());
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const deferSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 120);
  };
  // The position comes from scroll events, never from the DOM at handoff: on the
  // service page the reader remounts behind a lazy chunk, and until that lands
  // the DOM reports 0 for a page the person left part-way down.
  const recordScroll = () => {
    view.scroll = content.querySelector('.home-intro-doc')?.scrollTop || content.scrollTop;
    deferSave();
  };
  content.addEventListener('scroll', recordScroll, { passive: true, capture: true });
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);

  // The live Home's tabs: Night shift only when there is a night to read
  // about, and Create, which opens once the workshop is ready.
  const choices: Array<[StartupHomeView['tab'], string]> = [
    ['greeting', greeting],
    ...(snapshot?.night || view.tab === 'night'
      ? [['night', 'Night shift'] as [StartupHomeView['tab'], string]]
      : []),
    ['tour', 'Help'],
  ];
  const buttons = new Map<StartupHomeView['tab'], HTMLButtonElement>();
  function render(target = content) {
    target.classList.toggle('home-workshop-greeting-cols-fill', view.tab === 'tour');
    for (const [id, button] of buttons) {
      button.setAttribute('aria-selected', String(id === view.tab));
      button.setAttribute('aria-expanded', String(!collapsed && id === view.tab));
      button.dataset.state = id === view.tab ? 'active' : 'inactive';
      button.tabIndex = id === view.tab ? 0 : -1;
    }
    target.setAttribute('aria-label', choices.find(([id]) => id === view.tab)?.[1] || greeting);
    target.dataset.articleId = 'welcome';
    let renderer = readingRoots.get(target);
    if (!renderer) {
      renderer = createRoot(target);
      readingRoots.set(target, renderer);
      target.addEventListener(
        'startup-reading-dispose',
        () => {
          renderer?.unmount();
          readingRoots.delete(target);
        },
        { once: true },
      );
    }
    flushSync(() =>
      renderer.render(
        createElement(StartupReading, {
          snapshot,
          view: { ...view },
          onReportChange: (index: number) => {
            view.article = index;
            view.scroll = 0;
            render(target);
            if (target === content) save();
          },
        }),
      ),
    );
    if (view.tab !== 'tour') target.scrollTop = view.scroll;
  }
  choices.forEach(([id, label], index) => {
    const button = element('button', 'gz-tabs-trigger home-workshop-tab', label);
    button.id = `startup-tab-${id}`;
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', content.id);
    // As on the live Home: the open tab rolls its sheet up, any tab reopens it.
    button.onclick = () => {
      if (!collapsed && view.tab === id) {
        setCollapsed(true);
        return;
      }
      if (view.tab !== id) {
        view.tab = id;
        view.scroll = 0;
      }
      setCollapsed(false);
    };
    button.onkeydown = (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % choices.length
          : event.key === 'ArrowLeft'
            ? (index + choices.length - 1) % choices.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? choices.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = buttons.get(choices[next]![0]);
      target?.click();
      target?.focus();
    };
    buttons.set(id, button);
    tabs.append(button);
  });
  // Create opens only once the workshop is ready; it holds its place.
  const create = element('button', 'gz-tabs-trigger home-workshop-tab', 'Create');
  create.type = 'button';
  create.disabled = true;
  create.title = 'Opens when Gezel is ready';
  create.dataset.state = 'inactive';
  tabs.insertBefore(create, buttons.get('tour') ?? null);
  function setCollapsed(next: boolean) {
    collapsed = next;
    band.classList.toggle('home-workshop-greeting-collapsed', next);
    sheet.setAttribute('aria-hidden', String(next));
    sheet.inert = next;
    render();
    save();
  }
  // The rail pulls like the live one: the sheet follows the pointer with its
  // transition off, and letting go past the threshold rolls it the rest of
  // the way up. A drag swallows the click that follows it.
  let drag: { pointerId: number; startY: number; height: number; moved: boolean } | null = null;
  let skipRailClick = false;
  rail.addEventListener('pointerdown', (event) => {
    skipRailClick = false;
    if (event.button !== 0 || collapsed) return;
    rail.setPointerCapture?.(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      height: sheet.getBoundingClientRect().height,
      moved: false,
    };
  });
  rail.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const lift = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(lift) < RAIL_DRAG_SLOP_PX) return;
    drag.moved = true;
    sheet.dataset.dragging = '';
    sheet.style.height = `${railDragHeight(drag.height, lift)}px`;
  });
  const endRailDrag = (event: PointerEvent, letGo: boolean) => {
    const ended = drag;
    if (!ended || ended.pointerId !== event.pointerId) return;
    drag = null;
    if (!ended.moved) return;
    skipRailClick = true;
    sheet.style.height = '';
    delete sheet.dataset.dragging;
    if (letGo && railRollsUp(ended.height, ended.startY - event.clientY)) setCollapsed(true);
  };
  rail.addEventListener('pointerup', (event) => endRailDrag(event, true));
  rail.addEventListener('pointercancel', (event) => endRailDrag(event, false));
  rail.onclick = () => {
    if (skipRailClick) {
      skipRailClick = false;
      return;
    }
    setCollapsed(true);
  };
  document.body.append(root);
  const appRoot = document.getElementById('root');
  if (appRoot) appRoot.inert = true;
  render();
  const goHome = () => buttons.get('greeting')?.click();
  flushSync(() => {
    brandRoot.render(createElement(StartupTitlebar, { onHome: goHome }));
    homeRoot.render(createElement(StartupNavigation, { meesterName: name, onHome: goHome }));
    loadingRoot.render(
      welcome
        ? createElement(
            'div',
            { className: 'startup-conversation' },
            createElement(StartupWelcome, { snapshot, greeting }),
            createElement(StartupComposerFrame),
          )
        : createElement(
            'div',
            { className: 'startup-conversation' },
            createElement(
              'div',
              { className: 'startup-conversation-lines' },
              createElement(StartupPlaceholder),
            ),
            createElement(StartupComposerFrame),
          ),
    );
  });
  const retry = element('button', 'startup-retry', 'Open Gezel');
  retry.type = 'button';
  retry.hidden = true;
  right.append(retry);

  async function transfer() {
    if (!accept || busy) return;
    busy = true;
    const finalState = current();
    bridge.save(finalState);
    status.textContent = finalState.draft.trim() ? 'Saving your draft…' : 'Opening Gezel…';
    root.inert = true;
    try {
      await accept(finalState);
      // The reader remains in place until React has applied the handoff.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!bridge.finish(finalState.draft)) throw new Error('Draft changed during handoff');
      window.removeEventListener('pagehide', save);
      window.removeEventListener('beforeunload', save);
      clearTimeout(saveTimer);
      if (appRoot) appRoot.inert = false;
      root.classList.add('startup-leaving');
      setTimeout(() => {
        brandRoot.unmount();
        homeRoot.unmount();
        contentRoot.unmount();
        loadingRoot.unmount();
        root.remove();
      }, 160);
      window.__GEZEL_STARTUP__ = undefined;
      window.dispatchEvent(new CustomEvent('gezel:startup-finished', { detail: finalState }));
    } catch {
      status.textContent = 'Still opening Gezel. Try again.';
      retry.hidden = false;
      root.inert = false;
      busy = false;
    }
  }
  retry.onclick = () => {
    void transfer();
  };
  window.__GEZEL_STARTUP__ = {
    state: current,
    reading() {
      const copy = element(
        'section',
        'home-workshop-greeting-cols startup-reading startup-reading-live',
      );
      copy.dataset.startupScroll = String(view.scroll);
      copy.dataset.articleId = 'welcome';
      copy.tabIndex = 0;
      render(copy);
      return copy;
    },
    connect(callback) {
      accept = callback;
      void transfer();
    },
  };
  window.dispatchEvent(new Event('gezel:startup-mounted'));
  return () => {
    window.removeEventListener('pagehide', save);
    window.removeEventListener('beforeunload', save);
    clearTimeout(saveTimer);
    for (const renderer of [brandRoot, homeRoot, loadingRoot, ...readingRoots.values()]) {
      renderer.unmount();
    }
    readingRoots.clear();
    root.remove();
  };
}

if (typeof window !== 'undefined') {
  const start = () => {
    const bridge = window.__GEZEL__?.startupHome;
    if (bridge?.active) mountStartup(bridge);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
