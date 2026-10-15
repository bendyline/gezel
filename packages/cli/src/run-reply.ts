/**
 * The reply `gezel run` prints, streamed without the tool-call markup a local
 * model can write into its visible text. The service salvages that markup into
 * real calls and commits a clean message, but the live deltas arrive first, and
 * stdout is the command's result channel: a 0.8B Qwen answering "name the
 * capital" printed a fifteen-line `<tool_call>` block before "Amsterdam".
 *
 * Mirrors the live-bubble scrub in the app (packages/ui strip-tool-call-markup)
 * for the shapes local models actually stream. Text already written cannot be
 * taken back, so a call still in flight is withheld until it closes.
 */

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';

/** Closed calls, outer wrappers first so an inner block cannot leave a shell. */
const CLOSED_CALLS: readonly RegExp[] = [
  /<tool_call>[\s\S]*?<\/tool_call\s*>/gi,
  /<function_calls>[\s\S]*?<\/function_calls\s*>/gi,
  new RegExp(`<function=${NAME}\\s*>[\\s\\S]*?<\\/function\\s*>`, 'gi'),
  new RegExp(`<invoke\\s+name="${NAME}"\\s*>[\\s\\S]*?<\\/invoke\\s*>`, 'gi'),
  /<\|tool_call\|?>[\s\S]*?<\/?\|?tool_call\|?>/gi,
];

/** A call that has opened and not yet closed: everything from it on is withheld. */
const OPEN_CALL = new RegExp(
  `<tool_call>|<function_calls>|<function=${NAME}\\s*>|<invoke\\s+name=|<\\|tool_call\\|?>`,
  'i',
);

/** Any prefix of `literal`, the empty one included, as regex source. */
function prefixOf(literal: string): string {
  return [...literal].reduceRight(
    (rest, ch) => `(?:${ch.replace(/[|\\^$.*+?()[\]{}]/g, '\\$&')}${rest})?`,
    '',
  );
}

/**
 * A trailing tag that may still complete an OPEN_CALL opener (or a closer):
 * `<`, `</fun`, `<invoke name`, `<function=read_file2`. Printing one early
 * cannot be taken back once the call closes and is cut out.
 */
const PARTIAL_TAG = new RegExp(
  `^<(?:/?(?:${['tool_call', 'function_calls', 'invoke', '|tool_call|'].map(prefixOf).join('|')})` +
    `|function=(?:${NAME}\\s*)?|invoke\\s+${prefixOf('name')})$`,
  'i',
);

/**
 * Longer than any real opener still arriving; past it the tail is text, so
 * something like an endless `<function=aaaa` is not held back for good.
 */
const MAX_PARTIAL_TAG = 128;

function withoutPartialTag(text: string): string {
  const at = text.lastIndexOf('<');
  if (at < 0 || text.length - at > MAX_PARTIAL_TAG) return text;
  return PARTIAL_TAG.test(text.slice(at)) ? text.slice(0, at) : text;
}

/** Where a call was removed, so the blank lines around it can close up. */
const CUT = '\uE000';

/**
 * The part of `raw` that is reply; `streaming` also withholds what is still
 * arriving. Whitespace is only touched where a call was cut out, at the start,
 * and (while streaming) at the end, since printed text cannot be taken back.
 */
export function visibleReply(raw: string, streaming: boolean): string {
  let out = raw;
  for (const pattern of CLOSED_CALLS) out = out.replace(pattern, CUT);
  if (streaming) {
    const open = OPEN_CALL.exec(out);
    if (open) out = out.slice(0, open.index);
    out = withoutPartialTag(out);
  }
  out = out
    .replace(/^\s*(?:\uE000\s*)+/, '')
    .replace(/\s*(?:\uE000\s*)+$/, '')
    .replace(/\s*(?:\uE000\s*)+/g, '\n\n')
    .replace(/^\s+/, '');
  return streaming ? out.replace(/\s+$/, '') : out;
}

/**
 * Where to pick `visible` up again after the screen parted from it: the first
 * character they disagree on, moved back to the start of a word that straddles
 * it so no half word is left behind.
 */
function rejoinPoint(shown: string, visible: string): number {
  let at = 0;
  while (at < shown.length && at < visible.length && shown[at] === visible[at]) at++;
  const isText = (ch: string | undefined) => ch !== undefined && /\S/.test(ch);
  if (isText(visible[at - 1]) && (isText(visible[at]) || isText(shown[at]))) {
    while (at > 0 && isText(visible[at - 1])) at--;
  }
  return at;
}

export class ReplyPrinter {
  private raw = '';
  private printed = '';

  constructor(private readonly write: (text: string) => void) {}

  push(chunk: string): void {
    this.raw += chunk;
    // A view that no longer extends the screen waits for finish(): while the
    // reply is still arriving it is provisional, and a rejoin is printed once.
    this.extend(visibleReply(this.raw, true));
  }

  /**
   * End of the reply. `committed` is the saved message, printed when the
   * stream carried no visible text (providers that send it whole). Returns
   * whether anything was printed.
   */
  finish(committed?: string): boolean {
    let visible = visibleReply(this.raw, false);
    if (!visible && committed) visible = visibleReply(committed, false);
    if (!this.extend(visible) && !this.printed.startsWith(visible)) this.rejoin(visible);
    return this.printed.length > 0;
  }

  /** Prints what `visible` adds to the screen; false when it does not extend it. */
  private extend(visible: string): boolean {
    if (!visible.startsWith(this.printed)) return false;
    if (visible.length > this.printed.length) {
      this.write(visible.slice(this.printed.length));
      this.printed = visible;
    }
    return true;
  }

  /**
   * The screen holds text the reply no longer has: a tag printed before it
   * completed into a call. It cannot be taken back, so the rest of the reply
   * goes on a line of its own rather than being dropped.
   */
  private rejoin(visible: string): void {
    const rest = visible.slice(rejoinPoint(this.printed, visible)).replace(/^\s+/, '');
    if (rest) this.write(`${this.printed.endsWith('\n') ? '' : '\n'}${rest}`);
    this.printed = visible;
  }
}
