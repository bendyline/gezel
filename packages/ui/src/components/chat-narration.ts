import { speakableMessageText } from './message-preview.js';
import type { NarrationRequest, NarrationSpeaker } from './narration-queue.js';
import { parsePendingToolCalls } from './pending-tool-calls.js';

export {
  NarrationQueue,
  chatNarrationQueue,
  type NarrationPlayer,
  type NarrationRequest,
  type NarrationSpeaker,
} from './narration-queue.js';

/**
 * - `off` — silent.
 * - `replies` — the reply a gezel ends its turn with, once the turn is done.
 * - `progress` — everything the gezel says, a sentence at a time as it
 *   streams: the short updates between tool calls, and the reply.
 */
export type ChatNarrationMode = 'off' | 'replies' | 'progress';

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
