import type { SignInState } from '@bendyline/gezel';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInGate } from './SignInGate.js';

type GezelGlobal = { __GEZEL__?: { token?: string } };
const host = window as unknown as GezelGlobal;
let injectedToken: string | undefined;

function serve(state: SignInState) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).endsWith('/v1/apps/signin/state')
        ? new Response(JSON.stringify(state), { status: 200 })
        : new Response('{}', { status: 404 }),
    ),
  );
}

beforeEach(() => {
  // A container serves the page with no credential of its own.
  injectedToken = host.__GEZEL__?.token;
  if (host.__GEZEL__) host.__GEZEL__.token = undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (host.__GEZEL__) host.__GEZEL__.token = injectedToken;
});

describe('sign-in commands', () => {
  // The screen is chrome, where selection is off; `code` opts back in.
  it('sets the setup-link command as code', async () => {
    serve({ accountsRequired: true, setupRequired: true, setupCodeAvailable: false });
    render(<SignInGate>app</SignInGate>);
    const command = await screen.findByText('docker exec <container> gezel account setup-link');
    expect(command.tagName).toBe('CODE');
  });

  it('sets the reset-password command as code', async () => {
    serve({ accountsRequired: true, setupRequired: false, setupCodeAvailable: false });
    render(<SignInGate>app</SignInGate>);
    const command = await screen.findByText(
      'docker exec <container> gezel account reset-password <name>',
    );
    expect(command.tagName).toBe('CODE');
  });
});
