import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type AutosavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface AutosaveSnapshot {
  phase: AutosavePhase;
  dirty: boolean;
  error: Error | null;
}

export interface AutosaveSavedEvent<Result> {
  type: 'saved';
  result: Result;
  value: string;
}

type AutosaveListener<Result> = (
  snapshot: AutosaveSnapshot,
  event?: AutosaveSavedEvent<Result>,
) => void;

interface AutosaveRegistryEntry {
  controller: SerializedAutosaveController<unknown>;
  users: number;
}

// A controller outlives its current view while a cleanup write is pending (or
// failed). Reopening the same resource therefore joins the existing lane
// instead of creating a second request stream that could race it.
const controllerRegistry = new Map<string, AutosaveRegistryEntry>();

/** Flush a mounted or cleanup-pending lane by its stable resource key. */
export async function flushSerializedAutosave(resourceKey: string): Promise<void> {
  const entry = controllerRegistry.get(resourceKey);
  if (!entry) return;
  await entry.controller.flush();
}

/**
 * A single-resource, latest-value-wins save lane.
 *
 * `desired` and `acknowledged` deliberately remain separate. A value is
 * acknowledged only after its write resolves, and the drain loop permits at
 * most one request at a time. Edits made during a request are coalesced into
 * the next request instead of racing the current one.
 */
export class SerializedAutosaveController<Result> {
  readonly resourceKey: string;

  private desired: string;
  private acknowledged: string;
  private save: (value: string) => Promise<Result>;
  private readonly debounceMs: number;
  private phase: AutosavePhase = 'idle';
  private error: Error | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<Result | undefined> | null = null;
  private activeValue: string | null = null;
  private needsWrite = false;
  private listeners = new Set<AutosaveListener<Result>>();

  constructor(options: {
    resourceKey: string;
    initialValue: string;
    save: (value: string) => Promise<Result>;
    debounceMs?: number;
  }) {
    this.resourceKey = options.resourceKey;
    this.desired = options.initialValue;
    this.acknowledged = options.initialValue;
    this.save = options.save;
    this.debounceMs = options.debounceMs ?? 1000;
  }

  configure(save: (value: string) => Promise<Result>): void {
    this.save = save;
  }

  getSnapshot(): AutosaveSnapshot {
    return {
      phase: this.phase,
      // Reverting to the previous acknowledged value while a different
      // value is in flight is still dirty: that in-flight value may land,
      // after which the drain must write the revert.
      dirty: this.desired !== this.acknowledged || this.activeValue !== null || this.needsWrite,
      error: this.error,
    };
  }

  getDesiredValue(): string {
    return this.desired;
  }

  getAcknowledgedValue(): string {
    return this.acknowledged;
  }

  subscribe(listener: AutosaveListener<Result>): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  update(value: string): void {
    this.desired = value;
    this.error = null;
    this.phase =
      this.activeValue !== null
        ? 'saving'
        : value === this.acknowledged && !this.needsWrite
          ? // A no-op update on a lane that never saved stays idle — editors
            // emit their initial content at mount, and flipping to "saved"
            // for a write that never happened flashes a false status on a
            // freshly opened view.
            this.phase === 'idle'
            ? 'idle'
            : 'saved'
          : 'dirty';
    this.emit();

    this.clearTimer();
    if (value !== this.acknowledged || this.needsWrite) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {
          // The error is retained in the snapshot for an explicit retry.
        });
      }, this.debounceMs);
    }
  }

  /** Replace local state with a value known to be authoritative. */
  adopt(value: string): void {
    if (this.activeValue !== null || this.drainPromise || this.getSnapshot().dirty) {
      throw new Error(`Cannot adopt ${this.resourceKey} while its autosave lane is dirty`);
    }
    this.clearTimer();
    this.desired = value;
    this.acknowledged = value;
    this.needsWrite = false;
    this.error = null;
    this.phase = 'saved';
    this.emit();
  }

  /**
   * Seed a newly loaded view without discarding a queued draft from an older
   * generation of that same resource. Returns the value the editor should
   * display.
   */
  hydrate(value: string): string {
    if (this.activeValue !== null || this.drainPromise || this.getSnapshot().dirty) {
      return this.desired;
    }
    this.clearTimer();
    this.desired = value;
    this.acknowledged = value;
    this.needsWrite = false;
    this.error = null;
    this.phase = 'idle';
    this.emit();
    return value;
  }

  async saveNow(value: string): Promise<Result | undefined> {
    this.update(value);
    this.clearTimer();
    return this.flush();
  }

  retry(): Promise<Result | undefined> {
    this.clearTimer();
    return this.flush();
  }

  flush(): Promise<Result | undefined> {
    this.clearTimer();
    if (this.drainPromise) return this.drainPromise;
    if (this.desired === this.acknowledged && !this.needsWrite) {
      return Promise.resolve(undefined);
    }

    const task = this.drain();
    this.drainPromise = task;
    task.then(
      () => {
        if (this.drainPromise === task) this.drainPromise = null;
      },
      () => {
        if (this.drainPromise === task) this.drainPromise = null;
      },
    );
    return task;
  }

  private async drain(): Promise<Result | undefined> {
    let latestResult: Result | undefined;

    while (this.desired !== this.acknowledged || this.needsWrite) {
      const value = this.desired;
      this.activeValue = value;
      this.phase = 'saving';
      this.error = null;
      this.emit();

      try {
        latestResult = await this.save(value);
      } catch (cause) {
        this.activeValue = null;
        // A rejected HTTP request is ambiguous: the service may have
        // committed the write before the response failed. Reassert the
        // latest desired value on Retry even when it equals our previous
        // acknowledgement watermark.
        this.needsWrite = true;
        this.phase = 'error';
        this.error = cause instanceof Error ? cause : new Error(String(cause));
        this.emit();
        throw this.error;
      }

      // Only a completed write advances the acknowledgement watermark.
      this.acknowledged = value;
      this.activeValue = null;
      this.needsWrite = false;
      if (this.desired === value) {
        this.phase = 'saved';
        this.error = null;
        this.emit({ type: 'saved', result: latestResult, value });
      } else {
        // A newer edit arrived while this request was in flight. Keep the
        // lane visibly busy and immediately write the coalesced latest value.
        this.phase = 'saving';
        this.emit();
      }
    }

    return latestResult;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(event?: AutosaveSavedEvent<Result>): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot, event);
  }
}

export interface UseSerializedAutosaveOptions<Result> {
  resourceKey: string;
  initialValue: string;
  save: (value: string) => Promise<Result>;
  debounceMs?: number;
  onLatestSaved?: (result: Result, value: string) => void;
}

export interface SerializedAutosave<Result> extends AutosaveSnapshot {
  update(value: string): void;
  adopt(value: string): void;
  hydrate(value: string): string;
  flush(): Promise<Result | undefined>;
  retry(): Promise<Result | undefined>;
  saveNow(value: string): Promise<Result | undefined>;
  desiredValue(): string;
  acknowledgedValue(): string;
}

/** React adapter that joins the single save lane identified by `resourceKey`. */
export function useSerializedAutosave<Result>(
  options: UseSerializedAutosaveOptions<Result>,
): SerializedAutosave<Result> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: resourceKey is the generation boundary; changing callbacks or loaded values must not reset a dirty lane.
  const entry = useMemo(() => {
    const existing = controllerRegistry.get(options.resourceKey);
    if (existing) return existing;
    const created: AutosaveRegistryEntry = {
      controller: new SerializedAutosaveController<Result>({
        resourceKey: options.resourceKey,
        initialValue: options.initialValue,
        save: options.save,
        debounceMs: options.debounceMs,
      }) as unknown as SerializedAutosaveController<unknown>,
      users: 0,
    };
    controllerRegistry.set(options.resourceKey, created);
    return created;
  }, [options.resourceKey]);
  const controller = entry.controller as SerializedAutosaveController<Result>;
  controller.configure(options.save);

  const latestSavedRef = useRef(options.onLatestSaved);
  latestSavedRef.current = options.onLatestSaved;
  const [snapshot, setSnapshot] = useState<AutosaveSnapshot>(() => controller.getSnapshot());

  useLayoutEffect(() => {
    entry.users += 1;
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe((next, event) => {
      setSnapshot(next);
      if (event?.type === 'saved') latestSavedRef.current?.(event.result, event.value);
    });
    return () => {
      unsubscribe();
      entry.users -= 1;
      // Preserve the user's last debounced edit when the view changes. The
      // keyed registry keeps the lane available if the same resource is
      // reopened before completion, and retains a failed draft for Retry.
      if (controller.getSnapshot().phase === 'error') return;
      void controller.flush().then(
        () => {
          if (
            entry.users === 0 &&
            !controller.getSnapshot().dirty &&
            controllerRegistry.get(controller.resourceKey) === entry
          ) {
            controllerRegistry.delete(controller.resourceKey);
          }
        },
        () => {
          // Keep the dirty controller in the registry. Reopening the resource
          // restores the draft and its explicit Retry affordance.
        },
      );
    };
  }, [controller, entry]);

  const update = useCallback((value: string) => controller.update(value), [controller]);
  const adopt = useCallback((value: string) => controller.adopt(value), [controller]);
  const hydrate = useCallback((value: string) => controller.hydrate(value), [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);
  const retry = useCallback(() => controller.retry(), [controller]);
  const saveNow = useCallback((value: string) => controller.saveNow(value), [controller]);
  const desiredValue = useCallback(() => controller.getDesiredValue(), [controller]);
  const acknowledgedValue = useCallback(() => controller.getAcknowledgedValue(), [controller]);

  return useMemo(
    () => ({
      ...snapshot,
      update,
      adopt,
      hydrate,
      flush,
      retry,
      saveNow,
      desiredValue,
      acknowledgedValue,
    }),
    [snapshot, update, adopt, hydrate, flush, retry, saveNow, desiredValue, acknowledgedValue],
  );
}
