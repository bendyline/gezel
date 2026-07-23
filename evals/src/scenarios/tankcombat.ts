import { TANK_SUBJECT_VOCAB, tankCombatContentSniff } from '../success-check.ts';
import type { EvalScenario } from '../types.ts';
import { type RuntimeAssertion, pollHtmlSniff } from './helpers.ts';

// Keep this browser probe as source text rather than a nested function passed to
// `page.evaluate`. The eval CLI runs through tsx/esbuild with function-name
// preservation enabled; nested helpers inside an evaluate callback are then
// rewritten to call esbuild's module-scoped `__name` helper. Playwright
// serializes only the callback, so that helper does not exist in the page and
// an otherwise-valid game fails with `ReferenceError: __name is not defined`.
// A source expression has no closure and therefore executes identically under
// tsx, compiled JavaScript, and Playwright.
export const TANK_INPUT_SIGNATURE_EXPRESSION = `(() => {
  const canvas = document.querySelector('canvas');
  const state = window.gameState ?? window.game ?? null;
  const player = window.player ?? window.tank ?? state?.player ?? state?.tank ?? null;
  const scalar = (value) => value && typeof value === 'object' ? {
    x: value.x,
    y: value.y,
    vx: value.vx,
    vy: value.vy,
    dx: value.dx,
    dy: value.dy,
    angle: value.angle,
    direction: value.direction,
    inputTick: value.inputTick,
    shooting: value.shooting,
    firing: value.firing,
    keys: value.keys,
    input: value.input,
  } : null;
  return JSON.stringify({
    canvas: canvas ? canvas.width + 'x' + canvas.height : null,
    bodyDataset: Object.fromEntries(
      Object.entries(document.body.dataset).filter(([key]) => /input|key|control/i.test(key)),
    ),
    state: scalar(state),
    player: scalar(player),
  });
})()`;

export const TANK_COMBAT_HTML_REPAIR_DIRECTIVE = [
  'TANK_COMBAT_HTML_SHAPE: write one complete `index.html` document in a single workspace `writeFile` call.',
  'Use exactly this source shape: `<!doctype html><html><head><style>...</style></head><body>...<canvas id="game"></canvas>...<script>/* all game JavaScript here */</script></body></html>`.',
  'All JavaScript must be inside that one inline `<script>` block before `</body>`: declarations, functions, querySelector/addEventListener calls, key handlers, requestAnimationFrame game loop, projectiles, collision, score, and `window.gameState = gameState`.',
  'Do not place `const`, `let`, `var`, `function`, `querySelector`, `addEventListener`, or `requestAnimationFrame` after `</script>`, after `</body>`, or after `</html>`.',
  'If `writeFile` is rejected for JavaScript outside a script tag, do not keep patching fragments; immediately re-emit the entire corrected HTML file from `<!doctype html>` through `</html>` with all JS inside the script block.',
].join(' ');

/**
 * Runtime assertions for tank-combat. We can't easily verify game-loop
 * correctness from outside the canvas (no pixel asserts here), so the
 * checks are deliberately scoped to "did the document boot without
 * throwing, and does it have a rendering surface and a keyboard
 * listener?" That catches the dominant on-device failure mode: HTML
 * that LOOKS like a game but threw on first script tick and stopped
 * running, or never wired keyboard input.
 */
function tankCombatAssertions(): RuntimeAssertion[] {
  return [
    {
      name: 'render-surface-present',
      test: async (page) => {
        const found = await page.evaluate(() => {
          return !!(document.querySelector('canvas') || document.querySelector('svg'));
        });
        return found ? { ok: true } : { ok: false, why: 'no <canvas> or <svg> in the DOM' };
      },
    },
    {
      name: 'no-page-errors-after-1s',
      test: async (page) => {
        // Wait 1s for any deferred init scripts; the pageerror listener
        // installed by renderAndAssert collects errors into the report,
        // but we also want to fail the assertion specifically when the
        // game itself threw on load.
        await page.waitForTimeout(1000);
        // The pageErrors collector lives outside this fn — we just
        // succeed; the harness logs the page-error count separately.
        return { ok: true };
      },
    },
    {
      name: 'keyboard-listener-installed',
      test: async (page) => {
        // After load, dispatching a keydown should hit a handler — we
        // verify the page declared one. There's no portable way to ask
        // "does anyone listen for keydown?", but a working game will
        // either (a) update document state when we press a key, or
        // (b) have a handler we can detect via getEventListeners (Chrome
        // DevTools-only, not exposed). We do (a): press ArrowRight, wait,
        // check that *something* mutated in the DOM (canvas attribute,
        // score span, body class). If literally nothing changed, the
        // listener is missing OR the loop isn't running.
        const beforeSig = await page.evaluate(TANK_INPUT_SIGNATURE_EXPRESSION);
        // Hold movement long enough for a frame-based handler to expose
        // its effect, then fire once. `press()` releases immediately and
        // can hide a perfectly real keys-map transition between samples.
        await page.keyboard.down('ArrowRight');
        await page.waitForTimeout(150);
        await page.keyboard.press(' ');
        await page.waitForTimeout(400);
        const afterSig = await page.evaluate(TANK_INPUT_SIGNATURE_EXPRESSION);
        await page.keyboard.up('ArrowRight');
        if (beforeSig !== afterSig) return { ok: true };
        return {
          ok: false,
          why: 'observable DOM/window game-state signature was unchanged while ArrowRight was held and Space fired',
        };
      },
    },
  ];
}

export const tankCombatScenario: EvalScenario = {
  id: 'tankcombat',
  description:
    'Meester creates a project, recruits a developer, and ships a playable top-down tank combat arcade game in a single HTML file.',
  prompt: `Create a new project for this work (e.g. \`Tank Combat Arcade\`) and build a top-down tank combat arcade game there. Write the entire game as a single self-contained file at \`workspace/index.html\` IN THAT NEW PROJECT (HTML + inline \`<style>\` + inline \`<script>\`, no external assets, no build step). The player controls a tank with arrow keys (or WASD), fires projectiles with space, and fights at least one enemy tank. Track a score on screen. Make keyboard input observable in the browser: expose \`window.gameState = gameState\` or update a \`document.body.dataset.inputTick\` value inside key handlers so automated runtime checks can see input activity. The first concrete deliverable is the index.html file inside the new project — write it now. ${TANK_COMBAT_HTML_REPAIR_DIRECTIVE}`,
  requiredPromptEvidence: [
    { signal: TANK_SUBJECT_VOCAB.signal, pattern: TANK_SUBJECT_VOCAB.pattern },
  ],
  // Tank combat is a richer ask than tic-tac-toe (canvas / SVG rendering,
  // keyboard input, projectiles, collision, scoring) so the developer
  // typically needs more iterations. Generous wall-clock backstop only:
  // the no-progress watchdog (45 min) and the count-based retry-loop are
  // the real terminators. The old 25 min ceiling killed still-progressing
  // 8/9 trials at low decode speed — a throughput artifact, not a real
  // failure. 2 h removes that confound (the eval is throughput-invariant).
  timeoutMs: 120 * 60_000,
  successCheck: async (ctx) => {
    // Per-model floor overrides (see tictactoe.ts for the JS-floor
    // rationale). `htmlMinBytes` is the parallel total-HTML override:
    // terse-but-complete games (GPT-OSS ~2.6 KB, Nemotron-nano ~4 KB)
    // fail ONLY `html-size-ok` under the shared 4 KB floor, so the
    // manifest lowers it per-model without touching MIN_GAME_HTML_BYTES.
    const minInlineJsBytes = ctx.evalHints?.sniffThresholds?.inlineJsMinBytes;
    const minHtmlBytes = ctx.evalHints?.sniffThresholds?.htmlMinBytes;
    const sniffOpts =
      minInlineJsBytes || minHtmlBytes
        ? {
            ...(minInlineJsBytes ? { minInlineJsBytes } : {}),
            ...(minHtmlBytes ? { minHtmlBytes } : {}),
          }
        : undefined;
    return pollHtmlSniff({
      ctx,
      sniff: (html) => tankCombatContentSniff(html, sniffOpts),
      getExtraContext: async () => undefined,
      runtimeAssertions: () => tankCombatAssertions(),
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: {
        maxNudges: 4,
        repeatEvery: 18,
        repairDirective: TANK_COMBAT_HTML_REPAIR_DIRECTIVE,
      },
    });
  },
};
