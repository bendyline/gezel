/**
 * `reasoning.strip-channel-tags` — captures gpt-oss / Gemma "channel"
 * reasoning blocks from the model's raw output and promotes them
 * onto `ChatMessage.reasoning` so the UI can render them in a
 * collapsible expander instead of the visible bubble.
 *
 * Several shapes are handled:
 *   - Canonical: `<|channel|>NAME<|message|>BODY<|end|>` — the
 *     gpt-oss-trained shape Gemma 3/4 also emits when prompted with
 *     the verbose-family channel hint.
 *   - Asymmetric: `<|channel>NAME\nBODY<channel|>` and the wild-caught
 *     dropped-pipe variants `<channel>NAME\nBODY<channel|>`,
 *     `<|channel>NAME\nBODY</channel>`. Gemma 4 26B emits these in
 *     the wild; the regex accepts any combination of leading/trailing
 *     pipes and any of `/`, `\\` as the close-tag prefix.
 *   - Bracket-loss: `NAME|>BODY|<end|>` — Gemma 4 E4B (llama.cpp)
 *     detokenizer drops the `<` from `<|channel|>` and the leading
 *     `|` from `<|end|>`, leaving the channel name + the `|>` tail
 *     of `<|message|>` as the opener and `<end|>` (sometimes with a
 *     stray leading `|`) as the close. No `channel` text remains, so
 *     none of the above shapes match.
 *   - Bare-pipe closed: `NAME|\nBODY</|end|>`. Same Gemma 4 E4B
 *     llama.cpp path, but the opener loses the `<|message|>` tail and
 *     the close keeps a slash before the pipe.
 *   - Unclosed bracket-loss: `NAME|>BODY|` at end-of-message. Same
 *     Gemma 4 E4B llama.cpp path as above, but the `<end|>` residue
 *     never arrives; capture to the end because there is no reliable
 *     visible-body boundary once the control marker is malformed.
 *   - Bare-name leak: a line containing JUST a known channel name
 *     (`thought` / `analysis` / `commentary` / `final`) and nothing
 *     else, with no surrounding tag markup. Gemma 4 26B emits this
 *     pathologically — sometimes 50+ consecutive `thought\n` lines
 *     bleed into the visible bubble. We don't want to drop the
 *     signal entirely (the model is genuinely in a reasoning mode
 *     and the user benefits from seeing that), so we collapse runs
 *     of bare-name leaks into a single italic mode indicator
 *     (`_Thinking…_` / `_Analyzing…_` / etc.) that the chat bubble
 *     renders as a muted status line.
 *
 * The channel-name prefix (`analysis`, `thought`, etc.) is stripped
 * from the captured body so the user sees the reasoning prose, not
 * an `analysis<|message|>...` artifact.
 *
 * Migrated from a subset of the universal `extractReasoning()` in
 * [providers/local-tool-call-salvage.ts](../../providers/local-tool-call-salvage.ts).
 */

import { promoteBareChannelNames } from '@bendyline/gezel';
import type { Behavior } from '../types.js';

function captureChannelTags(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: text, reasoning: '' };
  const captured: string[] = [];
  let out = text;
  out = out.replace(/<\|channel\|>([\s\S]*?)<\|end\|>/gi, (_m, inner: string) => {
    const m = inner.match(/^[a-zA-Z_][a-zA-Z0-9_-]*\s*<\|message\|>([\s\S]*)$/);
    captured.push(m ? m[1]! : inner);
    return '';
  });
  out = out.replace(
    /<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?[\s\S]*?<\|?\/?channel\|?>/gi,
    (m) => {
      const body = m
        .replace(/^<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\s*\n?/i, '')
        .replace(/<\|?\/?channel\|?>$/i, '');
      captured.push(body);
      return '';
    },
  );
  out = out.replace(
    /<\|channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\n([\s\S]*?)(?:<\/?channel\|?>|\n\n)/i,
    (_m, inner: string) => {
      captured.push(inner);
      return '';
    },
  );
  out = out.replace(
    /(?<=^|\n)(?:thought|analysis|commentary|final)\|(?!>)\s*\n?([\s\S]*?)\|?<\|?\/?\|?end\|?>/gi,
    (_m, body: string) => {
      captured.push(body);
      return '';
    },
  );
  out = out.replace(
    /(?<=^|\n)(?:thought|analysis|commentary|final)\|>([\s\S]*?)\|?<\|?\/?\|?end\|?>/gi,
    (_m, body: string) => {
      captured.push(body);
      return '';
    },
  );
  out = out.replace(
    /(?<=^|\n)(?:thought|analysis|commentary|final)\|>([\s\S]*?)\|?\s*$/gi,
    (_m, body: string) => {
      captured.push(body);
      return '';
    },
  );
  out = out.replace(/<\|?\/?channel\|?>/gi, '');
  out = out.replace(/<\|?\/?message\|?>/gi, '');
  out = out.replace(/<\|?\/?\|?end\|?>/gi, '');
  out = promoteBareChannelNames(out);
  const visible = out.replace(/\n{3,}/g, '\n\n').trim();
  const reasoning = captured
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
  return { visible, reasoning };
}

export const ReasoningStripChannelTags: Behavior = {
  id: 'reasoning.strip-channel-tags',
  description:
    'Captures gpt-oss / Gemma `<|channel|>...<|end|>` (and asymmetric `<|channel>...<channel|>`) reasoning blocks and promotes them to `ChatMessage.reasoning`. Opt-in for gpt-oss / Gemma 3 / Gemma 4 family models.',
  captureReasoning: (text: string) => captureChannelTags(text),
};
