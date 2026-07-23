import { describe, expect, it } from 'vitest';
import { commandResultIsError } from './command-result.js';

describe('commandResultIsError', () => {
  it('marks a failed command as an MCP error', () => {
    expect(commandResultIsError({ ok: false })).toBe(true);
  });

  it('marks a timed-out command as an MCP error', () => {
    expect(commandResultIsError({ ok: false })).toBe(true);
  });

  it('does not turn a pending approval into an execution error', () => {
    expect(commandResultIsError({ ok: false, approvalPending: true })).toBe(false);
  });

  it('does not mark a successful command as an error', () => {
    expect(commandResultIsError({ ok: true })).toBe(false);
  });
});
