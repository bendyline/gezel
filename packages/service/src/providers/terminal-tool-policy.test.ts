import { describe, expect, it } from 'vitest';
import { terminalToolClosingText } from './terminal-tool-policy.js';

const policy = {
  toolNames: ['make_move'],
  closingArg: 'moveThought',
  fallbackText: 'Move made — your turn.',
  maxClosingChars: 140,
};

describe('terminalToolClosingText', () => {
  it('uses the action call table talk as one compact line', () => {
    expect(
      terminalToolClosingText(
        policy,
        'make_move',
        { moveThought: 'That opens the center.\nYour turn.' },
        'run abc — status: ok',
      ),
    ).toBe('That opens the center. Your turn.');
  });

  it('does not terminate a failed action', () => {
    expect(
      terminalToolClosingText(
        policy,
        'make_move',
        { moveThought: 'Done.' },
        'ERROR: Illegal move. Legal moves: b6-c5',
      ),
    ).toBeNull();
  });
});
