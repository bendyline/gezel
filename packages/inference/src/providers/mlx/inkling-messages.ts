import { readChatTemplate } from './reasoning-stream.js';

/**
 * Inkling 2's output format, translated into shapes the MLX turn loop already
 * reads.
 *
 * Inkling frames every segment of a reply as a message,
 * `<|message_model|>[recipient]<|content_KIND|>body<|end_message|>`, and ends
 * the turn with `<|content_model_end_sampling|>`:
 *
 *     <|message_model|><|content_thinking|>…<|end_message|>
 *     <|message_model|><|content_text|>391<|end_message|>
 *     <|message_model|>get_weather<|content_invoke_tool_json|>{"name":"get_weather","args":{…}}<|end_message|>
 *
 * The sidecar streams those special tokens as text. None of the existing
 * filters can take them piecemeal: `<|end_message|>` closes every kind, so it
 * is a reasoning closer only after `content_thinking`, and a tool call names
 * its function before the kind marker, so the name streamed as reply text
 * (2026-11-27: every Inkling turn on MLX showed its thinking and markers in
 * the chat bubble and on `/v1`).
 *
 * So this runs first and rewrites the grammar: thinking becomes
 * `<think>…</think>` for {@link StreamingReasoningSplit} and the end-of-turn
 * reasoning pass, text passes through, a tool call becomes Gemma's
 * `<|tool_call|>name{args}<tool_call|>` for {@link LeakyToolCallStripper} and
 * the marker repair that follows it, and the framing tokens are dropped.
 * Everything downstream (live channels, ramble detection, truncated-call
 * handling) then applies unchanged.
 */

/** Every Inkling special token this stream reacts to. */
const MARKER =
  /<\|(message_model|message_user|message_system|message_tool|end_message|content_[a-z_]+)\|>/;
/** A trailing fragment that could still grow into a marker. */
const PARTIAL_MARKER_TAIL = /<(?:\|[a-z_]*\|?)?$/;
/** At end of turn only a started special token is dropped; a reply may end in `<`. */
const DANGLING_MARKER = /<\|[a-z_]*\|?$/;
/** Ends the turn. Shaped like a content kind, so it is matched first. */
const END_SAMPLING = 'content_model_end_sampling';
/** The model began writing someone else's turn: nothing after it is reply. */
const FOREIGN_ROLES = new Set(['message_user', 'message_system', 'message_tool']);
/** A recipient is a function name; longer text after the role token is prose. */
const MAX_RECIPIENT_LENGTH = 128;
/** The envelope's head, for a body that does not parse as a whole. */
const ENVELOPE_HEAD = /^\s*\{\s*"name"\s*:\s*"([^"\\]*)"\s*,\s*"args"\s*:\s*/;

type Segment = 'thinking' | 'text' | 'tool';

export class InklingMessageStream {
  private buffer = '';
  private mode: 'outside' | 'header' | 'body' | 'done' = 'outside';
  private segment: Segment = 'text';
  private recipient = '';
  private toolBody = '';
  /** Reply text emitted so far, so two text segments do not run together. */
  private visibleTail = '';

  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * End of turn. An unclosed thinking segment is closed so it stays reasoning;
   * an unclosed tool call is emitted without its closer, which the stripper
   * records as truncated at end of stream.
   */
  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = '';
    while (this.mode !== 'done') {
      const match = MARKER.exec(this.buffer);
      if (this.mode === 'header') {
        if (match) {
          const token = match[1]!;
          if (token.startsWith('content_') && token !== END_SAMPLING) {
            this.recipient = this.buffer.slice(0, match.index).trim();
            this.buffer = this.buffer.slice(match.index + match[0].length);
            out += this.open(token.slice('content_'.length));
            continue;
          }
          // A message with no content kind carries nothing to show.
          this.buffer = this.buffer.slice(match.index);
          this.mode = 'outside';
          continue;
        }
        if (this.buffer.length > MAX_RECIPIENT_LENGTH || this.buffer.includes('\n')) {
          // Not a header: the model wrote prose after the role token.
          this.mode = 'outside';
          continue;
        }
        if (final) this.buffer = '';
        break;
      }

      if (match) {
        const token = match[1]!;
        out += this.text(this.buffer.slice(0, match.index));
        this.buffer = this.buffer.slice(match.index + match[0].length);
        if (this.mode === 'body') out += this.close();
        if (token === 'message_model') this.mode = 'header';
        else if (token === 'end_message') this.mode = 'outside';
        else if (token === END_SAMPLING || FOREIGN_ROLES.has(token)) this.mode = 'done';
        else {
          // A content kind with no role token before it.
          this.recipient = '';
          out += this.open(token.slice('content_'.length));
        }
        continue;
      }

      if (final) {
        const rest = this.buffer.replace(DANGLING_MARKER, '');
        this.buffer = '';
        out += this.text(rest);
        if (this.mode === 'body') out += this.close(true);
        this.mode = 'outside';
        break;
      }
      const held = PARTIAL_MARKER_TAIL.exec(this.buffer)?.index ?? this.buffer.length;
      out += this.text(this.buffer.slice(0, held));
      this.buffer = this.buffer.slice(held);
      break;
    }
    if (this.mode === 'done') this.buffer = '';
    return out;
  }

  private open(kind: string): string {
    this.mode = 'body';
    if (kind === 'thinking') {
      this.segment = 'thinking';
      return '<think>';
    }
    if (kind === 'invoke_tool_json') {
      this.segment = 'tool';
      this.toolBody = '';
      return '';
    }
    this.segment = 'text';
    return this.visibleTail !== '' && !/\s$/.test(this.visibleTail) ? '\n\n' : '';
  }

  /** Text found outside a message, or inside the open segment. */
  private text(s: string): string {
    if (s === '') return '';
    if (this.mode === 'body' && this.segment === 'tool') {
      this.toolBody += s;
      return '';
    }
    if (this.mode !== 'body' || this.segment === 'text') this.visibleTail = s;
    return s;
  }

  private close(truncated = false): string {
    this.mode = 'outside';
    if (this.segment === 'thinking') return '</think>';
    if (this.segment === 'tool') {
      const call = toolCallMarkup(this.recipient, this.toolBody, !truncated);
      this.toolBody = '';
      return call;
    }
    return '';
  }
}

/**
 * One Inkling call as the Gemma marker the stripper captures. A body that
 * parses is re-serialized with `<` escaped, so an argument that mentions
 * `<tool_call|>` cannot end the capture early. Otherwise the envelope is
 * peeled and the raw arguments are left to the repair pass, whose JSON rehab
 * handles the raw newlines and quotes models put in string values.
 */
function toolCallMarkup(recipient: string, body: string, complete: boolean): string {
  if (complete) {
    try {
      const call = JSON.parse(body) as unknown;
      if (isPlainObject(call) && typeof call.name === 'string') {
        const args = call.args ?? call.arguments ?? {};
        if (isPlainObject(args)) {
          return `<|tool_call|>${call.name}${JSON.stringify(args).replace(/</g, '\\u003c')}<tool_call|>`;
        }
      }
    } catch {
      // Fall through to the raw form.
    }
  }
  const head = ENVELOPE_HEAD.exec(body);
  const name = head?.[1] || recipient;
  let args = head ? body.slice(head[0].length) : body;
  if (complete && head) args = args.replace(/\}\s*$/, '');
  return `<|tool_call|>${name}${args}${complete ? '<tool_call|>' : ''}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exposed for tests: whether a chat template renders Inkling's message format. */
export function templateTextUsesInklingMessages(template: string): boolean {
  return (
    template.includes('<|message_model|>') && template.includes('<|content_invoke_tool_json|>')
  );
}

/** Whether the model in `modelDir` speaks Inkling's message format. Read once per provider build. */
export function modelUsesInklingMessages(modelDir: string): boolean {
  const template = readChatTemplate(modelDir);
  return template !== undefined && templateTextUsesInklingMessages(template);
}
