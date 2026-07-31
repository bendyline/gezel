import { type ReactNode, useMemo } from 'react';

/**
 * ANSI escape → React-node renderer.
 *
 * Handles the slice of VT100/xterm escape sequences that actually
 * shows up in dev-tool output: CSI SGR (color + bold/italic/etc.),
 * with non-SGR CSI (cursor moves, line erases), OSC (title/clipboard),
 * and standalone ESC sequences silently consumed and dropped.
 * Cursor-positioning sequences make no sense in a static bubble,
 * and dropping them is friendlier than rendering the raw escape
 * codes (which is what we did before this component existed).
 *
 * 8-bit (256-color, `38;5;n`) and 24-bit (`38;2;r;g;b`) extended-
 * color sequences are RECOGNIZED in the SGR parameter stream
 * (parameters consumed correctly so we don't leak text after
 * them) but NOT applied — they fall through as the current style.
 * Most dev-tool colors are the 16 standard ANSI colors, which we
 * handle; extended colors land as plain text on the bubble's
 * default foreground.
 *
 * Stateful by design: `createAnsiRenderer()` returns a feed-style
 * renderer that buffers partial escape sequences across calls.
 * This matters for Phase 2b's streaming bubble — a single PTY
 * chunk can split `\x1b[31` from the closing `m` and we don't want
 * to flush the partial as literal text. The `<AnsiOutput>`
 * convenience component is for batched-output bubbles: it spins
 * up a one-shot renderer per `text` change and renders the
 * complete sequence.
 */

const COLOR_NAMES: readonly string[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
];

interface AnsiState {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
  hidden: boolean;
}

function initialState(): AnsiState {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
    hidden: false,
  };
}

function stateClasses(state: AnsiState): string {
  const out: string[] = [];
  // Reverse video swaps fg/bg in real terminals. Approximate by
  // swapping the named colors we'd emit; defaults stay null so the
  // CSS rule for .ansi-reverse can apply a generic invert-look.
  const fg = state.reverse ? state.bg : state.fg;
  const bg = state.reverse ? state.fg : state.bg;
  if (fg !== null) out.push(`ansi-fg-${COLOR_NAMES[fg]}`);
  if (bg !== null) out.push(`ansi-bg-${COLOR_NAMES[bg]}`);
  if (state.bold) out.push('ansi-bold');
  if (state.dim) out.push('ansi-dim');
  if (state.italic) out.push('ansi-italic');
  if (state.underline) out.push('ansi-underline');
  if (state.reverse) out.push('ansi-reverse');
  if (state.hidden) out.push('ansi-hidden');
  return out.join(' ');
}

interface ConsumedEscape {
  end: number;
  sgrParams?: number[];
}

/**
 * Returns the position right after the escape sequence starting at
 * `start`, plus the SGR parameters if the sequence is a CSI SGR
 * (`ESC [ ... m`). Returns `null` if the sequence is incomplete
 * (caller must buffer the tail). Assumes `input.charCodeAt(start)
 * === 0x1b`.
 */
function consumeEscape(input: string, start: number): ConsumedEscape | null {
  if (start + 1 >= input.length) return null;
  const next = input[start + 1]!;

  if (next === '[') {
    // CSI: `ESC [ <params (0x30-0x3F)> <intermediates (0x20-0x2F)> <final (0x40-0x7E)>`
    let i = start + 2;
    while (i < input.length) {
      const c = input.charCodeAt(i);
      if (c >= 0x30 && c <= 0x3f) {
        i++;
      } else break;
    }
    while (i < input.length) {
      const c = input.charCodeAt(i);
      if (c >= 0x20 && c <= 0x2f) {
        i++;
      } else break;
    }
    if (i >= input.length) return null;
    const finalCode = input.charCodeAt(i);
    if (finalCode < 0x40 || finalCode > 0x7e) {
      // Malformed (e.g. control char in the middle of a sequence).
      // Drop just the ESC and let the next pass treat the rest as
      // plain text — avoids losing the whole tail.
      return { end: start + 1 };
    }
    if (input[i] === 'm') {
      const paramsStr = input.slice(start + 2, i);
      const params =
        paramsStr === ''
          ? [0]
          : paramsStr.split(';').map((p) => {
              const n = Number.parseInt(p, 10);
              return Number.isFinite(n) ? n : 0;
            });
      return { end: i + 1, sgrParams: params };
    }
    // Non-SGR CSI (cursor moves, erases, etc.) — consume + drop.
    return { end: i + 1 };
  }

  if (next === ']') {
    // OSC: `ESC ] <payload> (BEL | ESC \)`
    let i = start + 2;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === '\x07') return { end: i + 1 };
      if (ch === '\x1b' && i + 1 < input.length && input[i + 1] === '\\') {
        return { end: i + 2 };
      }
      i++;
    }
    return null; // payload incomplete
  }

  // Standalone two-byte escape (e.g., `ESC =` to enter application keypad mode).
  return { end: start + 2 };
}

function applySGR(state: AnsiState, params: number[]): AnsiState {
  const next = { ...state };
  let i = 0;
  while (i < params.length) {
    const p = params[i]!;
    if (p === 0) {
      next.fg = null;
      next.bg = null;
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
      next.reverse = false;
      next.hidden = false;
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.reverse = true;
    else if (p === 8) next.hidden = true;
    else if (p === 22) {
      next.bold = false;
      next.dim = false;
    } else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 27) next.reverse = false;
    else if (p === 28) next.hidden = false;
    else if (p >= 30 && p <= 37) next.fg = p - 30;
    else if (p === 38) {
      // Extended-color form: 38;5;n (256-color) or 38;2;r;g;b (24-bit).
      // Consume the parameters so subsequent codes parse correctly,
      // but skip applying — v1 only models the 16 named colors.
      if (params[i + 1] === 5) i += 2;
      else if (params[i + 1] === 2) i += 4;
    } else if (p === 39) next.fg = null;
    else if (p >= 40 && p <= 47) next.bg = p - 40;
    else if (p === 48) {
      if (params[i + 1] === 5) i += 2;
      else if (params[i + 1] === 2) i += 4;
    } else if (p === 49) next.bg = null;
    else if (p >= 90 && p <= 97) next.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) next.bg = p - 100 + 8;
    // Unknown SGR codes silently ignored.
    i++;
  }
  return next;
}

export interface AnsiRenderer {
  /** Process more text; returns React nodes for the consumed prefix. */
  feed(text: string): ReactNode[];
}

export function createAnsiRenderer(renderText?: (text: string) => ReactNode): AnsiRenderer {
  let state = initialState();
  let partial = '';
  let key = 0;

  return {
    feed(text: string): ReactNode[] {
      const input = partial + text;
      partial = '';
      const out: ReactNode[] = [];
      let i = 0;
      let plainStart = 0;

      const flushPlain = (end: number) => {
        if (end <= plainStart) return;
        const slice = input.slice(plainStart, end);
        if (slice === '') return;
        const content = renderText ? renderText(slice) : slice;
        const className = stateClasses(state);
        if (className === '') {
          out.push(content);
        } else {
          out.push(
            <span key={key++} className={className}>
              {content}
            </span>,
          );
        }
      };

      while (i < input.length) {
        if (input.charCodeAt(i) !== 0x1b) {
          i++;
          continue;
        }
        const consumed = consumeEscape(input, i);
        if (consumed === null) {
          // Partial sequence — flush plain up to here, buffer the rest.
          flushPlain(i);
          partial = input.slice(i);
          return out;
        }
        flushPlain(i);
        if (consumed.sgrParams) {
          state = applySGR(state, consumed.sgrParams);
        }
        i = consumed.end;
        plainStart = i;
      }
      flushPlain(input.length);
      return out;
    },
  };
}

/**
 * Render an ANSI-bearing string into colored React nodes. Use for
 * complete (batched) text; for streaming output where escape
 * sequences may split across chunks, instantiate
 * `createAnsiRenderer()` directly so its partial-sequence buffer
 * survives chunk boundaries.
 */
export function AnsiOutput({
  text,
  renderText,
}: {
  text: string;
  /** Optional renderer for plain-text runs after ANSI escapes are removed. */
  renderText?: (text: string) => ReactNode;
}) {
  const nodes = useMemo(() => createAnsiRenderer(renderText).feed(text), [text, renderText]);
  return <>{nodes}</>;
}
