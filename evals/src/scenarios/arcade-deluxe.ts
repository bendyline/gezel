import { ARCADE_SUBJECT_VOCAB, tankCombatContentSniff } from '../success-check.ts';
import type { EvalScenario } from '../types.ts';
import { type RuntimeAssertion, pollHtmlSniff } from './helpers.ts';

/**
 * `arcade-deluxe` — the deliberately-HARD, multi-phase scenario.
 *
 * The legacy game scenarios (tictactoe, tankcombat) are one-shottable:
 * a capable model emits a single working canvas in one `writeFile`, and
 * the suite saturates at 100%. This scenario instead demands a *polished,
 * multi-screen* game — a title screen, gameplay, AND a game-over screen
 * with a restart — and gates on the full title → play → game-over →
 * restart cycle working. A freeform one-shot routinely ships the gameplay
 * but skips the title/game-over/restart screens or the observability
 * hooks, so it fails 1-3 of the runtime gates. That gap is the headroom:
 * a build-loop-steered run iterates (the evaluate gate catches the missing
 * screens) and is far likelier to clear every gate.
 *
 * It is therefore the A/B probe for the craftbook stack. Run it two ways:
 *   - steered (default): the meester suggests a gallery book; the voorman
 *     invokes it; the evaluate gate loops until every screen works.
 *   - baseline: GEZEL_DISABLE_CRAFTBOOK_HINT=1 suppresses the meester's
 *     shortlist (see suggestedCraftbookHint), so the team works freeform.
 * The success-rate delta across model tiers is the measurement. See
 * `docs/craftbook-ab-eval.md` for the run procedure.
 *
 * Observability contract (the prompt mandates it; the assertions lean on
 * it, with DOM fallbacks): `window.gameState` exposes `{ screen, score }`
 * and the game exposes `window.startGame()`, `window.endGame()`,
 * `window.restartGame()`. Driving game-over from outside a canvas is
 * otherwise impossible — so the hooks are part of the bar, exactly as
 * tankcombat already requires `window.gameState`.
 */

const TITLE = /title|menu|start|home|intro/;
const PLAYING = /play|game|run|active|level/;
const GAMEOVER = /over|end|dead|lose|loss|won|win|result|score/;

// Read the current screen via several strategies: window.gameState
// (object), a top-level lexical `gameState` binding (classic scripts),
// or a `data-screen` / `data-scene` attribute on <body>.
const READ_SCREEN = `(() => {
  const w = window;
  const pick = (g) => g && typeof g === 'object' ? (g.screen ?? g.phase ?? g.mode ?? g.scene ?? g.state) : undefined;
  let v = pick(w.gameState) ?? pick(w.game) ?? pick(w.state);
  if (typeof v === 'string') return v.toLowerCase();
  try {
    const lex = w.eval('(()=>{try{const g=eval("gameState");return g&&(g.screen||g.phase||g.mode||g.scene)}catch(e){return undefined}})()');
    if (typeof lex === 'string') return lex.toLowerCase();
  } catch (e) {}
  const ds = (document.body && document.body.dataset) ? (document.body.dataset.screen ?? document.body.dataset.scene) : undefined;
  if (typeof ds === 'string') return ds.toLowerCase();
  return null;
})()`;

const READ_SCORE = `(() => {
  const w = window;
  const g = w.gameState ?? w.game ?? w.state;
  if (g && typeof g === 'object' && typeof g.score === 'number') return g.score;
  const el = Array.from(document.querySelectorAll('*')).find((e) => /score|points|final/i.test(e.textContent || '') && /\\d/.test(e.textContent || ''));
  return el ? 'dom' : null;
})()`;

// Call window.<name>() if it's a function; else click a visible control
// whose text matches `clickRe`. Returns true if either fired.
function invoke(fnName: string, clickRe: string): string {
  return `(async () => {
    const w = window;
    if (typeof w['${fnName}'] === 'function') { try { w['${fnName}'](); return true; } catch (e) { return false; } }
    const re = ${clickRe};
    const ctrl = Array.from(document.querySelectorAll('button, [role=button], a, .btn, #start, #restart, #play')).find((el) => re.test((el.textContent || '') + ' ' + (el.id || '')));
    if (ctrl) { ctrl.click(); return true; }
    return false;
  })()`;
}

function arcadeDeluxeAssertions(): RuntimeAssertion[] {
  return [
    {
      name: 'observability-hooks-present',
      test: async (page) => {
        await page.waitForTimeout(700);
        const ok = await page.evaluate(`(() => {
          const w = window;
          const hasState = (w.gameState && typeof w.gameState === 'object') || ${READ_SCREEN} !== null;
          return hasState;
        })()`);
        return ok
          ? { ok: true }
          : {
              ok: false,
              why: 'no window.gameState / data-screen / lexical gameState — the game exposes no screen state to observe',
            };
      },
    },
    {
      name: 'title-screen-at-load',
      test: async (page) => {
        const screen = (await page.evaluate(READ_SCREEN)) as string | null;
        if (screen && TITLE.test(screen)) return { ok: true };
        // Fallback: a visible start/play affordance counts as a title screen.
        const hasStart = await page.evaluate(
          `Array.from(document.querySelectorAll('button,[role=button],a,#start,#play')).some((el)=>/start|play|begin/i.test((el.textContent||'')+' '+(el.id||'')))`,
        );
        return hasStart
          ? { ok: true }
          : {
              ok: false,
              why: `at load, screen="${screen}" is not a title/menu and no start control is visible`,
            };
      },
    },
    {
      name: 'start-enters-play',
      test: async (page) => {
        const fired = await page.evaluate(invoke('startGame', '/start|play|begin/i'));
        if (!fired)
          return {
            ok: false,
            why: 'could not start: no window.startGame() and no Start control to click',
          };
        await page.waitForTimeout(500);
        const screen = (await page.evaluate(READ_SCREEN)) as string | null;
        return screen && PLAYING.test(screen) && !TITLE.test(screen)
          ? { ok: true }
          : {
              ok: false,
              why: `after start, screen="${screen}" did not transition to a playing state`,
            };
      },
    },
    {
      name: 'input-mutates-state',
      test: async (page) => {
        const before = await page.evaluate(READ_SCORE);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(120);
        await page.keyboard.press(' ');
        await page.waitForTimeout(400);
        const moved = await page.evaluate(`(() => {
          const w = window;
          const gs = w.gameState ?? w.game ?? w.state;
          return gs && typeof gs === 'object' ? JSON.stringify(gs).length : 0;
        })()`);
        // Either the score changed or the state object is non-trivial and
        // the input handlers exist — accept presence of game-state as the
        // weak signal (canvas pixels don't show in the DOM).
        const after = await page.evaluate(READ_SCORE);
        if (after !== before) return { ok: true };
        return (moved as number) > 2
          ? { ok: true }
          : { ok: false, why: 'pressing ArrowRight + Space produced no observable state change' };
      },
    },
    {
      name: 'gameover-screen-with-score',
      test: async (page) => {
        const fired = await page.evaluate(invoke('endGame', '/game ?over|end|quit|die/i'));
        if (!fired)
          return {
            ok: false,
            why: 'could not reach game-over: expose window.endGame() so the end state is observable',
          };
        await page.waitForTimeout(500);
        const screen = (await page.evaluate(READ_SCREEN)) as string | null;
        const score = await page.evaluate(READ_SCORE);
        if (!(screen && GAMEOVER.test(screen)))
          return { ok: false, why: `after endGame, screen="${screen}" is not a game-over state` };
        return score !== null
          ? { ok: true }
          : {
              ok: false,
              why: 'game-over screen shows no score (no gameState.score and no score text in the DOM)',
            };
      },
    },
    {
      name: 'restart-returns-to-game',
      test: async (page) => {
        const fired = await page.evaluate(
          invoke('restartGame', '/restart|again|retry|replay|new game/i'),
        );
        if (!fired)
          return {
            ok: false,
            why: 'could not restart: no window.restartGame() and no Restart control',
          };
        await page.waitForTimeout(500);
        const screen = (await page.evaluate(READ_SCREEN)) as string | null;
        return screen && (PLAYING.test(screen) || TITLE.test(screen)) && !GAMEOVER.test(screen)
          ? { ok: true }
          : { ok: false, why: `after restart, screen="${screen}" did not return to title/playing` };
      },
    },
  ];
}

export const arcadeDeluxeScenario: EvalScenario = {
  id: 'arcade-deluxe',
  description:
    'HARD multi-phase probe: Meester → voorman → team ship a POLISHED multi-screen arcade game (title → gameplay → game-over → restart) in one HTML file, gated on the full cycle working. The A/B probe for the craftbook stack (steered vs GEZEL_DISABLE_CRAFTBOOK_HINT=1 baseline).',
  prompt:
    'Create a new project for this work (e.g. `Arcade Deluxe`) and build a POLISHED, multi-screen arcade ' +
    'game there as a single self-contained file at `workspace/index.html` (HTML + inline `<style>` + inline ' +
    '`<script>`, no external assets, no build step). This is not a one-screen toy — it must have all of: ' +
    '(1) a TITLE screen with a Start control; (2) GAMEPLAY with a player the user controls (arrow keys/WASD), ' +
    'at least one enemy or obstacle, a fire/action on space, and a visible score; (3) a GAME-OVER screen ' +
    'showing the final score with a Restart control; and it must survive a full play → game-over → restart ' +
    'cycle without throwing. ' +
    'For automated checks, expose this observability contract on `window`: keep `window.gameState = { screen, score, ... }` ' +
    "updated live where `screen` is one of `'title'`, `'playing'`, `'gameover'`; and expose the functions " +
    '`window.startGame()` (title → playing), `window.endGame()` (→ game-over), and `window.restartGame()` (→ title or playing). ' +
    'The first concrete deliverable is the index.html file inside the new project — write it now, then refine until the ' +
    'whole title → play → game-over → restart cycle works.',
  // Harder + multi-screen + expects iteration, so at least as much runway
  // as tankcombat. Generous wall-clock backstop only: the no-progress
  // watchdog (45 min) and the count-based retry-loop are the real
  // terminators; this ceiling just stops a wedged trial eventually. The
  // eval is throughput-invariant — never fail a still-progressing trial
  // for running long at low decode speed.
  timeoutMs: 150 * 60_000,
  requiredPromptEvidence: [
    { signal: ARCADE_SUBJECT_VOCAB.signal, pattern: ARCADE_SUBJECT_VOCAB.pattern },
  ],
  successCheck: async (ctx) => {
    const minInlineJsBytes = ctx.evalHints?.sniffThresholds?.inlineJsMinBytes;
    const minHtmlBytes = ctx.evalHints?.sniffThresholds?.htmlMinBytes;
    return pollHtmlSniff({
      ctx,
      // Static layer: it must at least be a real canvas/SVG game with
      // substantive JS — the tank-combat sniff mechanics with an ARCADE
      // subject gate, NOT the tank one: this prompt never says "tank",
      // so requiring tank-vocab made the grader unwinnable (wild-caught
      // nemotron-super stuck at 8/9 through 8 polish rewrites).
      // The headroom lives in the multi-screen runtime assertions below.
      sniff: (html) =>
        tankCombatContentSniff(html, {
          subjectVocab: ARCADE_SUBJECT_VOCAB,
          ...(minInlineJsBytes ? { minInlineJsBytes } : {}),
          ...(minHtmlBytes ? { minHtmlBytes } : {}),
        }),
      getExtraContext: async () => undefined,
      runtimeAssertions: () => arcadeDeluxeAssertions(),
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: { maxNudges: 1 },
    });
  },
};
