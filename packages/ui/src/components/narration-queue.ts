/**
 * The app's one narration voice: the queue every chat timeline feeds, and the
 * titlebar's stop key watches. Kept apart from the tracker in
 * chat-narration.ts, whose tool-call parsing the startup bundle does not need.
 */

import { api } from '../api.js';

/**
 * Progress updates waiting to be spoken, beyond the one playing. A gezel in
 * a fast tool loop says "Now I'll…" faster than a voice can read it; past
 * this the oldest waiting update is dropped rather than read minutes late.
 */
const MAX_WAITING_PROGRESS = 2;

/** A progress update that waited this long is no longer news. */
const PROGRESS_STALE_MS = 45_000;

/** Bound on remembered utterance keys, turn keys, and windows. */
const MEMORY_CAP = 500;

export interface NarrationSpeaker {
  gezelId: string;
  projectId: string;
}

export interface NarrationRequest extends NarrationSpeaker {
  /**
   * The same words at the same place in the same turn. The chat event bus
   * replays an in-flight turn to every subscriber that (re)connects, and
   * more than one timeline can be mounted at once, so every utterance
   * arrives more than once; the key is what makes it speak once.
   */
  key: string;
  sessionId: string;
  turnKey: string;
  /**
   * Which stretch of the turn's speech this is: the words between two
   * boundaries (a tool call, a tool result, thinking). Live narration sends a
   * stretch a sentence at a time; the queue keeps a stretch together and only
   * ever drops a whole one.
   */
  window: number;
  kind: 'progress' | 'reply';
  text: string;
}

/** How the queue turns a request into sound. Injected for tests. */
export interface NarrationPlayer {
  /**
   * Synthesize the request, handing each piece of audio (base64 WAV, about a
   * sentence) to `onClip` in order as soon as it exists. Resolves once all
   * of it has been delivered.
   */
  synthesize(
    request: NarrationRequest,
    signal: AbortSignal,
    onClip: (b64Wav: string) => void,
  ): Promise<void>;
  /** Resolves when playback ends, fails, or `signal` aborts it. */
  play(b64Wav: string, signal: AbortSignal): Promise<void>;
}

/** Identity of a request's window, and when it began waiting. */
interface Placed {
  sessionId: string;
  kind: NarrationRequest['kind'];
  /** `session\nturn`: the windows of one turn, in order. */
  lane: string;
  window: number;
  windowId: string;
  queuedAt: number;
}

type WaitingRequest = NarrationRequest & Placed;

interface Clip extends Placed {
  b64Wav: string;
}

function rememberBounded<T>(set: Set<T>, value: T): void {
  set.add(value);
  if (set.size <= MEMORY_CAP) return;
  const oldest = set.values().next();
  if (!oldest.done) set.delete(oldest.value);
}

/**
 * Speaks narration in order, one voice at a time. Shared by every mounted
 * timeline so two views of the same session neither talk over each other
 * nor say the same thing twice.
 *
 * Synthesis runs ahead of the voice — the next sentence is made while this
 * one plays — but never more than one window ahead, so an update that goes
 * stale while it waits is dropped before it costs anything. An update is
 * dropped only whole and only before any of it has been heard; a reply, and
 * the window a turn is still speaking in, never are.
 */
export class NarrationQueue {
  private waiting: WaitingRequest[] = [];
  private clips: Clip[] = [];
  private readonly spoken = new Set<string>();
  private readonly turns = new Set<string>();
  /** Windows the voice has begun, whose remainder is never dropped. */
  private readonly heard = new Set<string>();
  /** Windows that turned out to hold a turn's reply. */
  private readonly replies = new Set<string>();
  /** Windows dropped, so audio still arriving for them is discarded. */
  private readonly dropped = new Set<string>();
  /** The newest window seen per turn: every older one is finished. */
  private readonly newest = new Map<string, number>();
  /** Turns silenced by {@link stop}: the rest of what they say is dropped. */
  private readonly muted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private wasActive = false;
  private synthesis: { ctrl: AbortController; sessionId: string; windowId: string } | null = null;
  private playback: { ctrl: AbortController; sessionId: string; windowId: string } | null = null;
  private synthesizing = false;
  private playing = false;
  private holders = 0;

  constructor(
    private readonly player: NarrationPlayer,
    private readonly now: () => number = Date.now,
  ) {}

  /** The voice is speaking or about to: audio playing, being made, or waiting its turn. */
  get active(): boolean {
    return (
      this.playback !== null ||
      this.synthesis !== null ||
      this.clips.length > 0 ||
      this.waiting.length > 0
    );
  }

  /** Called whenever {@link active} changes. Shaped for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Held by each mounted timeline; the voice stops when the last one lets go. */
  retain(): () => void {
    this.holders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders === 0) this.stop();
    };
  }

  /**
   * True the first time a user message is seen. False for a replay, a
   * re-publish, or the same event reaching a second timeline — none of
   * which is the user moving on.
   */
  noteTurn(sessionId: string, turnKey: string): boolean {
    const id = `${sessionId}\n${turnKey}`;
    if (this.turns.has(id)) return false;
    rememberBounded(this.turns, id);
    return true;
  }

  enqueue(request: NarrationRequest): void {
    if (this.spoken.has(request.key)) return;
    rememberBounded(this.spoken, request.key);
    const lane = `${request.sessionId}\n${request.turnKey}`;
    const windowId = `${lane}\n${request.window}`;
    if (this.dropped.has(windowId) || this.muted.has(lane)) return;
    if ((this.newest.get(lane) ?? -1) < request.window) {
      this.newest.delete(lane);
      this.newest.set(lane, request.window);
      if (this.newest.size > MEMORY_CAP) {
        const oldest = this.newest.keys().next();
        if (!oldest.done) this.newest.delete(oldest.value);
      }
    }
    if (request.kind === 'reply') rememberBounded(this.replies, windowId);
    this.waiting.push({ ...request, lane, windowId, queuedAt: this.now() });
    this.dropOverflow();
    void this.pumpSynthesis();
    this.changed();
  }

  /**
   * Silence now: cut the current utterance, drop everything waiting, and say
   * nothing more of any turn already heard from. A reply still streaming
   * would otherwise start the voice again at its next sentence, a second
   * after the user asked for quiet. The next turn speaks as usual.
   */
  stop(): void {
    for (const lane of this.newest.keys()) rememberBounded(this.muted, lane);
    this.waiting = [];
    this.clips = [];
    this.synthesis?.ctrl.abort();
    this.synthesis = null;
    this.playback?.ctrl.abort();
    this.playback = null;
    this.changed();
  }

  /** Silence one session — its turn was cancelled — and let the others speak on. */
  silence(sessionId: string): void {
    this.waiting = this.waiting.filter((r) => r.sessionId !== sessionId);
    this.clips = this.clips.filter((c) => c.sessionId !== sessionId);
    if (this.synthesis?.sessionId === sessionId) {
      this.synthesis.ctrl.abort();
      this.synthesis = null;
    }
    if (this.playback?.sessionId === sessionId) {
      this.playback.ctrl.abort();
      this.playback = null;
    }
    this.changed();
  }

  private changed(): void {
    const active = this.active;
    if (active === this.wasActive) return;
    this.wasActive = active;
    for (const listener of this.listeners) listener();
  }

  /** A finished update nobody has heard any of yet. */
  private droppable(item: Placed): boolean {
    return (
      item.kind === 'progress' &&
      !this.replies.has(item.windowId) &&
      !this.heard.has(item.windowId) &&
      (this.newest.get(item.lane) ?? -1) > item.window
    );
  }

  private isStale(item: Placed): boolean {
    return this.droppable(item) && this.now() - item.queuedAt > PROGRESS_STALE_MS;
  }

  private drop(windowId: string): void {
    rememberBounded(this.dropped, windowId);
    this.waiting = this.waiting.filter((r) => r.windowId !== windowId);
    this.clips = this.clips.filter((c) => c.windowId !== windowId);
    if (this.synthesis?.windowId === windowId) {
      this.synthesis.ctrl.abort();
      this.synthesis = null;
    }
  }

  private dropOverflow(): void {
    const candidates: string[] = [];
    for (const item of [...this.clips, ...this.waiting]) {
      if (this.droppable(item) && !candidates.includes(item.windowId)) {
        candidates.push(item.windowId);
      }
    }
    while (candidates.length > MAX_WAITING_PROGRESS) this.drop(candidates.shift()!);
  }

  /** The next window's waiting requests, or undefined when there are none or it is too far ahead. */
  private take(): WaitingRequest[] | undefined {
    for (let next = this.waiting[0]; next; next = this.waiting[0]) {
      if (this.isStale(next)) {
        this.drop(next.windowId);
        continue;
      }
      const ahead = new Set(this.clips.map((c) => c.windowId));
      if (this.playback) ahead.delete(this.playback.windowId);
      ahead.delete(next.windowId);
      if (ahead.size > 0) return undefined;
      const batch = this.waiting.filter((r) => r.windowId === next.windowId);
      this.waiting = this.waiting.filter((r) => r.windowId !== next.windowId);
      return batch;
    }
    return undefined;
  }

  private async pumpSynthesis(): Promise<void> {
    if (this.synthesizing) return;
    this.synthesizing = true;
    try {
      for (let batch = this.take(); batch; batch = this.take()) {
        const first = batch[0]!;
        // Sentences of one window that piled up while the engine was busy
        // go as one request: one round trip, the same audio.
        const request: NarrationRequest = { ...first, text: batch.map((r) => r.text).join(' ') };
        const ctrl = new AbortController();
        this.synthesis = { ctrl, sessionId: first.sessionId, windowId: first.windowId };
        try {
          console.debug(`[narrate] synth ${request.kind} chars=${request.text.length}`);
          await this.player.synthesize(request, ctrl.signal, (b64Wav) => {
            if (ctrl.signal.aborted || this.dropped.has(first.windowId)) return;
            this.clips.push({ ...first, b64Wav });
            void this.pumpPlayback();
          });
        } catch (err) {
          if (!ctrl.signal.aborted) console.warn('[narrate] failed:', err);
        } finally {
          if (this.synthesis?.ctrl === ctrl) this.synthesis = null;
        }
      }
    } finally {
      this.synthesizing = false;
      this.changed();
    }
  }

  private nextClip(): Clip | undefined {
    for (let clip = this.clips.shift(); clip; clip = this.clips.shift()) {
      if (!this.isStale(clip)) return clip;
      this.drop(clip.windowId);
    }
    return undefined;
  }

  private async pumpPlayback(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      for (let clip = this.nextClip(); clip; clip = this.nextClip()) {
        rememberBounded(this.heard, clip.windowId);
        const ctrl = new AbortController();
        this.playback = { ctrl, sessionId: clip.sessionId, windowId: clip.windowId };
        // The voice moved on, so synthesis may be clear to run ahead again.
        void this.pumpSynthesis();
        try {
          await this.player.play(clip.b64Wav, ctrl.signal);
        } catch (err) {
          if (!ctrl.signal.aborted) console.warn('[narrate] playback failed:', err);
        } finally {
          if (this.playback?.ctrl === ctrl) this.playback = null;
        }
      }
    } finally {
      this.playing = false;
    }
    void this.pumpSynthesis();
    this.changed();
  }
}

function playWav(b64Wav: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(`data:audio/wav;base64,${b64Wav}`);
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* best-effort */
      }
      finish();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.play().catch((err) => {
      console.warn('[narrate] playback rejected:', err);
      finish();
    });
  });
}

/**
 * The app's one narration voice. Each utterance is synthesized with the
 * speaking gezel's per-character voice — the route resolves it from the
 * gezel's frontmatter when we pass `gezelId` — and streamed back a sentence
 * at a time, so a long reply starts playing after its first sentence.
 * Nothing is saved: chat narration is heard once, and a WAV per sentence in
 * the artifacts drawer would be clutter.
 */
export const chatNarrationQueue = new NarrationQueue({
  async synthesize(request, signal, onClip) {
    await api.synthesizeSpeechWithProgress(
      {
        text: request.text,
        gezelId: request.gezelId,
        projectId: request.projectId,
        persist: false,
      },
      {
        onProgress: () => {},
        onChunk: (chunk) => onClip(chunk.b64Wav),
      },
      signal,
    );
  },
  play: playWav,
});
