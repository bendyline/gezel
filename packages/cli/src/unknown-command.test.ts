import { describe, expect, it } from 'vitest';
import { closestCommand, unknownCommandMessage } from './unknown-command.js';

const COMMANDS = ['status', 'start', 'stop', 'run', 'agent', 'env', 'project', 'doctor', 'secret'];

describe('closestCommand', () => {
  it('suggests the command for a transposition typo', () => {
    expect(closestCommand('stauts', COMMANDS)).toBe('status');
  });

  it('suggests the command for a missing letter', () => {
    expect(closestCommand('doctr', COMMANDS)).toBe('doctor');
  });

  it('offers nothing for an unrelated word', () => {
    expect(closestCommand('banana', COMMANDS)).toBeUndefined();
  });
});

describe('unknownCommandMessage', () => {
  it('names the unknown command and the likely intended one', () => {
    const message = unknownCommandMessage(['stauts'], COMMANDS);
    expect(message).toContain("unknown command 'stauts'");
    expect(message).toContain('(Did you mean status?)');
    expect(message).not.toContain('too many arguments');
  });

  it('points a prompt typed without `run` at `gezel run`', () => {
    const message = unknownCommandMessage(['summarize', 'my', 'notes'], COMMANDS);
    expect(message).toContain('gezel run "<prompt>"');
    expect(message).not.toContain('Did you mean');
  });
});
