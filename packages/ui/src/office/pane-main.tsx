import { StrictMode } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../styles.css';
import './office.css';
import { BootScreen } from './BootScreen.js';
import { type BootState, bootPane } from './boot.js';
import { detectHost, documentPath } from './host.js';

/**
 * Task-pane entry: Office.js readiness, the connection, then the pane. The
 * chat runs in a same-origin frame of the main UI, which finds the pane's
 * token under the key it already reads (`gezel:token`).
 */

declare global {
  interface Window {
    __gezelHistory?: { pushState: History['pushState']; replaceState: History['replaceState'] };
  }
}

function restoreHistory(): void {
  const saved = window.__gezelHistory;
  if (!saved) return;
  if (typeof window.history.pushState !== 'function') window.history.pushState = saved.pushState;
  if (typeof window.history.replaceState !== 'function')
    window.history.replaceState = saved.replaceState;
}

function renderBoot(root: Root, state: BootState): void {
  root.render(
    <StrictMode>
      <BootScreen state={state} onRetry={() => window.location.reload()} />
    </StrictMode>,
  );
}

async function main(): Promise<void> {
  const el = document.getElementById('root');
  if (!el) return;
  const root = createRoot(el);
  if (typeof Office === 'undefined') {
    renderBoot(root, {
      kind: 'error',
      message:
        "Office's add-in library did not load. Check the internet connection, then try again.",
    });
    return;
  }
  await Office.onReady();
  restoreHistory();
  const host = detectHost();
  if (!host) {
    renderBoot(root, {
      kind: 'error',
      message: 'Open Gezel from the Home tab in Word, Excel, or PowerPoint.',
    });
    return;
  }
  const ready = await bootPane(
    {
      fetch: window.fetch.bind(window),
      baseUrl: window.location.origin,
      storage: window.localStorage,
      documentPath: documentPath(),
    },
    (state) => {
      if (state.kind !== 'ready') renderBoot(root, state);
    },
  );
  if (!ready) return;
  try {
    window.localStorage.setItem(UI_TOKEN_KEY, ready.token);
  } catch {
    renderBoot(root, {
      kind: 'error',
      message:
        'This Office pane cannot store its connection. Check that Office allows web storage for add-ins.',
    });
    return;
  }
  const { mountPane } = await import('./PaneApp.js');
  mountPane(root, ready, host);
}

/** The key the main UI reads its token from in a plain browser tab (see `api.ts`). */
const UI_TOKEN_KEY = 'gezel:token';

void main();
