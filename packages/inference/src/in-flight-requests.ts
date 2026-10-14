/**
 * The in-process transport's open requests, and the one handle that keeps Node
 * running while any of them is open.
 *
 * The direct transport has no socket, so nothing a request awaits is
 * guaranteed to hold the event loop: engine supervisors and workers unref their
 * timers and threads so that an idle host never blocks exit. A plain Node
 * script exited with code 13 ("unsettled top-level await") inside `chat()`
 * while llama-server cold-started; Electron's own handles had hidden it.
 */
export class InFlightRequests {
  private readonly open = new Set<AbortController>();
  private keepAlive: ReturnType<typeof setInterval> | undefined;

  get size(): number {
    return this.open.size;
  }

  add(controller: AbortController): void {
    this.open.add(controller);
    this.keepAlive ??= setInterval(() => {}, 2 ** 30);
  }

  delete(controller: AbortController): void {
    if (!this.open.delete(controller) || this.open.size > 0) return;
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }

  /** Abort and forget every open request, including a body nobody will read. */
  abortAll(): void {
    for (const controller of [...this.open]) {
      controller.abort();
      this.delete(controller);
    }
  }
}
