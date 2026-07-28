/**
 * `prompt.prefer-writefile-edits` — steer small/verbose code models to edit
 * existing files by LINE NUMBER (`replace_lines`) rather than by reproducing
 * existing text (`replace_in_file`'s byte-exact `find`, or a whole-file
 * `write_file` rewrite).
 *
 * (The id is legacy — an earlier version of this behavior blanket-preferred
 * `write_file`. That backfired: a small model can't reproduce a large file,
 * so its `write_file` comes out truncated and the source-write guard rejects
 * it; the guard then points at "a focused edit tool," which this behavior
 * was telling it to avoid — a thrash that aborts. The unifying insight is
 * that the model's one disabling weakness is *reproducing text it didn't
 * just generate*. Rank the edit tools by how much existing text they force
 * it to reproduce: `write_file` = the whole file (worst on big files),
 * `replace_in_file` = the `find` region byte-exact (bad), `replace_lines` =
 * nothing (point at line N, supply only new text). So the rule is positional
 * editing, not "which tool." Wild-caught, gemma4-12b on a 9 KB
 * `game.ts`.)
 *
 * This OVERRIDES the cookbook's "patch it with replace_in_file" guidance and
 * the `prompt.private-reasoning-guidance` "use replace_in_file, not a full
 * rewrite" line, so it must land LATE in the system prompt (placed after
 * those entries in `ALL_BEHAVIORS`). Scope to sub-20B models that fumble
 * byte-exact matching; the larger gemmas reproduce text reliably.
 *
 * Pairs with the role-tool-filter rule that exposes `replace_lines` wherever
 * `replace_in_file` is available — this guidance is only actionable when
 * `replace_lines` is actually wired.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const PREFER_WRITEFILE_EDITS_GUIDANCE = `

---

## Editing files — edit by line number, don't retype

This OVERRIDES any earlier "patch it with \`replace_in_file\`" or "rewrite the whole file" guidance for this model. The rule: never reproduce existing file text from memory — target it by **position**.

- **To change specific lines in an existing file, use \`replace_lines\`.** \`read_file\` shows every line with an \`N→\` gutter; pass the range (\`startLine\`/\`endLine\`, read straight off the gutter) and the replacement \`content\`. You supply ONLY the new text — you don't retype the surrounding code and there's no \`find\` string to match. This is the reliable surgical edit.
- **Avoid \`replace_in_file\`.** Its \`find\` must match the file byte-for-byte — every quote, dot, comma, and space. Reproducing that from memory fails (\`Projectile, Invader\` comes out as \`Projectile and Invader\`), the patch misses, and you burn the turn re-reading.
- **Use \`write_file\` only for a NEW file, or a small existing file you can reproduce in full.** Do NOT \`write_file\` a large existing file to fix a few lines — you'll truncate it (the runtime refuses a much-shorter overwrite) and lose the parts that already worked. Patch it with \`replace_lines\` instead.`;

export function preferWritefileEditsPrompt(_ctx?: PromptCtx, _config?: undefined): string {
  return PREFER_WRITEFILE_EDITS_GUIDANCE;
}

export const PromptPreferWritefileEdits: Behavior = {
  id: 'prompt.prefer-writefile-edits',
  description:
    'Steers small/verbose code models to edit existing files by line number (`replace_lines`) rather than byte-matching (`replace_in_file`) or rewriting large files (`write_file` truncates them). Positional edits play to the model reading line numbers off the gutter and need no reproduction of existing text. Overrides the cookbook patch guidance; scope to sub-20B models.',
  promptAppend: preferWritefileEditsPrompt,
};
