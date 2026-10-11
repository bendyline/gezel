import { describe, expect, it } from 'vitest';
import { engineSwapWaitLabel, turnWaitsForEngineSwap } from './engine-swap-wait.js';

describe('turnWaitsForEngineSwap', () => {
  it('waits for a message from a person, a handoff, or a task step', () => {
    expect(turnWaitsForEngineSwap(undefined, false)).toBe(true);
    expect(turnWaitsForEngineSwap({}, false)).toBe(true);
  });

  it('keeps the bounded drain for a consultation the asker is blocked on', () => {
    expect(turnWaitsForEngineSwap(undefined, true)).toBe(false);
  });

  it('keeps the bounded drain for ambient chores', () => {
    expect(turnWaitsForEngineSwap({ ambient: true }, false)).toBe(false);
  });
});

describe('engineSwapWaitLabel', () => {
  it('names who is using the other model', () => {
    expect(engineSwapWaitLabel(['Vendula'])).toBe(
      'Waiting for Vendula to finish before switching models',
    );
    expect(engineSwapWaitLabel(['Vendula', 'Alejandro', 'Imara'])).toBe(
      'Waiting for Vendula, Alejandro and Imara to finish before switching models',
    );
  });

  it('falls back to plain wording when nobody can be named', () => {
    expect(engineSwapWaitLabel([])).toBe(
      'Waiting for the current work to finish before switching models',
    );
  });
});
