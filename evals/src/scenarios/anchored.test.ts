import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANCHORED_SCENARIOS, SCENARIOS } from './index.ts';

/**
 * Frozen-anchor guard (Theme E / E4). The three anchored scenarios are the
 * longitudinal regression floor — their prompts + success criteria must
 * not drift. This is the "keep anchors frozen; expand by adding"
 * discipline made structural: any edit to an anchor's prompt/evidence OR
 * its source file (which is where `successCheck` lives) forces a
 * DELIBERATE hash bump here. If this test fails, either you didn't mean to
 * touch an anchor (revert), or you did and must consciously re-pin —
 * accompanied by a note on why the longitudinal baseline is moving.
 *
 * Regenerate the pinned hashes intentionally (only when re-pinning is the
 * point) and paste them below.
 */
// deliberate success-check re-pin (prompts unchanged):
// tictactoe now drives alternation + a winner, petshop validates raster
// bytes instead of extensions, and tankcombat requires observable input
// state. These close false-positive gates; they do not tune an anchor to
// make a model pass.
// Follow-up review: tictactoe's winner probe now excludes inert/hidden
// source nodes, so a string literal inside <script> cannot masquerade as
// the requested visible winner message.
// Petshop follow-up: prompt/evidence remain unchanged; its grader now
// rejects malformed inline JS, promotes browser errors, validates every
// rendered local raster after bounded post-load dynamic DOM work, and
// reports score=N/5.
// Date-memorialization cleanup changed petshop comments only; the semantic
// contract remains unchanged.
// Tool-naming standardization re-pin: the MCP fs tools moved to snake_case
// (`writeFile` → `write_file` etc.), which renamed tool mentions inside
// tankcombat's prompt and petshop's success-check internals. The tasks,
// deliverables, and pass criteria are unchanged — only the tool spellings
// the prompts teach moved with the product surface. Longitudinal
// comparisons across the rename should lean on the naming A/B
// (`ab-tool-naming`) rather than treating pre/post runs as one series.
const PINNED: Record<(typeof ANCHORED_SCENARIOS)[number], { semantic: string; source: string }> = {
  tictactoe: { semantic: 'a553e5a80e5dab9f', source: '1a0c7e9f219f96ce' },
  petshop: { semantic: '20a5fbfb35b86f9c', source: 'c6ae728c51d8f80c' },
  tankcombat: { semantic: 'c247df6736d31ac8', source: '9e5d0971ddadbfd2' },
};

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function semanticHash(id: (typeof ANCHORED_SCENARIOS)[number]): string {
  const s = SCENARIOS[id]!;
  return sha(
    JSON.stringify({
      prompt: s.prompt,
      evidence: (s.requiredPromptEvidence ?? []).map((e) => [e.signal, e.pattern.source]),
    }),
  );
}

describe('frozen anchors', () => {
  it('the anchored set is exactly the longitudinal trio and all are registered', () => {
    expect([...ANCHORED_SCENARIOS]).toEqual(['tictactoe', 'petshop', 'tankcombat']);
    for (const id of ANCHORED_SCENARIOS) {
      expect(SCENARIOS[id], `anchor "${id}" missing from SCENARIOS`).toBeDefined();
      expect(SCENARIOS[id]!.id).toBe(id);
    }
  });

  it.each(ANCHORED_SCENARIOS)('%s prompt + success criteria have not drifted', (id) => {
    // Semantic: the on-object contract (prompt + required evidence).
    expect(semanticHash(id), `${id}: prompt/evidence drifted — see anchored.test.ts`).toBe(
      PINNED[id].semantic,
    );
    // Source: the whole scenario module (catches successCheck edits the
    // on-object contract can't see).
    const source = sha(readFileSync(join(here, `${id}.ts`), 'utf8'));
    expect(
      source,
      `${id}.ts source drifted — re-pin only if the freeze is deliberately moving`,
    ).toBe(PINNED[id].source);
  });
});
