import { api } from '../api.js';
import { speakableMessageText } from './message-preview.js';
import { parsePendingToolCalls } from './pending-tool-calls.js';

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

/**
 * - `off` — silent.
 * - `replies` — the reply a gezel ends its turn with, once the turn is done.
 * - `progress` — everything the gezel says, a sentence at a time as it
 *   streams: the short updates between tool calls, and the reply.
 */
export type ChatNarrationMode = 'off' | 'replies' | 'progress';

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

/**
 * Wrapper openers {@link parsePendingToolCalls} does not anchor on: it finds
 * the `<function=…>` inside `<tool_call>`, and has no Gemma parser at all.
 */
const TOOL_WRAPPER_OPENER = /<tool_call>|<\|tool_call\|?>|<function_calls>/;

/**
 * Where tool-call markup begins in streamed text, or -1. Local models that
 * call tools in text write the call into the same stream as their prose, so
 * the opener is the only sign the prose before it is finished.
 */
function toolMarkupStart(text: string): number {
  const parsed = parsePendingToolCalls(text)[0]?.position ?? -1;
  const wrapper = text.search(TOOL_WRAPPER_OPENER);
  if (parsed === -1) return wrapper;
  if (wrapper === -1) return parsed;
  return Math.min(parsed, wrapper);
}

/** Characters that may close a sentence after its terminator: quotes, brackets, emphasis. */
const SENTENCE_CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '*', '_']);

interface LiveScan {
  /** How far the scan has read; it resumes here when more text streams in. */
  scanned: number;
  /** The scan is inside a fenced code block. */
  inFence: boolean;
}

/**
 * The end of the next finished sentence or line in streamed text, or -1 when
 * none is certain yet. Resumes from `scan.scanned` and advances it.
 *
 * A sentence is finished only once whitespace follows its terminator, so
 * "3." never splits "3.5". The scan holds — returns -1 without moving past —
 * at anything that may still turn out not to be prose: a tag (tool-call
 * markup, `<think>`), a brace (a JSON tool envelope), or an unfinished code
 * span or fence. Held text is spoken at the next boundary, through the same
 * scrub a whole message gets, so holding costs a little latency and never a
 * wrong word.
 */
function nextLiveCut(text: string, scan: LiveScan): number {
  const hold = (at: number) => {
    scan.scanned = at;
    return -1;
  };
  let i = scan.scanned;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const lineEnd = text.indexOf('\n', i);
      const head = text.slice(i, lineEnd === -1 ? text.length : lineEnd).trimStart();
      if (head.startsWith('```')) {
        if (lineEnd === -1) return hold(i);
        const closing = scan.inFence;
        scan.inFence = !closing;
        i = lineEnd + 1;
        // A closed block is skipped by the scrub, so the cut can land here.
        if (closing) {
          scan.scanned = i;
          return i;
        }
        continue;
      }
      if (lineEnd === -1 && '```'.startsWith(head)) return hold(i);
    }
    if (scan.inFence) {
      const lineEnd = text.indexOf('\n', i);
      if (lineEnd === -1) return hold(text.length);
      i = lineEnd + 1;
      continue;
    }
    const ch = text[i]!;
    if (ch === '\n') {
      scan.scanned = i + 1;
      return i + 1;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      const lineEnd = text.indexOf('\n', i);
      if (close === -1 || (lineEnd !== -1 && lineEnd < close)) {
        if (lineEnd === -1) return hold(i);
        i += 1;
        continue;
      }
      i = close + 1;
      continue;
    }
    if (ch === '{') return hold(i);
    if (ch === '<') {
      const next = text[i + 1];
      if (next === undefined || /[A-Za-z/!|?]/.test(next)) return hold(i);
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < text.length && SENTENCE_CLOSERS.has(text[j]!)) j++;
      if (j >= text.length) return hold(i);
      if (/\s/.test(text[j]!)) {
        scan.scanned = j;
        return j;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  scan.scanned = text.length;
  return -1;
}

interface Taken {
  text: string;
  window: number;
  /** Offset of `text` within its window, part of each utterance's key. */
  start: number;
}

interface SessionWindow extends LiveScan {
  turnKey: string;
  speaker: NarrationSpeaker;
  /** Which window of the turn `raw` is; advances when a boundary closes some text. */
  index: number;
  /** Visible text streamed since the last boundary. */
  raw: string;
  /** How much of `raw` has already been spoken live. */
  spoken: number;
  /** A `<` or `{` has streamed, so tool-call markup is possible. */
  mayHoldMarkup: boolean;
  /** Markup already split off; `raw` is the call until the next boundary. */
  inMarkup: boolean;
  /** The newest completed message's unspoken words, spoken at `done` unless superseded. */
  reply?: Taken;
  spokeProgress: boolean;
}

function freshWindow(turnKey: string, speaker: NarrationSpeaker): SessionWindow {
  return {
    turnKey,
    speaker,
    index: 0,
    raw: '',
    spoken: 0,
    scanned: 0,
    inFence: false,
    mayHoldMarkup: false,
    inMarkup: false,
    spokeProgress: false,
  };
}

/**
 * Turns one timeline's chat events into things worth saying. One per
 * mounted timeline, because the text windows it keeps are built from that
 * timeline's own event stream; the {@link NarrationQueue} they feed is
 * shared.
 *
 * A turn's visible text is cut into windows at every boundary — a tool
 * call starting (`tool_args_delta`, or markup in the text stream), a tool
 * finishing, the model going back to thinking. In `progress` mode every
 * window is spoken a sentence at a time as it streams, so the voice starts
 * with the first finished sentence rather than the finished turn. In
 * `replies` mode only the text after the last boundary is spoken, at `done`,
 * because until then nothing says which window is the reply. The reply is
 * not the message's `content`: a local provider's content is every window of
 * the turn concatenated with its tool-call markup, and an artifact-checkpoint
 * step's content is a fixed line the gezel never said.
 */
export class ChatNarrationTracker {
  private readonly sessions = new Map<string, SessionWindow>();

  constructor(
    private readonly opts: {
      mode: () => ChatNarrationMode;
      speak: (request: NarrationRequest) => void;
    },
  ) {}

  /** A user message opened a turn. Re-publishing the same message is a no-op. */
  beginTurn(sessionId: string, turnKey: string, speaker: NarrationSpeaker): void {
    if (this.sessions.get(sessionId)?.turnKey === turnKey) return;
    this.sessions.set(sessionId, freshWindow(turnKey, speaker));
  }

  /** A visible text delta. */
  text(sessionId: string, content: string, speaker: NarrationSpeaker): void {
    const w = this.window(sessionId, speaker);
    w.raw += content;
    if (w.inMarkup) return;
    w.mayHoldMarkup ||= /[<{]/.test(content);
    if (w.mayHoldMarkup) {
      const start = toolMarkupStart(w.raw);
      if (start !== -1) {
        // The markup is a boundary of its own: the prose before it is done.
        const prose: Taken = {
          text: w.raw.slice(w.spoken, start),
          window: w.index,
          start: w.spoken,
        };
        w.raw = w.raw.slice(start);
        w.index += 1;
        w.spoken = 0;
        w.scanned = 0;
        w.inFence = false;
        w.inMarkup = true;
        this.flushProgress(sessionId, w, prose);
        return;
      }
    }
    if (this.opts.mode() !== 'progress') return;
    // More words after a completed message: the turn went on, so what it
    // ended on was an update, and it is said before these.
    if (w.reply) {
      this.emit(sessionId, w, 'progress', w.reply);
      w.reply = undefined;
    }
    for (let cut = nextLiveCut(w.raw, w); cut !== -1; cut = nextLiveCut(w.raw, w)) {
      const piece: Taken = {
        text: speakableMessageText(w.raw.slice(w.spoken, cut)),
        window: w.index,
        start: w.spoken,
      };
      w.spoken = cut;
      if (piece.text) this.emit(sessionId, w, 'progress', piece);
    }
  }

  /** The model moved on from the text it was writing: a tool call, a tool result, or thinking. */
  boundary(sessionId: string, speaker: NarrationSpeaker): void {
    const w = this.window(sessionId, speaker);
    this.flushProgress(sessionId, w, this.takeWindow(w));
  }

  /** One iteration of the turn committed a message. */
  complete(sessionId: string, content: string, speaker: NarrationSpeaker): void {
    const w = this.window(sessionId, speaker);
    const taken = this.takeWindow(w);
    const trailing = speakableMessageText(taken.text);
    const progress = this.opts.mode() === 'progress';
    if (progress && w.reply) {
      this.emit(sessionId, w, 'progress', w.reply);
      w.reply = undefined;
    }
    if (trailing) {
      w.reply = { ...taken, text: trailing };
      return;
    }
    // Nothing streamed (a provider that does not stream) → the committed
    // content is all there is. Once anything was spoken, it is only a
    // repeat of that.
    if (progress && w.spokeProgress) return;
    const whole = speakableMessageText(content);
    if (whole) w.reply = { text: whole, window: taken.window, start: -1 };
  }

  /** The turn is over: speak what is left of its reply. */
  finish(sessionId: string): void {
    const w = this.sessions.get(sessionId);
    if (!w) return;
    this.sessions.delete(sessionId);
    if (this.opts.mode() === 'off') return;
    const reply = w.reply ?? {
      text: speakableMessageText(w.raw.slice(w.spoken)),
      window: w.index,
      start: w.spoken,
    };
    if (reply.text) this.emit(sessionId, w, 'reply', reply);
  }

  /** Drop a session's turn without speaking it (cancelled, or gone stale). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * The event stream (re)connected, and the bus is about to replay every
   * in-flight turn from its start. Windows built so far would double up
   * with the replay; turn keys stay so the replayed user message is still
   * recognised as the same turn, and the replay rebuilds the same keys, so
   * nothing already said is said again.
   */
  resetWindows(): void {
    for (const [sessionId, w] of this.sessions) {
      this.sessions.set(sessionId, freshWindow(w.turnKey, w.speaker));
    }
  }

  private window(sessionId: string, speaker: NarrationSpeaker): SessionWindow {
    let w = this.sessions.get(sessionId);
    if (!w) {
      w = freshWindow('', speaker);
      this.sessions.set(sessionId, w);
    }
    w.speaker = speaker;
    return w;
  }

  /** The window's unspoken text, and a fresh window after it. */
  private takeWindow(w: SessionWindow): Taken {
    const taken: Taken = { text: w.raw.slice(w.spoken), window: w.index, start: w.spoken };
    // Only a window that held text advances the count, so a burst of
    // boundaries (every reasoning delta is one) numbers windows the same way
    // on a replay however the bus happens to batch it.
    if (w.raw.length > 0) w.index += 1;
    w.raw = '';
    w.spoken = 0;
    w.scanned = 0;
    w.inFence = false;
    w.mayHoldMarkup = false;
    w.inMarkup = false;
    return taken;
  }

  private flushProgress(sessionId: string, w: SessionWindow, taken: Taken): void {
    if (this.opts.mode() !== 'progress') return;
    // A reply followed by more work was an update after all.
    if (w.reply) {
      this.emit(sessionId, w, 'progress', w.reply);
      w.reply = undefined;
    }
    const text = speakableMessageText(taken.text);
    if (text) this.emit(sessionId, w, 'progress', { ...taken, text });
  }

  private emit(
    sessionId: string,
    w: SessionWindow,
    kind: NarrationRequest['kind'],
    taken: Taken,
  ): void {
    if (kind === 'progress') w.spokeProgress = true;
    this.opts.speak({
      key: [sessionId, w.turnKey, taken.window, taken.start, taken.text].join('\n'),
      sessionId,
      turnKey: w.turnKey,
      window: taken.window,
      kind,
      text: taken.text,
      ...w.speaker,
    });
  }
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
  private synthesis: { ctrl: AbortController; sessionId: string; windowId: string } | null = null;
  private playback: { ctrl: AbortController; sessionId: string; windowId: string } | null = null;
  private synthesizing = false;
  private playing = false;
  private holders = 0;

  constructor(
    private readonly player: NarrationPlayer,
    private readonly now: () => number = Date.now,
  ) {}

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
    if (this.dropped.has(windowId)) return;
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
  }

  /** Silence now: cut the current utterance and drop everything waiting. */
  stop(): void {
    this.waiting = [];
    this.clips = [];
    this.synthesis?.ctrl.abort();
    this.synthesis = null;
    this.playback?.ctrl.abort();
    this.playback = null;
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
