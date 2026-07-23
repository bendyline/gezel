import { describe, expect, it } from 'vitest';
import {
  TANK_COMBAT_HTML_REPAIR_DIRECTIVE,
  TANK_INPUT_SIGNATURE_EXPRESSION,
  tankCombatScenario,
} from './tankcombat.ts';

describe('tankcombat prompt guidance', () => {
  it('tells local models to keep all JavaScript inside one inline script block', () => {
    expect(TANK_COMBAT_HTML_REPAIR_DIRECTIVE).toContain('one complete `index.html`');
    expect(TANK_COMBAT_HTML_REPAIR_DIRECTIVE).toContain('All JavaScript must be inside');
    expect(TANK_COMBAT_HTML_REPAIR_DIRECTIVE).toContain('requestAnimationFrame');
    expect(TANK_COMBAT_HTML_REPAIR_DIRECTIVE).toContain('after `</html>`');
    expect(tankCombatScenario.prompt).toContain(TANK_COMBAT_HTML_REPAIR_DIRECTIVE);
  });

  it('keeps tankcombat registered as the expected matrix scenario', () => {
    expect(tankCombatScenario.id).toBe('tankcombat');
    expect(tankCombatScenario.description).toContain('tank combat arcade game');
  });

  it('keeps the browser input probe self-contained when tsx preserves function names', () => {
    expect(TANK_INPUT_SIGNATURE_EXPRESSION).not.toContain('__name');

    const evaluate = new Function(
      'document',
      'window',
      `return ${TANK_INPUT_SIGNATURE_EXPRESSION}`,
    );
    const signature = evaluate(
      {
        querySelector: () => ({ width: 800, height: 600 }),
        body: { dataset: { inputTick: '3', unrelated: 'ignored' } },
      },
      {
        gameState: {
          player: { x: 42, y: 7, angle: 1.5 },
          keys: { ArrowRight: true },
        },
      },
    );

    expect(JSON.parse(signature)).toEqual({
      canvas: '800x600',
      bodyDataset: { inputTick: '3' },
      state: {
        keys: { ArrowRight: true },
      },
      player: {
        x: 42,
        y: 7,
        angle: 1.5,
      },
    });
  });
});
