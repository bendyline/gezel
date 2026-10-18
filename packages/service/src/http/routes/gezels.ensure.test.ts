import { describe, expect, it } from 'vitest';
import { ensureBespokeMode } from './gezels.js';

const chat = (localTurns: string[]) => ({
  holdsLocalEngineTurn: (sessionId: string) => localTurns.includes(sessionId),
});

describe('ensureBespokeMode', () => {
  it('drafts deterministically inside a tool call whose turn holds a local engine', () => {
    const auth = { appId: 'session:s1', scopes: ['session'] };
    expect(ensureBespokeMode(auth, chat(['s1']))).toBe('static');
  });

  it('keeps the authored one-shot when the calling turn is not on a local engine', () => {
    const auth = { appId: 'session:s1', scopes: ['session'] };
    expect(ensureBespokeMode(auth, chat([]))).toBe('generated');
  });

  it('keeps the authored one-shot for the app and other non-session callers', () => {
    expect(ensureBespokeMode({ appId: 'gezel-app', scopes: ['admin'] }, chat(['s1']))).toBe(
      'generated',
    );
    expect(ensureBespokeMode(undefined, chat(['s1']))).toBe('generated');
  });
});
