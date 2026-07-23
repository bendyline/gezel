/**
 * `prompt.terse-visible-reply` — tell verbose-family local models to keep
 * the VISIBLE reply to a conclusion-plus-action, not the analysis trail.
 *
 * Wild-caught (gemma4-12b, space-invaders fix): the model
 * leaked multi-paragraph analysis into the content channel — two separate,
 * partly-contradictory "here's what's wrong / here's my plan" passes —
 * burning up to its full 2048-token output cap (~130s at ~15 t/s) on a
 * single call before acting, then bloating every subsequent prompt. The
 * leak is *untagged* prose, so the reasoning-strip behaviors (which target
 * tagged channels) don't catch it.
 *
 * This is a pre-generation steer: the cheapest fix for "burns tokens
 * narrating" is to not generate the narration. It complements (does not
 * replace) `turn.preamble-folding` (folds pre-tool prose when a tool
 * fires) and `turn.ramble-detection` (aborts runaway prose). Scope to
 * verbose small models; the larger gemmas are terser and don't need it.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const TERSE_VISIBLE_REPLY_GUIDANCE = `

---

## Keep the visible reply short — act, don't narrate

- The visible reply is the **conclusion plus the action**, never the analysis that produced it. Aim for one to three sentences, then the tool call.
- **Do not** write multi-paragraph breakdowns of what's broken, re-list the files and their issues, or restate your plan in the chat. That walkthrough is private reasoning — keep it out of the visible channel.
- Once you've read the files and know the fix, the next thing in your reply is the \`writeFile\` (or other tool) — not another paragraph explaining it.
- Never repeat an analysis you already gave. If you notice yourself re-explaining the same problem a second time, stop narrating and call the tool.`;

export function terseVisibleReplyPrompt(_ctx?: PromptCtx, _config?: undefined): string {
  return TERSE_VISIBLE_REPLY_GUIDANCE;
}

export const PromptTerseVisibleReply: Behavior = {
  id: 'prompt.terse-visible-reply',
  description:
    'Tells verbose-family local models to keep the visible reply to a conclusion-plus-action and stop narrating multi-paragraph analysis into the content channel (which burns the output budget and bloats context). Scope to verbose small models.',
  promptAppend: terseVisibleReplyPrompt,
};
