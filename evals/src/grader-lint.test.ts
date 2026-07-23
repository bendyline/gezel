import { describe, expect, it } from 'vitest';
import { SCENARIOS } from './scenarios/index.ts';
import {
  ARCADE_SUBJECT_VOCAB,
  TANK_SUBJECT_VOCAB,
  tankCombatContentSniff,
} from './success-check.ts';

/**
 * Grader lint: every signal a scenario's grader hard-REQUIRES must be
 * satisfiable from the scenario's own prompt text. A model that does
 * exactly what the prompt asks must be able to fire every required
 * signal — otherwise the gate is unwinnable and the scenario silently
 * measures grader-prompt drift instead of model capability.
 *
 * Wild-caught: arcade-deluxe reused `tankCombatContentSniff`
 * verbatim, making `tank-vocab` REQUIRED for a prompt that never says
 * "tank". nemotron3-super-120b-q4 built a correct 10 KB non-tank arcade
 * game, plateaued at 8/9 signals, and burned 8 futile polish rewrites
 * until the retry-loop watchdog killed the trial.
 *
 * Scenarios declare their required-vocab gates via
 * `requiredPromptEvidence`; this test asserts each declared pattern
 * matches the prompt. The companion test below pins WHICH scenarios must
 * declare evidence, so deleting a declaration is loud instead of silent.
 */
describe('grader lint — required signals are satisfiable from the prompt', () => {
  const declaring = Object.values(SCENARIOS).filter(
    (s) => (s.requiredPromptEvidence?.length ?? 0) > 0,
  );

  it('at least the known vocab-gated scenarios declare evidence', () => {
    const ids = declaring.map((s) => s.id);
    expect(ids).toContain('tankcombat');
    expect(ids).toContain('arcade-deluxe');
    expect(ids).toContain('petshop');
  });

  for (const scenario of Object.values(SCENARIOS)) {
    for (const evidence of scenario.requiredPromptEvidence ?? []) {
      it(`${scenario.id}: required signal "${evidence.signal}" is satisfiable from user-shaped text`, () => {
        // Graders sniff lowercased content; lint the same way. For
        // seeded scenarios the meester prompt is a benign note — the
        // kickoff message + missionObjectives (exported via
        // `evidenceTexts`) are the de-facto user ask, so they count too.
        // Reset lastIndex defensively in case a /g pattern sneaks in.
        evidence.pattern.lastIndex = 0;
        const userShapedText = [scenario.prompt, ...(scenario.evidenceTexts ?? [])]
          .join('\n')
          .toLowerCase();
        expect(
          evidence.pattern.test(userShapedText),
          `Scenario "${scenario.id}" hard-requires signal "${evidence.signal}" (${evidence.pattern}) but neither its prompt nor its evidenceTexts (kickoff/mission) satisfy it — a model doing exactly what was asked could not pass. Fix the user-shaped text or the grader.`,
        ).toBe(true);
      });
    }
  }
});

describe('grader lint — arcade-deluxe regression', () => {
  // A minimal arcade game shaped exactly like what the arcade-deluxe
  // prompt asks for: title/playing/gameover screens, score, player,
  // keyboard input, canvas, loop — and NOT ONE mention of tanks.
  const NON_TANK_ARCADE_HTML = `<!doctype html><html><head><style>body{margin:0}</style></head>
<body><canvas id="c" width="640" height="480"></canvas><script>
const state = { screen: 'title', score: 0, player: { x: 320, y: 400 }, enemies: [], shots: [] };
window.gameState = state;
window.startGame = () => { state.screen = 'playing'; };
window.endGame = () => { state.screen = 'gameover'; };
window.restartGame = () => { state.screen = 'title'; state.score = 0; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') state.player.x -= 8;
  if (e.key === 'ArrowRight') state.player.x += 8;
  if (e.key === ' ') state.shots.push({ x: state.player.x, y: state.player.y });
});
function update() {
  for (const s of state.shots) s.y -= 4;
  for (const en of state.enemies) {
    for (const s of state.shots) {
      const hit = Math.abs(en.x - s.x) < 10 && Math.abs(en.y - s.y) < 10;
      if (hit) { state.score += 10; en.dead = true; }
    }
  }
  state.enemies = state.enemies.filter((en) => !en.dead);
}
function draw() { /* canvas drawing of the player ship, enemies, score HUD */ }
function loop() { update(); draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
${'// substantive game code padding to clear the JS size floor\n'.repeat(120)}
</script></body></html>`;

  it('a correct non-tank arcade game passes the arcade static sniff', () => {
    const result = tankCombatContentSniff(NON_TANK_ARCADE_HTML, {
      subjectVocab: ARCADE_SUBJECT_VOCAB,
    });
    expect(result.ok).toBe(true);
    expect(result.signals).toContain('arcade-vocab');
  });

  it('the same game still fails the TANK sniff (tankcombat keeps its subject gate)', () => {
    const result = tankCombatContentSniff(NON_TANK_ARCADE_HTML, {
      subjectVocab: TANK_SUBJECT_VOCAB,
    });
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('tank-vocab');
  });
});
