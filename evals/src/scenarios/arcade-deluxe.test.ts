import { describe, expect, it } from 'vitest';
import { arcadeDeluxeScenario } from './arcade-deluxe.ts';
import { getScenario, listScenarios } from './index.ts';

/**
 * The runtime assertions in `arcade-deluxe.ts` lean on a specific
 * observability contract (the screens + the `window` hooks). If the prompt
 * drifts away from that contract, the assertions silently can't pass and
 * the scenario stops measuring anything. This test pins the prompt to the
 * contract the assertions check.
 */
describe('arcade-deluxe scenario', () => {
  it('is registered in the scenario matrix', () => {
    expect(getScenario('arcade-deluxe')).toBe(arcadeDeluxeScenario);
    expect(listScenarios().map((s) => s.id)).toContain('arcade-deluxe');
  });

  it('prompt mandates the multi-screen structure the assertions gate on', () => {
    const p = arcadeDeluxeScenario.prompt.toLowerCase();
    expect(p).toContain('title');
    expect(p).toMatch(/game[- ]over/);
    expect(p).toContain('restart');
  });

  it('prompt mandates the window observability contract the assertions read', () => {
    const p = arcadeDeluxeScenario.prompt;
    expect(p).toContain('window.gameState');
    expect(p).toContain('window.startGame()');
    expect(p).toContain('window.endGame()');
    expect(p).toContain('window.restartGame()');
  });

  it('writes to workspace/index.html and gives iteration room', () => {
    expect(arcadeDeluxeScenario.prompt).toContain('workspace/index.html');
    // Generous wall-clock backstop (the no-progress watchdog is the real
    // terminator); at least as much runway as the other game scenarios.
    expect(arcadeDeluxeScenario.timeoutMs ?? 0).toBeGreaterThanOrEqual(120 * 60_000);
  });
});
