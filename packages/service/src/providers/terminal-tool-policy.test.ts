import { describe, expect, it } from 'vitest';
import { terminalToolClosingText } from './terminal-tool-policy.js';

const policy = {
  toolNames: ['make_move'],
  closingArg: 'moveThought',
  fallbackText: 'Move made — your turn.',
  maxClosingChars: 140,
};

describe('terminalToolClosingText', () => {
  it('always terminates a successful task-step handoff', () => {
    expect(
      terminalToolClosingText(
        undefined,
        'advance_task_step',
        { ref: 'default/10', stepId: 'research' },
        'Completed step "research" on default/10.\nActive step is now "Lock the slide outline".',
      ),
    ).toBe('Completed step "research" on default/10. Active step is now "Lock the slide outline".');
  });

  it('keeps a rejected task-step handoff in the repair loop', () => {
    expect(
      terminalToolClosingText(
        undefined,
        'advance_task_step',
        { ref: 'default/10', stepId: 'research' },
        'ERROR: [gate_rejected] citations do not resolve',
      ),
    ).toBeNull();
  });

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

describe('terminalToolClosingText — checkpoint-bound terminal writes', () => {
  const policy = {
    toolNames: ['write_artifact'],
    fallbackText: 'Checkpoint written for validation.',
    maxClosingChars: 120,
    onlyWhenArgEquals: { arg: 'path', value: 'tasks/1/billables.json' },
  };

  it('lets a write to another deliverable continue the turn', () => {
    expect(
      terminalToolClosingText(
        policy,
        'write_artifact',
        { path: 'tasks/1/scope.md' },
        'Wrote tasks/1/scope.md',
      ),
    ).toBeNull();
  });

  it('ends the turn on the checkpoint file, however the path is spelled', () => {
    expect(
      terminalToolClosingText(
        policy,
        'write_artifact',
        { path: './tasks/1/billables.json' },
        'Wrote tasks/1/billables.json',
      ),
    ).toBe('Checkpoint written for validation.');
  });
});
