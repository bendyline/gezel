import { handoffPreviewLine } from '@bendyline/gezel';
import { parsePendingToolCalls } from './pending-tool-calls.js';
import { stripVisibleToolCallMarkup } from './strip-tool-call-markup.js';
import { isKnownTool, toolActivityPhrase } from './tool-display.js';

/**
 * One-line, human-readable stand-in for the last thing that happened in a
 * thread — the context line under a chat pill, a task card, any glanceable
 * summary built from a message body.
 *
 * A raw message body is not prose. It is markdown; it can be reasoning the
 * bubble hides; and when the service-side salvage layer fails to promote a
 * call (see [strip-tool-call-markup](./strip-tool-call-markup.ts) for why
 * that happens and why the transcript keeps the evidence), it is literal
 * tool-call markup. Rendering that verbatim is how a hand-off card came to
 * read `Sumarni, Si… · <toolcall <function=search…` — angle-bracket
 * protocol syntax in a headline, and the sharpest break of the app's plain
 * shop talk anywhere in the product.
 *
 * Two rules, in this order:
 *
 * 1. **Prose wins.** If the gezel said anything at all, that is the
 *    preview; the markup around it is scrubbed.
 * 2. **Otherwise translate, don't hide.** A tool call becomes
 *    "Searching across files…". Scrubbing markup to an empty line would be
 *    just as clean and would tell the reader nothing about a thread that
 *    did, in fact, do something.
 *
 * Display-only, like every scrub in this layer: the stored transcript keeps
 * what the model actually emitted.
 */

/**
 * Tool-name extractors that tolerate a cut mid-tag. The summary this runs
 * on is bounded (200 characters, cut server-side in `Store.listSessions`),
 * so the closing `>` that {@link parsePendingToolCalls} anchors on is often
 * past the end.
 */
const TRUNCATED_TOOL_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /<function=([a-zA-Z_][a-zA-Z0-9_]*)/,
  /<invoke\s+name="([a-zA-Z_][a-zA-Z0-9_]*)/,
  /"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/,
];

/** Tool-call markup we recognize even when no name survives the cut. */
const TOOL_MARKUP_HINT =
  /<function[=\s>]|<tool_call>|<invoke[\s>]|<parameter[=\s]|<\|tool_call\|>/i;

/** Reasoning channels — hidden in the bubble, still worth naming here. */
const REASONING_HINT = /<\/?think>|<\|?channel\|?>|(?:^|\n)(?:thought|analysis|commentary)\|/i;

/** Markdown image, the one attachment shape that flattens to nothing. */
const IMAGE_MARKDOWN = /!\[[^\]]*\]\(/;

/**
 * A `<think>` with no matching close. The shared scrub drops the tag but
 * keeps the body — a persisted bubble should show what the model actually
 * left behind. A one-line summary is not that place: reasoning presented as
 * the gezel's own words is worse than saying it was thinking.
 */
const UNCLOSED_REASONING = /<think>(?![\s\S]*<\/think>)/i;

/** Opener of the one tool-call dialect written in JSON rather than tags. */
const JSON_ENVELOPE_OPEN = /\{\s*"(?:tool|name|function)"\s*:\s*"[a-zA-Z_][a-zA-Z0-9_]*"/g;

/**
 * Remove `{"name": "read_file", "arguments": {…}}` envelopes.
 *
 * Every other dialect is angle-bracket markup that
 * {@link stripVisibleToolCallMarkup} already knows; this one is ordinary
 * JSON, so it survives the scrub and then reads as prose. Brace-matched
 * rather than regex-matched because the arguments nest, and string-aware
 * because a `}` inside an argument value is not the end of the envelope.
 */
function stripJsonToolEnvelopes(text: string): string {
  if (!text.includes('{')) return text;
  let out = '';
  let cursor = 0;
  JSON_ENVELOPE_OPEN.lastIndex = 0;
  for (let match = JSON_ENVELOPE_OPEN.exec(text); match; match = JSON_ENVELOPE_OPEN.exec(text)) {
    if (match.index < cursor) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\' && inString) {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString && ch === '{') {
        depth++;
      } else if (!inString && ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    // An unterminated envelope runs to the end of the text — it was cut by
    // the preview bound, and none of the remainder is prose either.
    out += text.slice(cursor, match.index);
    cursor = end === -1 ? text.length : end;
    JSON_ENVELOPE_OPEN.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * Flatten markdown to the words someone would read aloud: images and links
 * to their text, mentions to `@Label`, emphasis and heading marks dropped,
 * whitespace collapsed to a single line.
 */
function flattenMessageMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `trusted` means the name is whole: every parser anchors on a closed
 * opening tag, so it read the name to its end even when the call was still
 * streaming arguments. A name recovered from {@link
 * TRUNCATED_TOOL_NAME_PATTERNS} may have been cut mid-slug — `grep_fi` for
 * `grep_files` — and is only safe to phrase if it matches a tool we know.
 */
function firstToolCall(text: string): { name: string; trusted: boolean } | null {
  const parsed = parsePendingToolCalls(text);
  if (parsed.length > 0) return { name: parsed[0]!.name, trusted: true };
  for (const pattern of TRUNCATED_TOOL_NAME_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return { name: match[1], trusted: false };
  }
  return null;
}

/**
 * Turn a raw message body into one line of plain language. Returns an empty
 * string only when there was nothing to say at all — callers own the
 * "no messages yet" wording, which depends on their surface.
 *
 * The scrub runs *before* the markdown flatten, and the order is
 * load-bearing: flattening first strips the `_` and `>` out of
 * `<tool_call>`, leaving `<toolcall` — unrecognizable to every parser here
 * and to the reader alike.
 */
export function humanMessagePreview(raw: string): string {
  if (!raw) return '';
  // A task dispatch seed is procedure addressed to the model — as a context
  // line it is four sentences of `advance_task_step` boilerplate where the
  // reader wanted "Liesel passed on the review step." The transcript renders
  // the same fact as a hand-off card.
  const handoff = handoffPreviewLine(raw);
  if (handoff) return handoff;
  const reasoningAt = raw.search(UNCLOSED_REASONING);
  const visible = reasoningAt === -1 ? raw : raw.slice(0, reasoningAt);
  // `hideMidStreamOpener` because a bounded preview is nearly always cut
  // before the close arrives, and an unclosed opener is exactly the leak.
  const prose = flattenMessageMarkdown(
    stripJsonToolEnvelopes(stripVisibleToolCallMarkup(visible, { hideMidStreamOpener: true })),
  );
  if (prose) return prose;
  const tool = firstToolCall(visible);
  if (tool && (tool.trusted || isKnownTool(tool.name))) {
    return `${toolActivityPhrase(tool.name)}…`;
  }
  // Hints read `visible`, not `raw`: markup a model only *talked about*
  // inside an open reasoning block was never a call, and the honest summary
  // of that message is that the gezel was thinking.
  if (tool || TOOL_MARKUP_HINT.test(visible)) return 'Using a tool…';
  if (REASONING_HINT.test(raw)) return 'Thinking…';
  if (IMAGE_MARKDOWN.test(visible)) return 'Shared an image';
  return '';
}
