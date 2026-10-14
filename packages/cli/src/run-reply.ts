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

const TAG_NAMES = [
  'tool_call',
  'function_calls',
  'function',
  'invoke',
  '|tool_call',
  '|tool_call|',
];

/** A trailing `<`, `</fun`, `<tool_c` that may still become a call tag. */
function withoutPartialTag(text: string): string {
  const m = /<\/?([a-z_|=]*)$/i.exec(text);
  if (!m) return text;
  const name = m[1]!.toLowerCase().split('=')[0]!;
  return TAG_NAMES.some((tag) => tag.startsWith(name)) ? text.slice(0, m.index) : text;
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

export class ReplyPrinter {
  private raw = '';
  private printed = '';

  constructor(private readonly write: (text: string) => void) {}

  push(chunk: string): void {
    this.raw += chunk;
    this.emit(visibleReply(this.raw, true));
  }

  /** End of the reply. Returns whether anything was printed. */
  finish(): boolean {
    this.emit(visibleReply(this.raw, false));
    return this.printed.length > 0;
  }

  private emit(visible: string): void {
    // Only ever extend what is on screen; a shorter or different view (a
    // closer completing a pair) waits until the text grows past it again.
    if (visible.length <= this.printed.length || !visible.startsWith(this.printed)) return;
    this.write(visible.slice(this.printed.length));
    this.printed = visible;
  }
}
