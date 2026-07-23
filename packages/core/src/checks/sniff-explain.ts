/**
 * Human-line explainers for the step sniffs. A gate verdict that says
 * "index.html failed the html-game check" restates the rule; one that
 * says "no render surface and no frame loop — add the game loop" names
 * the model's actual gap (Law 3 of the task-completion strategy: the
 * verdict must quote the failing observation, not the rule). Composed
 * from the same primitives the sniffs themselves use, so the diagnosis
 * can never disagree with the verdict.
 */

import { detectUnclosedScript, inlineJsBytes } from './html.js';
import { jsonValid } from './text.js';

export type ExplainableSniff =
  | 'html-complete'
  | 'html-game'
  | 'nonempty'
  | 'json-valid'
  | 'data-table';

/**
 * One imperative line explaining why `content` fails the named sniff.
 * Callers only invoke this AFTER the sniff returned false; for content
 * that actually passes, a generic line is returned rather than lying
 * about a defect.
 */
export function explainSniff(name: ExplainableSniff, content: string): string {
  switch (name) {
    case 'html-complete': {
      const scripts = detectUnclosedScript(content);
      if (scripts.unclosed) {
        return `${scripts.opens} <script> tag${scripts.opens === 1 ? '' : 's'} open but only ${scripts.closes} close${scripts.closes === 1 ? 's' : ''} — the document is truncated mid-script. Finish the file: close the script and end with </body></html>.`;
      }
      const lower = content.toLowerCase();
      if (!lower.includes('</body>') && !lower.includes('</html>')) {
        return 'missing a closing </body> or </html> — the document is incomplete; finish it.';
      }
      return 'the document is incomplete — finish and close it.';
    }
    case 'html-game': {
      const lower = content.toLowerCase();
      const hasRenderTarget = /<canvas\b/.test(lower) || /<svg\b/.test(lower);
      const hasFrameLoop =
        /requestanimationframe\s*\(/.test(lower) ||
        /set(?:interval|timeout)\s*\(/.test(lower) ||
        /\bfunction\s+(?:tick|update|loop|gameloop|gametick|step|render|frame)\b/.test(lower);
      if (!hasRenderTarget && !hasFrameLoop) {
        return 'no render surface (<canvas>/<svg>) and no frame loop (requestAnimationFrame / setInterval / a tick()/update() function) — add the game loop.';
      }
      const scripts = detectUnclosedScript(content);
      if (scripts.opens === 0) {
        return 'no <script> block — the page has no game logic; add the inline script.';
      }
      if (scripts.unclosed) {
        return `${scripts.opens} <script> tag${scripts.opens === 1 ? '' : 's'} open but only ${scripts.closes} close${scripts.closes === 1 ? 's' : ''} — truncated mid-script; close the script.`;
      }
      const js = inlineJsBytes(content);
      if (js < 400) {
        return `inline JavaScript is ${js} bytes, need >= 400 — the page has no substantive game logic yet.`;
      }
      return 'the page does not read as a working game yet — check the script and game loop.';
    }
    case 'json-valid': {
      const parsed = jsonValid(content);
      if (!parsed.ok) {
        return `not valid JSON: ${parsed.error ?? 'parse failed'} — fix the syntax error.`;
      }
      return 'the file must be valid JSON.';
    }
    case 'nonempty':
      return 'the file is empty — write the deliverable content.';
    case 'data-table':
      return 'not parseable data — expected a non-empty JSON array, a comma-delimited table (header + at least one row), or a Markdown table. If you wrote the transform/pipeline code but not its output, RUN it and write the produced data to the file.';
  }
}
