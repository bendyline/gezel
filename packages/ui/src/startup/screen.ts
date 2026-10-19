import type { StartupHomeView } from '@bendyline/gezel';
import { appendReading } from './reader.js';
import type { StartupHomeBridge } from './types.js';
import './startup.css';

declare const __STARTUP_ARTICLES__: Array<{ id: string; markdown: string }>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function mountStartup(bridge: StartupHomeBridge, articles = __STARTUP_ARTICLES__): void {
  if (!bridge.active || document.getElementById('startup-home')) return;
  const snapshot = bridge.snapshot;
  const name = snapshot?.meester?.name || 'your meester';
  const root = element('div', 'startup-home');
  root.id = 'startup-home';
  root.dataset.platform = window.__GEZEL__?.platform || '';
  root.dataset.sidebar = snapshot?.sidebar || 'right';
  if (snapshot?.theme && snapshot.theme !== 'system')
    document.documentElement.dataset.theme = snapshot.theme;
  let view = { ...bridge.state };
  let busy = false;
  let accept: ((state: StartupHomeView) => Promise<void>) | undefined;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const header = element('header', 'startup-header');
  header.append(element('span', 'startup-brand', 'gezel'));
  const search = element('div', 'startup-search', 'Search projects, files, docs…');
  search.setAttribute('aria-disabled', 'true');
  header.append(search);
  const status = element('span', 'startup-status', 'Starting your workshop…');
  status.id = 'gezel-splash-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  header.append(status);
  root.append(header);

  const layout = element('div', 'startup-layout');
  const main = element('main', 'startup-main');
  const tabs = element('div', 'startup-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Home');
  const content = element('section', 'startup-reading');
  content.id = 'startup-reading';
  content.setAttribute('role', 'tabpanel');
  content.tabIndex = 0;
  const composer = element('section', 'startup-composer');
  composer.append(element('div', 'startup-address', `To: ${name} · Meester`));
  const input = element('textarea');
  input.placeholder = 'Talk with your meester about what you’d like to do.';
  input.setAttribute('aria-label', 'Message to your meester');
  input.maxLength = 32_000;
  input.value = view.draft;
  composer.append(
    input,
    element(
      'div',
      'startup-draft-note',
      'You can start writing. Send will be available when your workshop is ready.',
    ),
  );
  const sidebar = element('aside', 'startup-sidebar');
  sidebar.setAttribute('aria-label', 'Navigation');
  sidebar.append(element('div', 'startup-home-link', `⌂  Home · ${name}`));
  for (const label of ['Projects', 'Documents', 'Gezellen']) {
    sidebar.append(element('div', 'startup-nav-label', label));
    if (label === 'Gezellen' && snapshot?.meester) {
      const person = element('div', 'startup-person');
      person.append(
        element('span', 'startup-avatar', name[0] || 'G'),
        element('span', '', `${name}\nMeester`),
      );
      sidebar.append(person);
    }
  }
  sidebar.append(element('p', 'startup-nav-note', 'Your workshop will join you here shortly.'));
  main.append(tabs, content, composer);
  layout.append(main, sidebar);
  root.append(layout);

  function current(): StartupHomeView {
    return {
      ...view,
      scroll: content.scrollTop,
      draft: input.value,
      focused: document.activeElement === input,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    };
  }
  // Navigation uses a synchronous, bounded IPC copy. Disk writes stay asynchronous.
  const save = () => {
    view = current();
    bridge.save(view);
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const deferSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 120);
  };
  input.addEventListener('input', deferSave);
  input.addEventListener('select', deferSave);
  content.addEventListener('scroll', deferSave, { passive: true });
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);

  const choices: Array<[StartupHomeView['tab'], string]> = [
    ['greeting', greeting],
    ['night', 'Night shift'],
    ['tour', 'Handboek'],
    ['chat', 'Conversation'],
  ];
  const buttons = new Map<StartupHomeView['tab'], HTMLButtonElement>();
  const savedLabel = (at?: string) => {
    const date = at ? new Date(at) : null;
    return date && Number.isFinite(date.getTime())
      ? `Saved ${date.toLocaleString()}`
      : 'Saved for this visit';
  };
  function render(target = content) {
    target.replaceChildren();
    for (const [id, button] of buttons) {
      button.setAttribute('aria-selected', String(id === view.tab));
      button.tabIndex = id === view.tab ? 0 : -1;
    }
    target.setAttribute('aria-label', choices.find(([id]) => id === view.tab)?.[1] || greeting);
    const content = target;
    if (view.tab === 'tour') {
      target.dataset.articleId = (articles[view.article] || articles[0])?.id || 'welcome';
      content.append(element('p', 'startup-eyebrow', 'Handboek'));
      const picker = element('div', 'startup-article-picker');
      articles.forEach((article, index) => {
        const title = /^title:\s*["']?(.+?)["']?\r?$/m.exec(article.markdown)?.[1] || article.id;
        const button = element('button', '', title);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(index === view.article));
        button.onclick = () => {
          view.article = index;
          view.scroll = 0;
          render(target);
          save();
        };
        picker.append(button);
      });
      content.append(picker);
      appendReading(
        content,
        (articles[view.article] || articles[0])?.markdown || 'Welcome to Gezel.',
      );
    } else if (view.tab === 'night') {
      content.append(element('h1', '', 'Night shift'));
      const night = snapshot?.night;
      if (night) {
        content.append(
          element(
            'p',
            'startup-eyebrow',
            `Night ending ${new Date(night.windowEnd).toLocaleString()}`,
          ),
        );
        content.append(
          element(
            'p',
            '',
            `${night.completed} tasks finished · ${night.reports.length} saved reports`,
          ),
        );
        for (const report of night.reports) {
          content.append(
            element('h2', '', report.title),
            element('p', 'startup-eyebrow', report.project),
          );
          appendReading(content, report.content);
        }
        content.append(
          element(
            'p',
            'startup-note',
            'The latest work and report actions will be available when your workshop opens.',
          ),
        );
      } else
        content.append(
          element(
            'p',
            '',
            'There isn’t a saved night report yet. Your latest work will appear when your workshop opens.',
          ),
        );
    } else {
      content.append(
        element(
          'p',
          'startup-eyebrow',
          `${new Date().toLocaleDateString(undefined, { weekday: 'long' })} · ${name}`,
        ),
      );
      content.append(element('h1', '', greeting));
      if (view.tab === 'greeting' && snapshot?.status) {
        content.append(
          element('h2', '', snapshot.status.headline),
          element('p', 'startup-eyebrow', savedLabel(snapshot.status.at)),
        );
        appendReading(content, snapshot.status.content);
      } else if (view.tab === 'greeting') {
        content.append(
          element(
            'p',
            '',
            'Make yourself at home. Read the Handboek or start a message while your workshop opens.',
          ),
        );
      }
      if (snapshot?.lastMessage) {
        const message = element('div', 'startup-last-message');
        message.append(
          element(
            'p',
            'startup-eyebrow',
            `Your last message · ${savedLabel(snapshot.lastMessage.at)}`,
          ),
        );
        appendReading(message, snapshot.lastMessage.content);
        content.append(message);
      } else if (view.tab === 'chat')
        content.append(element('p', '', 'Start a new conversation below.'));
    }
    content.scrollTop = view.scroll;
  }
  choices.forEach(([id, label], index) => {
    const button = element('button', '', label);
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
  if (view.focused) {
    input.focus();
    input.setSelectionRange(view.selectionStart, view.selectionEnd);
  }
  const retry = element('button', 'startup-retry', 'Open workshop');
  retry.type = 'button';
  retry.hidden = true;
  header.append(retry);

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
      setTimeout(() => root.remove(), 160);
      window.__GEZEL_STARTUP__ = undefined;
      window.dispatchEvent(new CustomEvent('gezel:startup-finished', { detail: finalState }));
    } catch {
      status.textContent = 'Your draft is safe here. Try opening your workshop again.';
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
      view = current();
      const copy = element('section', 'startup-reading startup-reading-live');
      copy.dataset.startupScroll = String(view.scroll);
      copy.dataset.articleId = articles[view.article]?.id || 'welcome';
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
