import type { SignInState } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type GateInputs, decideGate, isSignedOutResponse } from './gate.js';

const required: SignInState = {
  accountsRequired: true,
  setupRequired: false,
  setupCodeAvailable: false,
};

function inputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    injectedToken: undefined,
    setupParam: null,
    storedToken: null,
    fetchState: async () => required,
    checkSession: async () => true,
    ...overrides,
  };
}

describe('decideGate', () => {
  it('opens at once for a host that injected its own credential', async () => {
    let asked = false;
    const view = await decideGate(
      inputs({
        injectedToken: 'desktop',
        fetchState: async () => {
          asked = true;
          return required;
        },
      }),
    );
    expect(view).toEqual({ kind: 'open' });
    expect(asked).toBe(false);
  });

  it('opens when the daemon does not require accounts, or is too old to say', async () => {
    expect(
      await decideGate(
        inputs({ fetchState: async () => ({ ...required, accountsRequired: false }) }),
      ),
    ).toEqual({ kind: 'open' });
    expect(await decideGate(inputs({ fetchState: async () => null }))).toEqual({ kind: 'open' });
  });

  it('shows setup, with the code from the link, while no account exists', async () => {
    const view = await decideGate(
      inputs({
        setupParam: 'ABCDE-FGHJK',
        fetchState: async () => ({ ...required, setupRequired: true, setupCodeAvailable: true }),
      }),
    );
    expect(view).toEqual({ kind: 'setup', code: 'ABCDE-FGHJK', codeAvailable: true });
  });

  it('asks for a sign-in without a session, and says so when one ended', async () => {
    expect(await decideGate(inputs())).toEqual({ kind: 'sign-in' });
    // A leftover `gezel start --web` token is not a session.
    expect(await decideGate(inputs({ storedToken: 'web-ui-token' }))).toEqual({ kind: 'sign-in' });
    expect(
      await decideGate(inputs({ storedToken: 'gzs_abc', checkSession: async () => false })),
    ).toEqual({ kind: 'sign-in', notice: 'You were signed out. Sign in again.' });
  });

  it('opens with a session the daemon still accepts', async () => {
    expect(await decideGate(inputs({ storedToken: 'gzs_abc' }))).toEqual({ kind: 'open' });
  });
});

describe('isSignedOutResponse', () => {
  it('reads a 401 on the product API as a session that ended', () => {
    expect(isSignedOutResponse(401, 'http://localhost:6228/api/projects', 'gzs_abc')).toBe(true);
    expect(isSignedOutResponse(401, '/events/chat/all', 'gzs_abc')).toBe(true);
  });

  it('ignores other statuses, other credentials, and the sign-in routes themselves', () => {
    expect(isSignedOutResponse(403, '/api/projects', 'gzs_abc')).toBe(false);
    expect(isSignedOutResponse(401, '/api/projects', 'desktop-token')).toBe(false);
    expect(isSignedOutResponse(401, '/v1/apps/signin', 'gzs_abc')).toBe(false);
  });
});
