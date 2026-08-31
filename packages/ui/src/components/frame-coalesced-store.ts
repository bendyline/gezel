export interface FrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const browserFrameScheduler: FrameScheduler = {
  request(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
  },
};

/**
 * Mutable high-frequency data with React-compatible version snapshots.
 *
 * Writers append every byte directly to {@link items}, then mark either the
 * affected item or the collection structure dirty. Subscribers are notified
 * at most once per animation frame, regardless of how many stream fragments
 * arrived in that frame. Item subscribers let a live bubble redraw without
 * invalidating the persisted timeline that contains it.
 */
export class FrameCoalescedStore<T> {
  readonly items = new Map<string, T>();

  private structureVersion = 0;
  private readonly itemVersions = new Map<string, number>();
  private readonly structureListeners = new Set<() => void>();
  private readonly itemListeners = new Map<string, Set<() => void>>();
  private readonly pendingItems = new Set<string>();
  private pendingStructure = false;
  private frameHandle: number | null = null;

  constructor(private readonly scheduler: FrameScheduler = browserFrameScheduler) {}

  readonly getStructureSnapshot = (): number => this.structureVersion;

  readonly subscribeStructure = (listener: () => void): (() => void) => {
    this.structureListeners.add(listener);
    return () => this.structureListeners.delete(listener);
  };

  getItemSnapshot(key: string): number {
    return this.itemVersions.get(key) ?? 0;
  }

  subscribeItem(key: string, listener: () => void): () => void {
    let listeners = this.itemListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.itemListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.itemListeners.delete(key);
    };
  }

  /** Notify only the component subscribed to this mutable item. */
  markItemChanged(key: string): void {
    this.pendingItems.add(key);
    this.scheduleFlush();
  }

  /** Notify collection consumers after an item was inserted, removed, or reordered. */
  markStructureChanged(): void {
    this.pendingStructure = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = this.scheduler.request(() => this.flush());
  }

  private flush(): void {
    this.frameHandle = null;
    const structureChanged = this.pendingStructure;
    const changedItems = [...this.pendingItems];
    this.pendingStructure = false;
    this.pendingItems.clear();

    if (structureChanged) {
      this.structureVersion += 1;
      for (const listener of this.structureListeners) listener();
    }
    for (const key of changedItems) {
      this.itemVersions.set(key, (this.itemVersions.get(key) ?? 0) + 1);
      for (const listener of this.itemListeners.get(key) ?? []) listener();
    }
  }

  dispose(): void {
    if (this.frameHandle !== null) this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
    this.pendingStructure = false;
    this.pendingItems.clear();
    this.structureListeners.clear();
    this.itemListeners.clear();
  }
}
