/** Pause background UI polling and reconcile immediately when it is shown. */
export function setVisibleInterval(callback: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (!document.hidden && timer === undefined) timer = setInterval(callback, ms);
  };
  const changed = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (!document.hidden) {
      callback();
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
