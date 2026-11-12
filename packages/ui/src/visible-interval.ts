import { asBackground } from './nav-timing.js';

/**
 * Pause background UI polling and reconcile immediately when it is shown.
 * Requests a tick starts are background work: navigation timing leaves them
 * out of the view being opened.
 */
export function setVisibleInterval(callback: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => asBackground(callback);
  const start = () => {
    if (!document.hidden && timer === undefined) timer = setInterval(tick, ms);
  };
  const changed = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (!document.hidden) {
      tick();
      start();
    }
  };
  start();
  document.addEventListener('visibilitychange', changed);
  return () => {
    if (timer !== undefined) clearInterval(timer);
    document.removeEventListener('visibilitychange', changed);
  };
}
