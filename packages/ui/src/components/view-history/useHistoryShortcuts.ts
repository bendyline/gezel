import { useEffect } from 'react';

/**
 * Back and Forward from the keyboard and the mouse's side buttons, the way a
 * browser takes them: Alt+Left/Right (Cmd+[ / Cmd+] on macOS) and buttons 4
 * and 5. Keys typed into a field belong to the field: Alt+Left moves by word
 * there, and Cmd+[ outdents in the code editor.
 */

export function isMacPlatform(): boolean {
  const host = window.__GEZEL__?.platform;
  if (host) return host === 'darwin';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true;
  }
  return Boolean(target.closest('.monaco-editor, .cm-editor'));
}

/** Which way a key press moves through the stack, if it is one of ours. */
export function historyKeyDirection(event: KeyboardEvent, mac: boolean): 'back' | 'forward' | null {
  if (event.defaultPrevented || event.repeat || event.shiftKey) return null;
  if (mac) {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null;
    if (event.key === '[') return 'back';
    if (event.key === ']') return 'forward';
    return null;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === 'ArrowLeft') return 'back';
  if (event.key === 'ArrowRight') return 'forward';
  return null;
}

export function useHistoryShortcuts(history: { back: () => void; forward: () => void }): void {
  const { back, forward } = history;
  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (event: KeyboardEvent) => {
      const direction = historyKeyDirection(event, mac);
      if (!direction || isEditable(event.target)) return;
      event.preventDefault();
      if (direction === 'back') back();
      else forward();
    };
    // Buttons 4 and 5 report as 3 and 4. Cancelling the mouseup keeps a
    // browser tab from leaving the app on its own history.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3) back();
      else forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouseUp, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouseUp, true);
    };
  }, [back, forward]);
}
