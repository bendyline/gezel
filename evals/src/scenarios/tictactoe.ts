import { ticTacToeContentSniff } from '../success-check.ts';
import type { EvalScenario } from '../types.ts';
import { type RuntimeAssertion, pollHtmlSniff } from './helpers.ts';

export function checkTicTacToeWinningSequence(
  marks: readonly string[],
  statusTexts: readonly string[],
): { ok: boolean; why?: string } {
  const first = marks[0]?.trim() ?? '';
  const second = marks[1]?.trim() ?? '';
  const third = marks[2]?.trim() ?? '';
  const fourth = marks[3]?.trim() ?? '';
  const fifth = marks[4]?.trim() ?? '';
  if (!first || !second || !third || !fourth || !fifth) {
    return { ok: false, why: `five driven cells were not all marked (${marks.join(', ')})` };
  }
  if (first !== third || first !== fifth || second !== fourth || first === second) {
    return {
      ok: false,
      why: `players did not alternate into a top-row win (${marks.join(', ')})`,
    };
  }
  const winnerShown = statusTexts.some((text) => /\b(?:winner|wins?|won)\b/i.test(text));
  return winnerShown
    ? { ok: true }
    : { ok: false, why: 'no visible winner message after the winning move' };
}

/**
 * Runtime assertions for tic-tac-toe. The static sniff catches "looks
 * like tic-tac-toe HTML"; these check "actually plays like tic-tac-toe."
 *
 * Strategy: locate 9 cell-like elements, drive a deterministic five-move
 * game (0,3,1,4,2), and verify alternating markers plus a visible winner.
 * That closes the old loophole where one click worked but the requested
 * two-player/win logic lived only in comments or dead code.
 */
export function ticTacToeAssertions(): RuntimeAssertion[] {
  return [
    {
      name: 'nine-cells-rendered',
      test: async (page) => {
        // Use a forgiving selector: any element with a click-able role
        // that's part of a 3x3 grid. Models vary in markup choice:
        // <button>, <td>, <div role="button">, <div class="cell">. We
        // require >=9 such elements, since stricter selectors miss
        // legitimate variants.
        const result = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          // Heuristic: a cell is an element with onclick OR a "cell"-y
          // class/id/role. We don't require all matchers — many
          // matching is enough.
          let cellLike = 0;
          for (const el of all) {
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const role = el.getAttribute('role') || '';
            const tag = el.tagName.toLowerCase();
            const hasInlineHandler = !!el.onclick;
            const looksLikeCell =
              /\bcell\b|\bsquare\b|\bbox\b|\btile\b/.test(`${cls} ${id}`) ||
              tag === 'td' ||
              (tag === 'button' && el.children.length === 0) ||
              role === 'button' ||
              hasInlineHandler;
            if (looksLikeCell) cellLike++;
          }
          const scripts = Array.from(document.querySelectorAll('script'))
            .map((script) => script.textContent ?? '')
            .join('\n');
          const emptyCellsForEachBug =
            /(?:const|let)\s+cells\s*=\s*\[\s*\]/.test(scripts) &&
            /cells\.forEach\s*\(/.test(scripts) &&
            /createCell\s*\(/.test(scripts);
          return { cellLike, emptyCellsForEachBug };
        });
        return result.cellLike >= 9
          ? { ok: true }
          : {
              ok: false,
              why: result.emptyCellsForEachBug
                ? `only ${result.cellLike} cell-like elements (need ≥ 9). The script initializes an empty \`cells = []\` array and then calls \`cells.forEach(...createCell...)\`, so the create loop runs zero times. Patch the board creation to \`for (let i = 0; i < 9; i++) createCell(i)\`, \`Array.from({ length: 9 }, (_, i) => createCell(i))\`, or write nine static cell buttons.`
                : `only ${result.cellLike} cell-like elements (need ≥ 9)`,
            };
      },
    },
    {
      name: 'click-marks-a-cell',
      test: async (page) => {
        // Click the first thing that looks like a cell, then check
        // that its text content changed to a single token (X / O /
        // similar). We poll for up to 1.5s to let async handlers fire.
        const before = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          const primary = candidates.filter((el) => {
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const tag = el.tagName.toLowerCase();
            return /\bcell\b|\bsquare\b|\bbox\b|\btile\b/.test(`${cls} ${id}`) || tag === 'td';
          });
          const cells =
            primary.length >= 9
              ? primary
              : candidates.filter(
                  (el) => el.tagName.toLowerCase() === 'button' && el.children.length === 0,
                );
          if (cells.length < 9) return null;
          const target = cells[0];
          if (!target) return null;
          target.setAttribute('data-tictactoe-test-target', '1');
          return target.textContent ?? '';
        });
        if (before === null) {
          return { ok: false, why: 'no clickable cell found to drive' };
        }
        await page.click('[data-tictactoe-test-target="1"]');
        // Give the event loop time to run any handler.
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => {
          const el = document.querySelector('[data-tictactoe-test-target="1"]');
          return (el?.textContent ?? '').trim();
        });
        // Fallback: check whether any cell now has a marker — some
        // implementations redraw the board on every move.
        const hasMarkerSomewhere = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('*')).some((el) => {
            const t = (el.textContent ?? '').trim();
            return /^(x|o)$/i.test(t) && el.children.length === 0;
          });
        });
        if (!after || after === before.trim()) {
          if (!hasMarkerSomewhere) {
            return {
              ok: false,
              why: `cell content unchanged after click (was "${before.trim()}", still "${after}")`,
            };
          }
        }

        // Finish a deterministic first-player win across the top row.
        // Re-find the cells for each click so implementations that redraw
        // the board between moves remain driveable.
        for (const index of [3, 1, 4, 2]) {
          const clicked = await page.evaluate((cellIndex: number) => {
            const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
            const primary = all.filter((el) => {
              const cls = (el.className || '').toString().toLowerCase();
              const id = (el.id || '').toLowerCase();
              return (
                /\bcell\b|\bsquare\b|\bbox\b|\btile\b/.test(`${cls} ${id}`) ||
                el.tagName.toLowerCase() === 'td'
              );
            });
            const cells =
              primary.length >= 9
                ? primary
                : all.filter(
                    (el) => el.tagName.toLowerCase() === 'button' && el.children.length === 0,
                  );
            const cell = cells[cellIndex];
            if (!cell) return false;
            cell.click();
            return true;
          }, index);
          if (!clicked) return { ok: false, why: `could not drive cell ${index}` };
          await page.waitForTimeout(75);
        }

        const finalState = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          const primary = all.filter((el) => {
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            return (
              /\bcell\b|\bsquare\b|\bbox\b|\btile\b/.test(`${cls} ${id}`) ||
              el.tagName.toLowerCase() === 'td'
            );
          });
          const cells =
            primary.length >= 9
              ? primary
              : all.filter(
                  (el) => el.tagName.toLowerCase() === 'button' && el.children.length === 0,
                );
          return {
            marks: [0, 3, 1, 4, 2].map((index) => (cells[index]?.textContent ?? '').trim()),
            statusTexts: all
              .filter((el) => {
                if (el.children.length !== 0) return false;
                // Source-bearing/inert nodes are leaf elements too. Without
                // this guard, the literal "Player X wins" inside <script>
                // satisfied the supposed *visible* winner assertion even
                // when no UI element was ever updated.
                if (/^(?:script|style|template|noscript|head|meta|link)$/i.test(el.tagName)) {
                  return false;
                }
                const style = window.getComputedStyle(el);
                if (
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  Number(style.opacity) === 0
                ) {
                  return false;
                }
                return el.getClientRects().length > 0;
              })
              .map((el) => (el.textContent ?? '').trim())
              .filter(Boolean),
          };
        });
        return checkTicTacToeWinningSequence(finalState.marks, finalState.statusTexts);
      },
    },
  ];
}

export const ticTacToeScenario: EvalScenario = {
  id: 'tictactoe',
  description:
    'Meester creates a project, recruits a developer, and ships a working tic-tac-toe HTML game.',
  prompt:
    'Create a new project for this work (e.g. `Tic-Tac-Toe Game`) and build a tic-tac-toe game I can ' +
    'play in my browser IN THAT NEW PROJECT. Single HTML file at `workspace/index.html`, no build step. ' +
    'Two players take turns; show the winner when the game ends. Prefer nine static `<button class="cell" data-cell="0">` through `data-cell="8"` elements in the HTML before the script, then wire them with `document.querySelectorAll(".cell")`. If you generate the board dynamically, create exactly 9 cells with a numeric loop such as `for (let i = 0; i < 9; i++)`; do not iterate an initially empty cells array to create the cells.',
  // Generous wall-clock backstop only. The no-progress watchdog (45 min)
  // and the count-based retry-loop are the real terminators; this 2 h
  // ceiling just stops a wedged trial eventually. The eval measures
  // capability, which is throughput-invariant — a slow-decoding model is
  // never failed for running long while still making progress.
  timeoutMs: 120 * 60_000,
  successCheck: async (ctx) => {
    // Honor a per-model lowered JS floor when the catalog manifest
    // declares one (`evalHints.sniffThresholds.inlineJsMinBytes`). The
    // sniff has its own default of 2048; this just hands the override
    // through when present.
    const minInlineJsBytes = ctx.evalHints?.sniffThresholds?.inlineJsMinBytes;
    return pollHtmlSniff({
      ctx,
      sniff: (html) =>
        ticTacToeContentSniff(html, minInlineJsBytes ? { minInlineJsBytes } : undefined),
      getExtraContext: async () => undefined,
      runtimeAssertions: () => ticTacToeAssertions(),
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: {
        maxNudges: 1,
        repairDirective:
          'TIC-TAC-TOE BUILD SHAPE: put the nine playable cells in the HTML before the script: nine `<button class="cell" data-cell="0" type="button"></button>` ... `data-cell="8"` buttons inside the grid. Then use `const cells = document.querySelectorAll(".cell")` and attach click listeners. Do not ship `<div class="grid" id="grid"></div>` with no child cells.',
      },
    });
  },
};
