import { api } from '../api.js';
import { speakableMessageText } from './message-preview.js';
import { parsePendingToolCalls } from './pending-tool-calls.js';

/**
 * Hard cap on the characters fed to kokoro per utterance. Long replies +
 * CPU contention from the LLM cascade (Meester → Voorman → Developer
 * handoffs each fire a fresh 16K-token prompt) starve the kokoro
 * inference on the main thread; a 30+ second synth just feels broken.
 * The full text is on screen anyway — narration is meant to be a
 * gist read, not the whole novel.
 */
const NARRATION_MAX_CHARS = 280;

/**
 * Progress updates waiting to be spoken, beyond the one playing. A gezel in
 * a fast tool loop says "Now I'll…" faster than a voice can read it; past
 * this the oldest waiting update is dropped rather than read minutes late.
 */
const MAX_WAITING_PROGRESS = 2;

/** A progress update that waited this long is no longer news. */
const PROGRESS_STALE_MS = 45_000;

/** Bound on remembered utterance keys and turn keys. */
const MEMORY_CAP = 500;

/**
 * - `off` — silent.
 * - `replies` — the reply a gezel ends its turn with.
 * - `progress` — that, plus the short updates it gives between tool calls.
 */
export type ChatNarrationMode = 'off' | 'replies' | 'progress';

export interface NarrationSpeaker {
  gezelId: string;
  projectId: string;
}

export interface NarrationRequest extends NarrationSpeaker {
  /**
   * The same words in the same turn of the same session. The chat event bus
   * replays an in-flight turn to every subscriber that (re)connects, and
   * more than one timeline can be mounted at once, so every utterance
   * arrives more than once; the key is what makes it speak once.
   */
  key: string;
  kind: 'progress' | 'reply';
  text: string;
}

/**
 * Truncate text at the closest sentence-end boundary at or before
 * {@link NARRATION_MAX_CHARS}. Falls back to a hard char cut when no
 * sentence boundary lands in range so we don't speak a 4-token blurt.
 */
function truncateForNarration(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NARRATION_MAX_CHARS) return trimmed;
  const slice = trimmed.slice(0, NARRATION_MAX_CHARS);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (sentenceEnd >= NARRATION_MAX_CHARS / 2) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  return `${slice.trim()}…`;
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

interface SessionWindow {
  turnKey: string;
  speaker: NarrationSpeaker;
  /** Visible text streamed since the last boundary. */
  raw: string;
  /** A `<` or `{` has streamed, so tool-call markup is possible. */
  mayHoldMarkup: boolean;
  /** Markup already split off; `raw` is the call until the next boundary. */
  inMarkup: boolean;
  /** The newest completed message, spoken at `done` unless superseded. */
  reply?: string;
  spokeProgress: boolean;
}

function freshWindow(turnKey: string, speaker: NarrationSpeaker): SessionWindow {
  return {
    turnKey,
    speaker,
    raw: '',
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
 * finishing, the model going back to thinking. Text before a boundary is a
 * progress update; the text after the last one is the reply, spoken at
 * `done`. The reply is not the message's `content`: a local provider's
 * content is every window of the turn concatenated with its tool-call
 * markup, and an artifact-checkpoint step's content is a fixed line the
 * gezel never said.
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
    if (!w.mayHoldMarkup) return;
    const start = toolMarkupStart(w.raw);
    if (start === -1) return;
    const prose = w.raw.slice(0, start);
    w.raw = w.raw.slice(start);
    w.inMarkup = true;
    this.flushProgress(sessionId, w, prose);
  }

  /** The model moved on from the text it was writing: a tool call, a tool result, or thinking. */
  boundary(sessionId: string, speaker: NarrationSpeaker): void {
    const w = this.window(sessionId, speaker);
    const prose = this.takeWindow(w);
    this.flushProgress(sessionId, w, prose);
  }

  /** One iteration of the turn committed a message. */
  complete(sessionId: string, content: string, speaker: NarrationSpeaker): void {
    const w = this.window(sessionId, speaker);
    const trailing = speakableMessageText(this.takeWindow(w));
    const progress = this.opts.mode() === 'progress';
    if (progress && w.reply) {
      this.emit(sessionId, w, 'progress', w.reply);
      w.reply = undefined;
    }
    // Nothing streamed (a provider that does not stream) → the committed
    // content is all there is. Once updates were spoken, it is only a
    // repeat of them.
    const reply = trailing || (progress && w.spokeProgress ? '' : speakableMessageText(content));
    if (reply) w.reply = reply;
  }

  /** The turn is over: speak its reply. */
  finish(sessionId: string): void {
    const w = this.sessions.get(sessionId);
    if (!w) return;
    this.sessions.delete(sessionId);
    if (this.opts.mode() === 'off') return;
    const reply = w.reply ?? speakableMessageText(w.raw);
    if (reply) this.emit(sessionId, w, 'reply', reply);
  }

  /** Drop a session's turn without speaking it (cancelled, or gone stale). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * The event stream (re)connected, and the bus is about to replay every
   * in-flight turn from its start. Windows built so far would double up
   * with the replay; turn keys stay so the replayed user message is still
   * recognised as the same turn.
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

  private takeWindow(w: SessionWindow): string {
    const raw = w.raw;
    w.raw = '';
    w.mayHoldMarkup = false;
    w.inMarkup = false;
    return raw;
  }

  private flushProgress(sessionId: string, w: SessionWindow, prose: string): void {
    if (this.opts.mode() !== 'progress') return;
    // A reply followed by more work was an update after all.
    if (w.reply) {
      this.emit(sessionId, w, 'progress', w.reply);
      w.reply = undefined;
    }
    const text = speakableMessageText(prose);
    if (text) this.emit(sessionId, w, 'progress', text);
  }

  private emit(
    sessionId: string,
    w: SessionWindow,
    kind: NarrationRequest['kind'],
    text: string,
  ): void {
    if (kind === 'progress') w.spokeProgress = true;
    this.opts.speak({
      key: `${sessionId}\n${w.turnKey}\n${text}`,
      kind,
      text,
      ...w.speaker,
    });
  }
}

/** How the queue turns a request into sound. Injected for tests. */
export interface NarrationPlayer {
  /** Base64 WAV for the request, or undefined when there is nothing to play. */
  synthesize(request: NarrationRequest, signal: AbortSignal): Promise<string | undefined>;
  /** Resolves when playback ends, fails, or `signal` aborts it. */
  play(b64Wav: string, signal: AbortSignal): Promise<void>;
}

interface WaitingRequest extends NarrationRequest {
  queuedAt: number;
}

function rememberBounded<T>(set: Set<T>, value: T): void {
  set.add(value);
  if (set.size <= MEMORY_CAP) return;
  const oldest = set.values().next();
  if (!oldest.done) set.delete(oldest.value);
}

/**
 * Speaks narration one utterance at a time, in order. Shared by every
 * mounted timeline so two views of the same session neither talk over each
 * other nor say the same thing twice.
 */
export class NarrationQueue {
  private waiting: WaitingRequest[] = [];
  private readonly spoken = new Set<string>();
  private readonly turns = new Set<string>();
  private current: AbortController | null = null;
  private running = false;
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
    if (request.kind === 'progress') {
      const waitingProgress = this.waiting.filter((r) => r.kind === 'progress');
      if (waitingProgress.length >= MAX_WAITING_PROGRESS) {
        this.waiting.splice(this.waiting.indexOf(waitingProgress[0]!), 1);
      }
    }
    this.waiting.push({ ...request, queuedAt: this.now() });
    void this.pump();
  }

  /** Silence now: cut the current utterance and drop everything waiting. */
  stop(): void {
    this.waiting = [];
    this.current?.abort();
    this.current = null;
  }

  private take(): WaitingRequest | undefined {
    for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
      if (next.kind === 'progress' && this.now() - next.queuedAt > PROGRESS_STALE_MS) continue;
      return next;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.take(); next; next = this.take()) {
        const ctrl = new AbortController();
        this.current = ctrl;
        try {
          console.debug(`[narrate] synth ${next.kind} chars=${next.text.length}`);
          const wav = await this.player.synthesize(next, ctrl.signal);
          if (wav && !ctrl.signal.aborted) await this.player.play(wav, ctrl.signal);
        } catch (err) {
          if (!ctrl.signal.aborted) console.warn('[narrate] failed:', err);
        } finally {
          if (this.current === ctrl) this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
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
 * gezel's frontmatter when we pass `gezelId`.
 */
export const chatNarrationQueue = new NarrationQueue({
  async synthesize(request, signal) {
    const res = await api.synthesizeSpeech({
      text: truncateForNarration(request.text),
      gezelId: request.gezelId,
      projectId: request.projectId,
      inline: true,
      signal,
    });
    return res.b64Wav || undefined;
  },
  play: playWav,
});
