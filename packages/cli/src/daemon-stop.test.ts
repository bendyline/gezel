import { describe, expect, it } from 'vitest';
import { isGezeldCommand, planDaemonStop } from './daemon-stop.js';

const GEZELD =
  '"C:\\Program Files\\Gezel\\gezel.exe" C:\\Users\\a\\.gezel\\service\\dist\\bin\\gezeld.js';

function plan(input: {
  pid?: number | null;
  alive?: boolean;
  health?: { pid?: number; hostedBy?: 'app' | 'standalone' } | null;
  command?: string | null;
}) {
  return planDaemonStop({
    pid: input.pid === undefined ? 4242 : input.pid,
    alive: () => input.alive ?? true,
    health: input.health ?? null,
    commandOf: async () => (input.command === undefined ? GEZELD : input.command),
  });
}

describe('planDaemonStop', () => {
  it('reports nothing running, and clears what a dead daemon left', async () => {
    expect(await plan({ pid: null })).toEqual({ kind: 'not-running' });
    expect(await plan({ alive: false })).toEqual({ kind: 'stale' });
  });

  it('kills a standalone daemon that vouches for its own pid', async () => {
    expect(
      await plan({ health: { pid: 4242, hostedBy: 'standalone' }, command: 'unread' }),
    ).toEqual({ kind: 'kill' });
  });

  // 1.26299.99: against the app's daemon, or an embedded service whose pid
  // is Electron's, `gezel stop` killed the app's process.
  it('brakes, never kills, a daemon the app owns', async () => {
    expect(await plan({ health: { pid: 4242, hostedBy: 'app' } })).toEqual({ kind: 'brake' });
    expect(
      await plan({ health: {}, command: '"C:\\Program Files\\Gezel\\gezel.exe" --type=browser' }),
    ).toEqual({ kind: 'brake' });
  });

  it('kills an older or hung daemon only when its command line is gezeld', async () => {
    expect(await plan({ health: {} })).toEqual({ kind: 'kill' });
    expect(await plan({ health: null })).toEqual({ kind: 'kill' });
  });

  it('leaves a reused pid alone', async () => {
    expect(await plan({ health: null, command: 'C:\\Windows\\explorer.exe' })).toEqual({
      kind: 'foreign',
      command: 'C:\\Windows\\explorer.exe',
    });
  });

  it('refuses when it cannot confirm, or when the service names another pid', async () => {
    expect(await plan({ health: null, command: null })).toEqual({ kind: 'unconfirmed' });
    expect(await plan({ health: { pid: 99, hostedBy: 'standalone' } })).toEqual({
      kind: 'mismatch',
      healthPid: 99,
    });
  });
});

describe('isGezeldCommand', () => {
  it.each([
    GEZELD,
    'node /usr/lib/node_modules/@bendyline/gezel-service/dist/bin/gezeld.js --port 8080',
    '/usr/local/bin/gezeld',
    '"C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@bendyline\\gezel-service\\dist\\bin\\gezeld.js"',
  ])('recognizes %s', (command) => {
    expect(isGezeldCommand(command)).toBe(true);
  });

  it.each([
    'C:\\Windows\\explorer.exe',
    '"C:\\Program Files\\Gezel\\gezel.exe"',
    'node /home/a/gezeld-notes/build.js',
    'vim gezeld.md',
  ])('rejects %s', (command) => {
    expect(isGezeldCommand(command)).toBe(false);
  });
});
