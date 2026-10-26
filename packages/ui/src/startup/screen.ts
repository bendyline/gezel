import type { StartupHomeView } from '@bendyline/gezel';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { type Root, createRoot } from 'react-dom/client';
import { AppBrand } from '../components/AppBrand.js';
import { NavigationHome } from '../components/PrimaryNavigation.js';
import { greetingForHour } from '../views/home/greeting.js';
import { StartupReading } from './Reading.js';
import type { StartupHomeBridge } from './types.js';
import './startup.css';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function mountStartup(bridge: StartupHomeBridge): void {
  if (!bridge.active || document.getElementById('startup-home')) return;
  const snapshot = bridge.snapshot;
  const name = snapshot?.meester?.name || '';
  const root = element('div', 'startup-home');
  root.id = 'startup-home';
  root.dataset.platform = window.__GEZEL__?.platform || '';
  document.documentElement.dataset.platform = root.dataset.platform;
  document.documentElement.dataset.sidebarSide = snapshot?.sidebar || 'right';
  if (snapshot?.theme && snapshot.theme !== 'system')
    document.documentElement.dataset.theme = snapshot.theme;
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
  const status = element('span', 'activity-control-label', 'Starting Gezel…');
  status.id = 'gezel-splash-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  pill.append(status);
  right.append(pill);
  header.append(right);
  root.append(header);

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
  sheet.append(content);
  band.append(top, sheet);
  const loading = element('div', 'startup-loading');
  loading.setAttribute('role', 'status');
  loading.append(element('span', 'home-loading-spinner'), element('span', '', 'Loading'));
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

  function current(): StartupHomeView {
    return { ...view };
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

  const choices: Array<[StartupHomeView['tab'], string]> = [
    ['greeting', greeting],
    ['night', 'Night shift'],
    ['tour', 'Handboek'],
  ];
  const buttons = new Map<StartupHomeView['tab'], HTMLButtonElement>();
  function render(target = content) {
    target.classList.toggle('home-workshop-greeting-cols-fill', view.tab === 'tour');
    for (const [id, button] of buttons) {
      button.setAttribute('aria-selected', String(id === view.tab));
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
    button.onclick = () => {
      view.tab = id;
      view.scroll = 0;
      render();
      save();
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
  document.body.append(root);
  const appRoot = document.getElementById('root');
  if (appRoot) appRoot.inert = true;
  render();
  const goHome = () => buttons.get('greeting')?.click();
  flushSync(() => {
    brandRoot.render(createElement(AppBrand, { active: true, onClick: goHome }));
    homeRoot.render(
      createElement(NavigationHome, {
        active: true,
        onOpen: goHome,
        label: createElement(
          'span',
          null,
          'Home ',
          name
            ? createElement('span', { className: 'app-sidebar-home-meester' }, `· ${name}`)
            : null,
        ),
      }),
    );
  });
  const retry = element('button', 'startup-retry', 'Open workshop');
  retry.type = 'button';
  retry.hidden = true;
  right.append(retry);

  async function transfer() {
    if (!accept || busy) return;
    busy = true;
    const finalState = current();
    bridge.save(finalState);
    status.textContent = finalState.draft.trim() ? 'Saving your draft…' : 'Opening your workshop…';
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
        root.remove();
      }, 160);
      window.__GEZEL_STARTUP__ = undefined;
      window.dispatchEvent(new CustomEvent('gezel:startup-finished', { detail: finalState }));
    } catch {
      status.textContent = 'Still opening your workshop. Try again.';
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
