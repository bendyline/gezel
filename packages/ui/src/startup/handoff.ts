import type { StartupHomeView } from '@bendyline/gezel';
import { api } from '../api.js';
import { writeDraftText } from '../components/composer-drafts.js';

// A StrictMode effect or a failed visual handoff must reuse the same saved draft.
let imported: { text: string; id: string } | undefined;
let importing: Promise<string | undefined> | undefined;
export function saveStartupDraft(
  state: StartupHomeView,
  meesterId?: string,
): Promise<string | undefined> {
  if (!state.draft.trim()) return Promise.resolve(undefined);
  if (!meesterId) return Promise.reject(new Error('Waiting for the Meester'));
  if (importing) return importing;
  importing = (async () => {
    if (imported) {
      if (imported.text !== state.draft)
        await api.writePromptDraftContent('default', imported.id, state.draft);
      imported.text = state.draft;
    } else {
      const draft = await api.createPromptDraft('default', {
        gezelId: meesterId,
        sessionId: null,
        scope: 'meester',
        content: state.draft,
      });
      imported = { id: draft.id, text: state.draft };
    }
    writeDraftText(imported.id, state.draft);
    return imported.id;
  })().finally(() => {
    importing = undefined;
  });
  return importing;
}

/** Subscribe before announcing readiness; the small startup script can arrive after React. */
export function connectStartupHome(
  accept: (view: StartupHomeView, reading: HTMLElement) => Promise<void>,
): () => void {
  const connect = () => {
    const surface = window.__GEZEL_STARTUP__;
    surface?.connect(async (view) => accept(view, surface.reading()));
  };
  window.addEventListener('gezel:startup-mounted', connect);
  connect();
  return () => window.removeEventListener('gezel:startup-mounted', connect);
}

export function restoreStartupFocus(state: StartupHomeView): void {
  if (!state.focused) return;
  const editor = document.querySelector<HTMLElement>(
    '[data-testid="meester-chat"] [contenteditable="true"]',
  );
  editor?.focus({ preventScroll: true });
  if (editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}
