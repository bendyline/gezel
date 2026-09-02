import { describe, expect, it } from 'vitest';
import { isSuccessfulAsyncHandoff } from './provider.js';

describe('isSuccessfulAsyncHandoff', () => {
  it('terminates after a successful role-typed delegate file handoff', () => {
    expect(isSuccessfulAsyncHandoff('delegate_builder', 'Hieu is on it.')).toBe(true);
  });

  it('terminates after an ordinary non-file message so the parked recipient can dispatch', () => {
    expect(isSuccessfulAsyncHandoff('message_gezel', 'Accepted for Anita.')).toBe(true);
  });

  it('does not terminate for consultations or failed calls', () => {
    expect(isSuccessfulAsyncHandoff('ask_gezel', 'Anita answered inline.')).toBe(false);
    expect(isSuccessfulAsyncHandoff('consult_builder', 'Answer follows.')).toBe(false);
    expect(isSuccessfulAsyncHandoff('delegate_builder', 'ERROR: no recipient')).toBe(false);
  });

  it('does not mistake similarly named non-handoff tools for async delegation', () => {
    expect(isSuccessfulAsyncHandoff('consult_developer', 'Answer follows.')).toBe(false);
    expect(isSuccessfulAsyncHandoff('message_user', 'Sent.')).toBe(false);
  });
});
