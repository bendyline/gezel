import { describe, expect, it } from 'vitest';
import { applyAutostartRuntimeArguments, isAutostartLaunch } from './runtime-args.js';

describe('isAutostartLaunch', () => {
  it('recognizes the LaunchAgent / systemd marker and the Windows task argument', () => {
    expect(isAutostartLaunch([], { GEZEL_AUTOSTART: '1' })).toBe(true);
    expect(isAutostartLaunch(['--gezel-autostart-home=C:\\Users\\Test\\.gezel'], {})).toBe(true);
  });

  it('treats an ordinary launch as not autostarted', () => {
    expect(isAutostartLaunch([], {})).toBe(false);
    expect(isAutostartLaunch([], { GEZEL_AUTOSTART: '0' })).toBe(false);
  });
});

describe('applyAutostartRuntimeArguments', () => {
  it('restores the pinned home supplied by Windows Task Scheduler', () => {
    const env: NodeJS.ProcessEnv = {};
    applyAutostartRuntimeArguments(['--gezel-autostart-home=C:\\Users\\Test User\\.gezel'], env);
    expect(env.GEZEL_HOME).toBe('C:\\Users\\Test User\\.gezel');
  });

  it('leaves ordinary foreground launches unchanged', () => {
    const env: NodeJS.ProcessEnv = { GEZEL_HOME: '/existing' };
    applyAutostartRuntimeArguments([], env);
    expect(env.GEZEL_HOME).toBe('/existing');
  });

  it('rejects missing and duplicate home values', () => {
    expect(() => applyAutostartRuntimeArguments(['--gezel-autostart-home='], {})).toThrow(
      /invalid/i,
    );
    expect(() =>
      applyAutostartRuntimeArguments(
        ['--gezel-autostart-home=C:\\one', '--gezel-autostart-home=C:\\two'],
        {},
      ),
    ).toThrow(/duplicate/i);
  });
});
