/**
 * `validate.inline-js-parses` — runtime self-validation gate for the
 * single-file-web deliverable class. When a gezel's turn writes a full
 * HTML file (`writeFile` to a `*.html` path) whose inline `<script>`
 * body does NOT parse as JavaScript, fire a corrective re-prompt naming
 * the syntax error so the model fixes it within the same user turn —
 * instead of declaring the deliverable done with broken JS that never
 * runs in a browser.
 *
 * Why a runtime post-turn detector and not (only) a craftbook gate: a
 * craftbook `gate` with a `jsParses` check is the right hard floor when a
 * build is *driven by a craftbook task*, but the common path — a Builder
 * asked to "write index.html" with no craftbook in play — has no gate to
 * fire. This detector covers that path: it runs on every turn regardless
 * of task structure, so a single-file web build self-validates its JS
 * whether or not a craftbook is orchestrating it.
 *
 * Wild-caught: qwen3.5-9b on tankcombat reached 8/9 sniff
 * signals but shipped inline JS with unbalanced braces/parens
 * (`}}}}else`, `Unexpected token ')'`) ~60% of the time and could not
 * self-repair from the eval harness's late, diffuse nudge. This detector
 * gives an immediate, focused, in-session re-prompt at the moment the
 * broken file is written.
 *
 * Authored to the CLASS, not to any eval scenario: it checks the generic
 * property "a single-file web page's inline JavaScript must parse" — true
 * for any HTML-with-script deliverable a real user asks for — and shares
 * `validateScriptSyntax` with the craftbook gate (`jsParses` check) and
 * the eval grader so all three agree on the verdict.
 *
 * Full-file `writeFile` only: surgical edits (`replaceInFile`,
 * `applyPatch`) carry a diff rather than the whole file, so the inline
 * JS can't be reconstructed from the tool args — those are left to the
 * next full write or the craftbook gate.
 */

import { extractInlineScripts, validateScriptSyntax } from '@bendyline/gezel/checks';
import type { Behavior, NudgeVerdict, TurnCtx } from '../types.js';

const HTML_PATH_RE = /\.html?$/i;

/**
 * Verdict for one turn's HTML writes. Pure + exported so the detector is
 * unit-testable without a full TurnCtx.
 */
export interface InlineJsParseVerdict {
  broken: boolean;
  /** The HTML path whose inline JS failed to parse (first offender). */
  file: string | null;
  /** The V8 parse error for that file (e.g. "Unexpected token ')'"). */
  error: string | null;
}

/** The subset of a drained tool call this detector reads. */
export interface InlineJsWrite {
  name: string;
  success: boolean;
  path?: string;
  /** Full rendered tool args — for `writeFile` this contains the file body verbatim. */
  argsFull?: string;
}

/**
 * Find the first full HTML write this turn whose inline `<script>` body
 * doesn't parse. Runs `extractInlineScripts` over the rendered `writeFile`
 * args (the body is embedded verbatim, so the `<script>…</script>` regex
 * finds it through the `path:`/`content:` wrapper) and parses each via the
 * shared `validateScriptSyntax`.
 */
export function detectBrokenInlineJs(writes: readonly InlineJsWrite[]): InlineJsParseVerdict {
  for (const w of writes) {
    if (!w.success || w.name !== 'writeFile') continue;
    const path = w.path ?? '';
    if (!HTML_PATH_RE.test(path) || !w.argsFull) continue;
    const scripts = extractInlineScripts(w.argsFull);
    const v = validateScriptSyntax(scripts);
    // totalBytes === 0 → no inline JS to judge; allParse → fine.
    if (v.totalBytes === 0 || v.allParse) continue;
    return { broken: true, file: path, error: v.firstError ?? null };
  }
  return { broken: false, file: null, error: null };
}

export const ValidateInlineJsParses: Behavior = {
  id: 'validate.inline-js-parses',
  description:
    "Runtime self-validation for single-file web deliverables: when a turn writes an HTML file whose inline <script> doesn't parse as JavaScript, re-prompts the model with the syntax error so it self-repairs before declaring the deliverable done.",

  postTurnDetector(ctx: TurnCtx): NudgeVerdict | null {
    const verdict = detectBrokenInlineJs(ctx.drained);
    if (!verdict.broken || !verdict.file) return null;
    const errPart = verdict.error ? `: ${verdict.error}` : '';
    return {
      reason: `inline JS in ${verdict.file} does not parse${errPart}`,
      promptForNextTurn: `The inline <script> you just wrote to \`${verdict.file}\` has a JavaScript syntax error${errPart}. A browser will not run the page until the script parses. Re-read your <script> block and find the broken statement — the most common causes are an unbalanced brace \`}\` or parenthesis \`)\`, or a stray token — then rewrite \`${verdict.file}\` with the corrected inline script. Do not report the deliverable as done until the inline JavaScript parses.`,
    };
  },
};
